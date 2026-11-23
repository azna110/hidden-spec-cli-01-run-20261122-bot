// mend: the CLI SPEC.md specifies. Node 22, the standard library alone; run as `node main.ts [options] [PATCH]`.
//
// Reads a patch in one of four formats (unified diff, SEARCH/REPLACE blocks, V4A, JSON edits), finds the
// lines each edit names at the first of three matching tiers, and writes every change or none, printing
// what it changed or why it failed. In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL
// set, and this file hands over to runner.ts (the last lines below): keep that hand-over and runner.ts
// as they are.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';
const trimEndWs = (s: string): string => s.replace(/[ \t]+$/, '');
const trimWs = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** A file's lines, its line break and whether it ends with one (SPEC.md section 3). */
interface FileState {
  br: string;
  lines: string[];
  final: boolean;
}

function parseFile(text: string): FileState {
  if (text === '') return { br: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { br, lines: parts, final };
}

function renderFile(f: FileState): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

interface Move {
  old: string;
  new: string;
}

type Edit = (tree: Tree) => Move | null;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// ---------------------------------------------------------------- matching (section 5)

function tiers(strict: boolean): number[] {
  return strict ? [0] : [0, 1, 2];
}

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimEndWs(a) === trimEndWs(b);
  return trimWs(a) === trimWs(b);
}

/** Every 0-based position at or after `from` where `pat` occurs at `tier`. */
function occurrences(lines: string[], pat: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  for (let i = from; i + pat.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < pat.length; j++) {
      if (!lineEq(lines[i + j]!, pat[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** One line of N: `ctx` is its index in O when it is a context line, else -1. */
interface NLine {
  text: string;
  ctx: number;
}

interface Chunk {
  old: string[];
  nlines: NLine[];
}

/**
 * The lines N becomes at file position `at`: context lines are the file's own matched lines, and at
 * tier 2 every other line is re-indented from O's first line's leading whitespace to the file's.
 */
function mapNew(fs: FileState, at: number, chunk: Chunk, tier: number): string[] {
  const out: string[] = [];
  const p = chunk.old.length > 0 ? leadWs(chunk.old[0]!) : '';
  const f = chunk.old.length > 0 ? leadWs(fs.lines[at]!) : '';
  for (const nl of chunk.nlines) {
    if (nl.ctx >= 0) out.push(fs.lines[at + nl.ctx]!);
    else if (tier === 2 && nl.text !== '' && nl.text.trim() !== '' && nl.text.startsWith(p)) out.push(f + nl.text.slice(p.length));
    else out.push(nl.text);
  }
  return out;
}

// ---------------------------------------------------------------- JSON edits (section 9)

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
      return null;
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
      return null;
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
      return null;
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---------------------------------------------------------------- unified diffs (section 6)

interface HunkBodyLine {
  kind: ' ' | '-' | '+' | '\\';
  text: string;
}

interface Hunk extends Chunk {
  a: number;
  /** True when a `\` line follows the hunk's last context or `+` line. */
  noFinalBreak: boolean;
  /** Whether a `\` line follows the hunk's last `+` line; null when the hunk has no `+` line. */
  plusNoBreak: boolean | null;
}

interface Section {
  oldPath: string | null;
  newPath: string | null;
  renameFrom: string | undefined;
  renameTo: string | undefined;
  newFile: boolean;
  deletedFile: boolean;
  hasPair: boolean;
  hunks: Hunk[];
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let inHeader = false;
  let i = 0;
  const fresh = (): Section => ({ oldPath: null, newPath: null, renameFrom: undefined, renameTo: undefined, newFile: false, deletedFile: false, hasPair: false, hunks: [] });
  const diffGit = (line: string): [string, string] | null => {
    const m = /^diff --git a\/(\S+) b\/(\S+)[ \t]*$/.exec(line);
    return m === null ? null : [m[1]!, m[2]!];
  };
  const headerPath = (line: string): string | null => {
    let raw = line.slice(4);
    const tab = raw.indexOf('\t');
    if (tab >= 0) raw = raw.slice(0, tab);
    raw = raw.trim();
    if (raw.startsWith('a/') || raw.startsWith('b/')) raw = raw.slice(2);
    if (raw === '/dev/null') return null;
    return raw;
  };
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const dg = diffGit(line);
      if (dg === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = fresh();
      cur.oldPath = dg[0];
      cur.newPath = dg[1];
      sections.push(cur);
      inHeader = true;
      i++;
    } else if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const o = headerPath(line);
      const n = headerPath(lines[i + 1]!);
      if (cur !== null && inHeader && !cur.hasPair) {
        cur.oldPath = o;
        cur.newPath = n;
        cur.hasPair = true;
      } else {
        cur = fresh();
        cur.oldPath = o;
        cur.newPath = n;
        cur.hasPair = true;
        sections.push(cur);
        inHeader = true;
      }
      i += 2;
    } else if (line.startsWith('--- ')) {
      if (cur !== null && inHeader) throw new Exit2(`error: parse ${i + 2}`);
      i++;
    } else if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const hm = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?:$|[ \t])/.exec(line);
      if (hm === null) throw new Exit2(`error: parse ${i + 1}`);
      const a = parseInt(hm[1]!, 10);
      const body: HunkBodyLine[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const bl = lines[j]!;
        if (bl.startsWith('diff --git ')) break;
        if (bl.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
        if (bl === '' || bl.startsWith(' ') || bl.startsWith('-') || bl.startsWith('+') || bl.startsWith('\\')) {
          if (bl === '') body.push({ kind: ' ', text: '' });
          else body.push({ kind: bl[0] as ' ' | '-' | '+' | '\\', text: bl.slice(1) });
          j++;
        } else break;
      }
      while (body.length > 0 && body[body.length - 1]!.kind === ' ' && body[body.length - 1]!.text === '') body.pop();
      const old: string[] = [];
      const nlines: NLine[] = [];
      for (const b of body) {
        if (b.kind === ' ') {
          const idx = old.length;
          old.push(b.text);
          nlines.push({ text: b.text, ctx: idx });
        } else if (b.kind === '-') old.push(b.text);
        else if (b.kind === '+') nlines.push({ text: b.text, ctx: -1 });
      }
      let noFinalBreak = false;
      for (let k = body.length - 1; k >= 0; k--) {
        if (body[k]!.kind === ' ' || body[k]!.kind === '+') {
          noFinalBreak = body[k + 1] !== undefined && body[k + 1]!.kind === '\\';
          break;
        }
      }
      let plusNoBreak: boolean | null = null;
      for (let k = body.length - 1; k >= 0; k--) {
        if (body[k]!.kind === '+') {
          plusNoBreak = body[k + 1] !== undefined && body[k + 1]!.kind === '\\';
          break;
        }
      }
      cur.hunks.push({ a, old, nlines, noFinalBreak, plusNoBreak });
      inHeader = false;
      i = j;
    } else if (cur !== null && inHeader) {
      if (line.startsWith('rename from ')) cur.renameFrom = line.slice(12).trim();
      else if (line.startsWith('rename to ')) cur.renameTo = line.slice(10).trim();
      else if (line.startsWith('new file mode')) cur.newFile = true;
      else if (line.startsWith('deleted file mode')) cur.deletedFile = true;
      i++;
    } else {
      i++;
    }
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((sec) => unifiedEdit(sec, strict));
}

/** Apply one hunk to a file's lines; returns the new running offset `d` for the section. */
function applyHunk(fs: FileState, hunk: Hunk, d: number, path: string, strict: boolean): number {
  const o = hunk.old;
  if (o.length > 0) {
    let tierFound = -1;
    let occ: number[] = [];
    for (const t of tiers(strict)) {
      occ = occurrences(fs.lines, o, t, 0);
      if (occ.length > 0) {
        tierFound = t;
        break;
      }
    }
    if (tierFound < 0) throw new Fail('no-match', path);
    const target = hunk.a - 1 + d;
    let best = occ[0]!;
    for (const c of occ) {
      if (Math.abs(c - target) < Math.abs(best - target)) best = c;
    }
    const rep = mapNew(fs, best, hunk, tierFound);
    const touchesEnd = best + o.length === fs.lines.length;
    fs.lines.splice(best, o.length, ...rep);
    if (touchesEnd) fs.final = !hunk.noFinalBreak;
    return d + (hunk.nlines.length - o.length);
  }
  const idx = Math.min(Math.max(hunk.a + d, 0), fs.lines.length);
  const rep = hunk.nlines.map((nl) => nl.text);
  const touchesEnd = idx === fs.lines.length;
  fs.lines.splice(idx, 0, ...rep);
  if (touchesEnd) fs.final = !hunk.noFinalBreak;
  return d + hunk.nlines.length;
}

function unifiedEdit(sec: Section, strict: boolean): Edit {
  return (tree) => {
    const oldP = sec.hasPair ? sec.oldPath : (sec.renameFrom ?? sec.oldPath);
    const newP = sec.hasPair ? sec.newPath : (sec.renameTo ?? sec.newPath);
    const isCreate = oldP === null || sec.newFile;
    const isDelete = !isCreate && (newP === null || sec.deletedFile);
    if (isCreate) {
      const p = newP ?? '';
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const plus: string[] = [];
      let finalBreak = true;
      for (const h of sec.hunks) {
        for (const nl of h.nlines) {
          if (nl.ctx < 0) plus.push(nl.text);
        }
        if (h.plusNoBreak !== null) finalBreak = !h.plusNoBreak;
      }
      tree.now.set(p, plus.length === 0 ? '' : plus.join('\n') + (finalBreak ? '\n' : ''));
      return null;
    }
    if (isDelete) {
      const p = oldP ?? '';
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return null;
    }
    if (oldP !== newP) {
      const o = oldP ?? '';
      const n = newP ?? '';
      if (!safe(o)) throw new Fail('unsafe', o);
      if (!safe(n)) throw new Fail('unsafe', n);
      const cur = tree.get(o);
      if (cur === null) throw new Fail('missing', o);
      if (tree.get(n) !== null) throw new Fail('exists', n);
      const fs = parseFile(cur);
      let d = 0;
      for (const h of sec.hunks) d = applyHunk(fs, h, d, o, strict);
      tree.now.set(o, null);
      tree.now.set(n, renderFile(fs));
      return { old: o, new: n };
    }
    const p = oldP ?? '';
    if (!safe(p)) throw new Fail('unsafe', p);
    const cur = tree.get(p);
    if (cur === null) throw new Fail('missing', p);
    const fs = parseFile(cur);
    let d = 0;
    for (const h of sec.hunks) d = applyHunk(fs, h, d, p, strict);
    tree.now.set(p, renderFile(fs));
    return null;
  };
}

// ---------------------------------------------------------------- SEARCH/REPLACE blocks (section 7)

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = 0;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchLine = i + 1;
    let j = i + 1;
    while (j < lines.length && lines[j]!.trimEnd() !== '=======') j++;
    if (j >= lines.length) throw new Exit2(`error: parse ${searchLine}`);
    let k = j + 1;
    while (k < lines.length && lines[k]!.trimEnd() !== '>>>>>>> REPLACE') k++;
    if (k >= lines.length) throw new Exit2(`error: parse ${searchLine}`);
    const oldLines = lines.slice(i + 1, j);
    const newLines = lines.slice(j + 1, k);
    let path: string | null = null;
    for (let m = i - 1; m >= prevEnd; m--) {
      const t = lines[m]!;
      if (blank(t)) continue;
      const tt = t.trim();
      if (tt.startsWith('```')) continue;
      path = tt;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchLine}`);
      path = prevPath;
    }
    prevPath = path;
    edits.push(srEdit(path, oldLines, newLines, strict));
    prevEnd = k + 1;
    i = k + 1;
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return null;
    }
    const cur = tree.get(path);
    if (cur === null) throw new Fail('missing', path);
    const fs = parseFile(cur);
    let tierFound = -1;
    let occ: number[] = [];
    for (const t of tiers(strict)) {
      occ = occurrences(fs.lines, oldLines, t, 0);
      if (occ.length > 0) {
        tierFound = t;
        break;
      }
    }
    if (tierFound < 0) throw new Fail('no-match', path);
    if (occ.length > 1) throw new Fail('ambiguous', path);
    const at = occ[0]!;
    const chunk: Chunk = { old: oldLines, nlines: newLines.map((text) => ({ text, ctx: -1 })) };
    const rep = mapNew(fs, at, chunk, tierFound);
    fs.lines.splice(at, oldLines.length, ...rep);
    tree.now.set(path, renderFile(fs));
    return null;
  };
}

// ---------------------------------------------------------------- V4A patches (section 8)

interface VChunk extends Chunk {
  anchor: string | null;
  eof: boolean;
}

interface VSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  moveTo: string | null;
  lineNo: number;
  addLines: string[];
  chunks: VChunk[];
}

function parseV4a(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last >= 0 && blank(lines[last]!)) last--;
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sections: VSection[] = [];
  let cur: VSection | null = null;
  let chunk: VChunk | null = null;
  let blanks = 0;
  const flushBlanks = (): void => {
    if (cur === null || blanks === 0) {
      blanks = 0;
      return;
    }
    if (cur.kind === 'add') {
      for (let k = 0; k < blanks; k++) cur.addLines.push('');
    } else if (cur.kind === 'update' && chunk !== null) {
      for (let k = 0; k < blanks; k++) {
        const idx = chunk.old.length;
        chunk.old.push('');
        chunk.nlines.push({ text: '', ctx: idx });
      }
    }
    blanks = 0;
  };
  const appendBody = (c: VChunk, line: string): void => {
    if (line.startsWith(' ')) {
      const idx = c.old.length;
      c.old.push(line.slice(1));
      c.nlines.push({ text: line.slice(1), ctx: idx });
    } else if (line.startsWith('-')) c.old.push(line.slice(1));
    else if (line.startsWith('+')) c.nlines.push({ text: line.slice(1), ctx: -1 });
  };
  const closeSection = (): void => {
    if (cur !== null && cur.kind === 'update' && cur.chunks.length === 0 && cur.moveTo === null) {
      throw new Exit2(`error: parse ${cur.lineNo}`);
    }
    cur = null;
    chunk = null;
    blanks = 0;
  };
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      blanks++;
      i++;
      continue;
    }
    if (line.startsWith('*** Add File: ') || line.startsWith('*** Delete File: ') || line.startsWith('*** Update File: ')) {
      closeSection();
      const kind = line.startsWith('*** Add File: ') ? 'add' : line.startsWith('*** Delete File: ') ? 'delete' : 'update';
      const path = line.slice(kind === 'add' ? 14 : 17).trim();
      cur = { kind, path, moveTo: null, lineNo: i + 1, addLines: [], chunks: [] };
      sections.push(cur);
      i++;
      if (kind === 'update' && (lines[i] ?? '').startsWith('*** Move to: ')) {
        cur.moveTo = lines[i]!.slice(13).trim();
        i++;
      }
      continue;
    }
    if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
    if (cur.kind === 'add') {
      if (line.startsWith('+')) {
        flushBlanks();
        cur.addLines.push(line.slice(1));
        i++;
        continue;
      }
      throw new Exit2(`error: parse ${i + 1}`);
    }
    if (cur.kind === 'delete') throw new Exit2(`error: parse ${i + 1}`);
    if (line.startsWith('@@')) {
      if (chunk !== null) flushBlanks();
      blanks = 0;
      const anchorText = line.slice(2).trim();
      chunk = { anchor: anchorText === '' ? null : anchorText, eof: false, old: [], nlines: [] };
      cur.chunks.push(chunk);
      i++;
      continue;
    }
    if (line.trimEnd() === '*** End of File') {
      if (chunk === null) throw new Exit2(`error: parse ${i + 1}`);
      flushBlanks();
      chunk.eof = true;
      chunk = null;
      i++;
      continue;
    }
    if (line.startsWith(' ') || line.startsWith('-') || line.startsWith('+')) {
      if (chunk !== null) {
        flushBlanks();
        appendBody(chunk, line);
        i++;
        continue;
      }
      if (cur.chunks.length === 0) {
        flushBlanks();
        chunk = { anchor: null, eof: false, old: [], nlines: [] };
        cur.chunks.push(chunk);
        appendBody(chunk, line);
        i++;
        continue;
      }
      throw new Exit2(`error: parse ${i + 1}`);
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  closeSection();
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((sec) => v4aEdit(sec, strict));
}

function v4aEdit(sec: VSection, strict: boolean): Edit {
  return (tree) => {
    if (sec.kind === 'add') {
      const p = sec.path;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, sec.addLines.length === 0 ? '' : sec.addLines.join('\n') + '\n');
      return null;
    }
    if (sec.kind === 'delete') {
      const p = sec.path;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return null;
    }
    const p = sec.path;
    if (!safe(p)) throw new Fail('unsafe', p);
    if (sec.moveTo !== null && !safe(sec.moveTo)) throw new Fail('unsafe', sec.moveTo);
    const cur = tree.get(p);
    if (cur === null) throw new Fail('missing', p);
    if (sec.moveTo !== null && tree.get(sec.moveTo) !== null) throw new Fail('exists', sec.moveTo);
    const fs = parseFile(cur);
    let cursor = 0;
    for (const ch of sec.chunks) {
      if (ch.anchor !== null) {
        let found = -1;
        for (const t of tiers(strict)) {
          for (let x = cursor; x < fs.lines.length; x++) {
            if (lineEq(fs.lines[x]!, ch.anchor, t)) {
              found = x;
              break;
            }
          }
          if (found >= 0) break;
        }
        if (found < 0) throw new Fail('no-match', p);
        cursor = found + 1;
      }
      const o = ch.old;
      if (o.length === 0) {
        const idx = ch.eof ? fs.lines.length : cursor;
        const rep = ch.nlines.map((nl) => nl.text);
        fs.lines.splice(idx, 0, ...rep);
        cursor = idx + rep.length;
      } else {
        let tierFound = -1;
        let occ: number[] = [];
        for (const t of tiers(strict)) {
          const all = occurrences(fs.lines, o, t, cursor);
          const filtered = ch.eof ? all.filter((q) => q + o.length === fs.lines.length) : all;
          if (filtered.length > 0) {
            tierFound = t;
            occ = filtered;
            break;
          }
        }
        if (tierFound < 0) throw new Fail('no-match', p);
        const at = occ[0]!;
        const rep = mapNew(fs, at, ch, tierFound);
        fs.lines.splice(at, o.length, ...rep);
        cursor = at + rep.length;
      }
    }
    const out = renderFile(fs);
    if (sec.moveTo !== null) {
      tree.now.set(p, null);
      tree.now.set(sec.moveTo, out);
      return { old: p, new: sec.moveTo };
    }
    tree.now.set(p, out);
    return null;
  };
}

// ---------------------------------------------------------------- driver (sections 1, 2, 10)

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines, strict);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else edits = parseV4a(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  const moves: Move[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      const mv = edit(tree);
      if (mv !== null) moves.push(mv);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const changed = new Map<string, string | null>();
  for (const p of [...tree.now.keys()]) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was !== now) changed.set(p, now);
  }
  const rows: { key: string; text: string }[] = [];
  const used = new Set<string>();
  for (const mv of moves) {
    const wasOld = tree.original(mv.old);
    const wasNew = tree.original(mv.new);
    const nowOld = tree.get(mv.old);
    const nowNew = tree.get(mv.new);
    if (wasOld !== null && wasNew === null && nowOld === null && nowNew !== null) {
      rows.push({ key: mv.new, text: `R ${mv.old} -> ${mv.new}` });
      used.add(mv.old);
      used.add(mv.new);
    }
  }
  for (const [p, now] of changed) {
    if (used.has(p)) continue;
    const was = tree.original(p);
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key, 'utf8'), Buffer.from(b.key, 'utf8')));
  if (!check) {
    for (const [p, now] of changed) {
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.text), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
