// mend: one patch tool for every AI edit format.
//
// Reads a patch in one of four formats (unified diff, SEARCH/REPLACE blocks,
// V4A patches, JSON tool calls), finds the lines each edit names at the first
// of three matching tiers, and writes every change or none, exactly as the
// SPEC.md beside this file says. Node 22, standard library alone; run it as
// `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set,
// and then this file hands over to runner.ts (the last lines below): keep
// that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

/** A patch-level failure: exit 2 with exactly this one line on stdout. */
class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}

/** One edit failed: exit 1 carries `error: <code> <path>` for it. */
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

/** A patch's lines: split at \n, one trailing \r removed, no empty piece after a final \n. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/** SPEC section 3: a path is safe when it is not empty, not absolute, holds no backslash, and none of its segments is empty, `.` or `..`. */
function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** A file split into lines the way SPEC section 3 says: its line break is CRLF when its first line feed follows a carriage return, LF otherwise; it ends with a line break when its text ends with that break. */
interface SplitFile {
  lines: string[];
  br: string;
  final: boolean;
}

function splitFile(text: string): SplitFile {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(br);
  const final = text.endsWith(br);
  if (final) lines.pop();
  return { lines, br, final };
}

/** The reverse of splitFile: a file of no lines is written empty. */
function joinFile(f: SplitFile): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. `origin` remembers, for a path that arrived by a move edit, the path it came from, so the output can print one `R` line for the pair. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  private readonly origin = new Map<string, string>();
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
  /** Record a write that is not a move. Deleting a path breaks any move chain through it; writing new bytes to a moved file does not (it is still the moved file). */
  set(p: string, v: string | null): void {
    this.now.set(p, v);
    if (v === null) this.origin.delete(p);
  }
  /** Record a move: the new path inherits the old path's origin (or the old path itself). */
  move(from: string, to: string, v: string | null): void {
    const o = this.origin.get(from) ?? from;
    this.now.set(from, null);
    this.now.set(to, v);
    this.origin.delete(from);
    this.origin.set(to, o);
  }
  /** The path `p` came from by moves, when it is still a moved file (its origin differs from it). */
  movedFrom(p: string): string | null {
    const o = this.origin.get(p);
    return o !== undefined && o !== p ? o : null;
  }
}

/** Strip trailing spaces and tabs (tier 1) or leading and trailing spaces and tabs (tier 2). */
function norm(line: string, tier: number): string {
  if (tier === 0) return line;
  if (tier === 1) return line.replace(/[ \t]+$/, '');
  return line.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** All positions where O's lines match the file's lines at one tier; occurrences may overlap. */
function occurrencesAt(O: string[], F: string[], tier: number): number[] {
  const out: number[] = [];
  if (O.length === 0 || O.length > F.length) return out;
  const on = O.map((l) => norm(l, tier));
  for (let i = 0; i + O.length <= F.length; i += 1) {
    let ok = true;
    for (let j = 0; j < O.length; j += 1) {
      if (norm(F[i + j]!, tier) !== on[j]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

type Edit = (tree: Tree) => void;

/** SPEC section 4: the first of these that holds, where a blank line is empty or only whitespace. */
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

/**
 * One body of edit lines, as unified hunks and V4A chunks both hold them:
 * `kind` per line is ' ' (context), '-' (old), '+' (new); a `\` line is kept
 * as kind '\\' and refers to the body line before it. `text` is the line
 * after its marker.
 */
interface BodyLine {
  kind: ' ' | '-' | '+' | '\\';
  text: string;
}

/** The old lines O of a body (context and `-` lines, in body order) and its new lines N (context and `+` lines). */
function bodyON(body: BodyLine[]): { O: string[]; N: string[] } {
  const O: string[] = [];
  const N: string[] = [];
  for (const b of body) {
    if (b.kind === ' ') {
      O.push(b.text);
      N.push(b.text);
    } else if (b.kind === '-') O.push(b.text);
    else if (b.kind === '+') N.push(b.text);
  }
  return { O, N };
}

/** Whether a `\` line follows the body's last context or `+` line (SPEC sections 6, 8: that line says the new text's last line has no line break). */
function noEol(body: BodyLine[]): boolean {
  let last = -1;
  body.forEach((b, i) => {
    if (b.kind === ' ' || b.kind === '+') last = i;
  });
  return last >= 0 && body[last + 1]?.kind === '\\';
}

/**
 * Build the replacement lines for a matched region: context lines are written
 * as the file's own matched lines, never the patch's; at tier 2 every other
 * line of N is re-indented from O's first line's leading whitespace to the
 * file's first matched line's. `at` is the 0-based position of the match.
 */
function buildReplacement(body: BodyLine[], F: string[], at: number, tier: number): string[] {
  const lead = (s: string): string => {
    const m = /^[ \t]*/.exec(s);
    return m ? m[0] : '';
  };
  const { O } = bodyON(body);
  const fLead = at < F.length ? lead(F[at]!) : '';
  const pLead = O.length > 0 ? lead(O[0]!) : '';
  const out: string[] = [];
  let j = 0;
  for (const b of body) {
    if (b.kind === ' ') {
      out.push(F[at + j]!);
      j += 1;
    } else if (b.kind === '-') {
      j += 1;
    } else if (b.kind === '+') {
      let t = b.text;
      if (tier === 2 && t !== '' && t.trim() !== '' && t.startsWith(pLead)) t = fLead + t.slice(pLead.length);
      out.push(t);
    }
  }
  return out;
}

/**
 * Apply one body to a file's lines at the first tier where O occurs at least
 * once, taking the occurrence the caller picks (unified: nearest to a line
 * number; V4A: first at or after the cursor). Returns the new lines, the new
 * final-break flag, and the position just after the lines written. Throws
 * Fail('no-match') or Fail('ambiguous') when the match fails. `noEolApplies`
 * is false for formats with no `\` line (V4A): there the file's final break
 * always stays as it was.
 */
function applyBody(
  body: BodyLine[],
  file: SplitFile,
  strict: boolean,
  pick: (positions: number[], tier: number) => number | null,
  endAnchored: boolean,
  from = 0,
  noEolApplies = true,
): { lines: string[]; final: boolean; after: number } {
  const { O } = bodyON(body);
  const F = file.lines;
  const tiers = strict ? [0] : [0, 1, 2];
  if (O.length === 0) {
    const at = pick([], 0);
    if (at === null) throw new Fail('no-match', '');
    const ins = buildReplacement(body, F, at, 0);
    const lines = [...F.slice(0, at), ...ins, ...F.slice(at)];
    const touchesEnd = at === F.length;
    return { lines, final: touchesEnd && noEolApplies ? !noEol(body) : file.final, after: at + ins.length };
  }
  for (const tier of tiers) {
    let positions = occurrencesAt(O, F, tier);
    if (endAnchored) positions = positions.filter((i) => i + O.length === F.length);
    positions = positions.filter((i) => i >= from);
    if (positions.length === 0) continue;
    const at = pick(positions, tier);
    if (at === null) throw new Fail('no-match', '');
    const rep = buildReplacement(body, F, at, tier);
    const lines = [...F.slice(0, at), ...rep, ...F.slice(at + O.length)];
    const touchesEnd = at + O.length === F.length;
    return { lines, final: touchesEnd && noEolApplies ? !noEol(body) : file.final, after: at + rep.length };
  }
  throw new Fail('no-match', '');
}

/** A hunk of a unified section: its old-file start line A (1-based), its body, and the d offset it contributes. */
interface Hunk {
  a: number;
  body: BodyLine[];
}

/** One unified section: the edit it is, with its hunks. */
interface Section {
  oldPath: string | null;
  newPath: string | null;
  create: boolean;
  remove: boolean;
  hunks: Hunk[];
}

/** The path after `--- ` or `+++ `: text after the four characters, up to the first tab, surrounding spaces removed, a leading `a/` or `b/` removed. `/dev/null` means no file. */
function headerPath(line: string): string | null {
  const raw = line.slice(4).split('\t')[0]!.trim();
  if (raw === '/dev/null') return null;
  if (raw.startsWith('a/') || raw.startsWith('b/')) return raw.slice(2);
  return raw;
}

/** Parse a `diff --git a/<X> b/<Y>` line, or throw a parse error at its line when it is not of that form. */
function gitPaths(line: string, n: number): [string, string] {
  const m = /^diff --git a\/(\S+) b\/(\S+)\s*$/.exec(line);
  if (m === null) throw new Exit2(`error: parse ${n}`);
  return [m[1]!, m[2]!];
}

/** Parse a hunk header `@@ -A[,B] +C[,D] @@`, optionally followed by text; any other line starting with `@@` is a parse error at its line. */
function hunkStart(line: string, n: number): number {
  const m = /^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/.exec(line);
  if (m === null) throw new Exit2(`error: parse ${n}`);
  return Number(m[1]);
}

/** A hunk body line: ` `, `-`, `+` or `\`, or an empty line (a context line whose text is empty). Anything else ends the body. */
function bodyLineOf(line: string): BodyLine | null {
  if (line === '') return { kind: ' ', text: '' };
  const k = line[0];
  if (k === ' ' || k === '-' || k === '+' || k === '\\') return { kind: k as BodyLine['kind'], text: line.slice(1) };
  return null;
}

/** Read a patch as unified diffs (SPEC section 6) into one edit per section. */
function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let gitOld: string | null = null;
  let gitNew: string | null = null;
  // undefined: no ---/+++ pair named paths; null: the pair named /dev/null (no file).
  let pairOld: string | null | undefined = undefined;
  let pairNew: string | null | undefined = undefined;
  let renameOld: string | null = null;
  let renameNew: string | null = null;
  let newFile = false;
  let deletedFile = false;
  let inHeader = false;
  let inBody = false;
  let hunk: Hunk | null = null;

  const closeBody = (): void => {
    if (hunk !== null) {
      while (hunk.body.length > 0 && hunk.body[hunk.body.length - 1]!.kind === ' ' && hunk.body[hunk.body.length - 1]!.text === '') hunk.body.pop();
      cur!.hunks.push(hunk);
      hunk = null;
    }
    inBody = false;
  };
  const closeSection = (): void => {
    if (cur === null) return;
    closeBody();
    cur.oldPath = pairOld !== undefined ? pairOld : (renameOld ?? gitOld);
    cur.newPath = pairNew !== undefined ? pairNew : (renameNew ?? gitNew);
    cur.create = pairOld === null || newFile;
    cur.remove = pairNew === null || deletedFile;
    sections.push(cur);
    cur = null;
    inHeader = false;
  };
  const openSection = (): void => {
    closeSection();
    cur = { oldPath: null, newPath: null, create: false, remove: false, hunks: [] };
    gitOld = null;
    gitNew = null;
    pairOld = undefined;
    pairNew = undefined;
    renameOld = null;
    renameNew = null;
    newFile = false;
    deletedFile = false;
    inHeader = true;
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    const n = i + 1;
    if (inBody) {
      if (line.startsWith('diff --git ')) {
        closeBody();
        openSection();
        [gitOld, gitNew] = gitPaths(line, n);
        continue;
      }
      if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
        closeBody();
        openSection();
        pairOld = headerPath(line);
        pairNew = headerPath(lines[i + 1]!);
        i += 1;
        continue;
      }
      if (line.startsWith('@@')) {
        closeBody();
        hunk = { a: hunkStart(line, n), body: [] };
        inBody = true;
        continue;
      }
      const b = bodyLineOf(line);
      if (b === null) {
        closeBody();
        continue;
      }
      hunk!.body.push(b);
      continue;
    }
    if (line.startsWith('diff --git ')) {
      openSection();
      [gitOld, gitNew] = gitPaths(line, n);
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur === null) openSection();
      else if (!inHeader) openSection();
      pairOld = headerPath(line);
      pairNew = headerPath(lines[i + 1]!);
      i += 1;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${n}`);
      hunk = { a: hunkStart(line, n), body: [] };
      inBody = true;
      inHeader = false;
      continue;
    }
    if (cur !== null && inHeader) {
      if (line.startsWith('--- ')) {
        if (!(lines[i + 1] ?? '').startsWith('+++ ')) throw new Exit2(`error: parse ${n + 1}`);
        pairOld = headerPath(line);
        pairNew = headerPath(lines[i + 1]!);
        i += 1;
        continue;
      }
      if (line.startsWith('rename from ')) renameOld = line.slice('rename from '.length).trim();
      else if (line.startsWith('rename to ')) renameNew = line.slice('rename to '.length).trim();
      else if (line.startsWith('new file mode')) newFile = true;
      else if (line.startsWith('deleted file mode')) deletedFile = true;
    }
  }
  closeSection();
  if (sections.length === 0) throw new Exit2('error: parse 1');

  return sections.map((s) => (tree: Tree): void => {
    const oldP = s.oldPath;
    const newP = s.newPath;
    if (s.create) {
      if (newP === null) throw new Fail('unsafe', '');
      if (!safe(newP)) throw new Fail('unsafe', newP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const plus = s.hunks.flatMap((h) => h.body.filter((b) => b.kind === '+').map((b) => b.text));
      // A created file ends with a line break unless a `\` line follows its last `+` line, wherever in the section that line is.
      let lastPlus: { body: BodyLine[]; i: number } | null = null;
      for (const h of s.hunks) {
        h.body.forEach((b, i) => {
          if (b.kind === '+') lastPlus = { body: h.body, i };
        });
      }
      const endsBreak = lastPlus === null || lastPlus.body[lastPlus.i + 1]?.kind !== '\\';
      tree.set(newP, plus.length === 0 ? '' : plus.join('\n') + (endsBreak ? '\n' : ''));
      return;
    }
    if (s.remove) {
      if (oldP === null) throw new Fail('unsafe', '');
      if (!safe(oldP)) throw new Fail('unsafe', oldP);
      if (tree.get(oldP) === null) throw new Fail('missing', oldP);
      tree.set(oldP, null);
      return;
    }
    if (oldP === null || newP === null) throw new Fail('unsafe', '');
    if (!safe(oldP)) throw new Fail('unsafe', oldP);
    if (!safe(newP)) throw new Fail('unsafe', newP);
    const before = tree.get(oldP);
    if (before === null) throw new Fail('missing', oldP);
    if (oldP !== newP && tree.get(newP) !== null) throw new Fail('exists', newP);
    let file = splitFile(before);
    let d = 0;
    for (const h of s.hunks) {
      const a = h.a;
      const at = h.body.length === 0 || bodyON(h.body).O.length === 0;
      try {
        if (at) {
          const ins = buildReplacement(h.body, file.lines, 0, 0);
          const pos = Math.max(0, Math.min(a + d, file.lines.length));
          const nl = [...file.lines.slice(0, pos), ...ins, ...file.lines.slice(pos)];
          const touchesEnd = pos === file.lines.length;
          file = { lines: nl, br: file.br, final: touchesEnd ? !noEol(h.body) : file.final };
        } else {
          const target = a - 1 + d;
          const r = applyBody(h.body, file, strict, (positions) => {
            let best: number | null = null;
            let bestDist = Infinity;
            for (const p of positions) {
              const dist = Math.abs(p - target);
              if (dist < bestDist) {
                bestDist = dist;
                best = p;
              }
            }
            return best;
          }, false);
          file = { lines: r.lines, br: file.br, final: r.final };
        }
      } catch (e) {
        if (e instanceof Fail && e.path === '') throw new Fail('no-match', oldP);
        throw e;
      }
      d += bodyON(h.body).N.length - bodyON(h.body).O.length;
    }
    const out = joinFile(file);
    if (oldP === newP) tree.set(oldP, out);
    else tree.move(oldP, newP, out);
  });
}

/** Read a patch as SEARCH/REPLACE blocks (SPEC section 7) into one edit per block. */
function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  interface Block {
    path: string;
    oldLines: string[];
    newLines: string[];
    searchLine: number;
  }
  const blocks: Block[] = [];
  let prevReplace = -1;
  let prevPath: string | null = null;
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') continue;
    const searchLine = i + 1;
    // The path is the nearest line before the SEARCH line, and after the previous block's REPLACE line (or the start), that is not blank and does not start with three backticks; its surrounding whitespace is removed.
    let path: string | null = null;
    for (let j = i - 1; j > prevReplace; j -= 1) {
      const t = lines[j]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${searchLine}`);
    // Old lines up to =======, then new lines up to >>>>>>> REPLACE.
    let k = i + 1;
    while (k < lines.length && lines[k]!.trimEnd() !== '=======') k += 1;
    if (k >= lines.length) throw new Exit2(`error: parse ${searchLine}`);
    const oldLines = lines.slice(i + 1, k);
    let m = k + 1;
    while (m < lines.length && lines[m]!.trimEnd() !== '>>>>>>> REPLACE') m += 1;
    if (m >= lines.length) throw new Exit2(`error: parse ${searchLine}`);
    const newLines = lines.slice(k + 1, m);
    blocks.push({ path, oldLines, newLines, searchLine });
    prevPath = path;
    prevReplace = m;
    i = m;
  }
  if (blocks.length === 0) throw new Exit2('error: parse 1');

  return blocks.map((b) => (tree: Tree): void => {
    if (!safe(b.path)) throw new Fail('unsafe', b.path);
    if (b.oldLines.length === 0) {
      if (tree.get(b.path) !== null) throw new Fail('exists', b.path);
      tree.set(b.path, b.newLines.length === 0 ? '' : b.newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(b.path);
    if (before === null) throw new Fail('missing', b.path);
    const file = splitFile(before);
    const tiers = strict ? [0] : [0, 1, 2];
    for (const tier of tiers) {
      const positions = occurrencesAt(b.oldLines, file.lines, tier);
      if (positions.length === 0) continue;
      if (positions.length > 1) throw new Fail('ambiguous', b.path);
      const at = positions[0]!;
      // The new lines replace the old ones; at tier 2 they are re-indented from O's first line to the file's first matched line, exactly as buildReplacement does for `+` lines.
      const rep = buildReplacement(
        [...b.oldLines.map((t): BodyLine => ({ kind: '-', text: t })), ...b.newLines.map((t): BodyLine => ({ kind: '+', text: t }))],
        file.lines,
        at,
        tier,
      );
      const nl = [...file.lines.slice(0, at), ...rep, ...file.lines.slice(at + b.oldLines.length)];
      tree.set(b.path, joinFile({ lines: nl, br: file.br, final: file.final }));
      return;
    }
    throw new Fail('no-match', b.path);
  });
}

/** One V4A chunk: its anchor (null: no anchor), its body, and whether `*** End of File` anchored it to the end of the file. */
interface VChunk {
  anchor: string | null;
  body: BodyLine[];
  eof: boolean;
}

/** One V4A section: the edit it is. */
interface VSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  moveTo: string | null;
  lines: string[];
  chunks: VChunk[];
  updateLine: number;
}

const V4A_STARTS: Array<[string, VSection['kind']]> = [
  ['*** Add File: ', 'add'],
  ['*** Delete File: ', 'delete'],
  ['*** Update File: ', 'update'],
];

/** Read a patch as a V4A patch (SPEC section 8) into one edit per section. */
function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (!blank(lines[i]!)) {
      last = i;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);

  const sections: VSection[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i += 1;
      continue;
    }
    const start = V4A_STARTS.find(([p]) => line.startsWith(p));
    if (start === undefined) throw new Exit2(`error: parse ${i + 1}`);
    const kind = start[1];
    const path = line.slice(start[0].length).trim();
    const sectionLine = i + 1;
    i += 1;
    // The section's raw lines run to the next section start or *** End Patch; blank lines at the end of a section are not part of it.
    const raw: Array<{ text: string; n: number }> = [];
    while (i < last) {
      const l = lines[i]!;
      if (V4A_STARTS.some(([p]) => l.startsWith(p))) break;
      raw.push({ text: l, n: i + 1 });
      i += 1;
    }
    while (raw.length > 0 && raw[raw.length - 1]!.text.trim() === '') raw.pop();
    if (kind === 'add') {
      const fileLines: string[] = [];
      for (const r of raw) {
        if (r.text === '') fileLines.push('');
        else if (r.text.startsWith('+')) fileLines.push(r.text.slice(1));
        else throw new Exit2(`error: parse ${r.n}`);
      }
      sections.push({ kind, path, moveTo: null, lines: fileLines, chunks: [], updateLine: sectionLine });
    } else if (kind === 'delete') {
      for (const r of raw) {
        if (r.text !== '') throw new Exit2(`error: parse ${r.n}`);
      }
      sections.push({ kind, path, moveTo: null, lines: [], chunks: [], updateLine: sectionLine });
    } else {
      let moveTo: string | null = null;
      const chunks: VChunk[] = [];
      let chunk: VChunk | null = null;
      const closeChunk = (): void => {
        if (chunk !== null) {
          chunks.push(chunk);
          chunk = null;
        }
      };
      for (const r of raw) {
        const t = r.text;
        if (t.startsWith('*** Move to: ')) {
          if (moveTo !== null || chunk !== null) throw new Exit2(`error: parse ${r.n}`);
          moveTo = t.slice('*** Move to: '.length).trim();
        } else if (t.startsWith('@@')) {
          closeChunk();
          chunk = { anchor: t.slice(2).trim() === '' ? null : t.slice(2).trim(), body: [], eof: false };
        } else if (t === '*** End of File') {
          if (chunk === null) chunk = { anchor: null, body: [], eof: true };
          else chunk.eof = true;
          closeChunk();
        } else if (t === '' || t.startsWith(' ') || t.startsWith('-') || t.startsWith('+')) {
          if (chunk === null) chunk = { anchor: null, body: [], eof: false };
          chunk.body.push(t === '' ? { kind: ' ', text: '' } : { kind: t[0] as BodyLine['kind'], text: t.slice(1) });
        } else {
          throw new Exit2(`error: parse ${r.n}`);
        }
      }
      closeChunk();
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${sectionLine}`);
      sections.push({ kind, path, moveTo, lines: [], chunks, updateLine: sectionLine });
    }
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');

  return sections.map((s) => (tree: Tree): void => {
    if (!safe(s.path)) throw new Fail('unsafe', s.path);
    if (s.kind === 'add') {
      if (tree.get(s.path) !== null) throw new Fail('exists', s.path);
      tree.set(s.path, s.lines.length === 0 ? '' : s.lines.join('\n') + '\n');
      return;
    }
    if (s.kind === 'delete') {
      if (tree.get(s.path) === null) throw new Fail('missing', s.path);
      tree.set(s.path, null);
      return;
    }
    if (s.moveTo !== null && !safe(s.moveTo)) throw new Fail('unsafe', s.moveTo);
    const before = tree.get(s.path);
    if (before === null) throw new Fail('missing', s.path);
    if (s.moveTo !== null && tree.get(s.moveTo) !== null) throw new Fail('exists', s.moveTo);
    let file = splitFile(before);
    let cursor = 0;
    for (const c of s.chunks) {
      try {
        if (c.anchor !== null) {
          const anchor = c.anchor;
          const tiers = strict ? [0] : [0, 1, 2];
          let found: number | null = null;
          for (const tier of tiers) {
            for (let k = cursor; k < file.lines.length; k += 1) {
              if (norm(file.lines[k]!, tier) === norm(anchor, tier)) {
                found = k;
                break;
              }
            }
            if (found !== null) break;
          }
          if (found === null) throw new Fail('no-match', s.path);
          cursor = found + 1;
        }
        const atCursor = cursor;
        const eof = c.eof;
        const r = applyBody(
          c.body,
          file,
          strict,
          (positions) => {
            if (bodyON(c.body).O.length === 0) return eof ? file.lines.length : atCursor;
            return positions.length > 0 ? positions[0]! : null;
          },
          eof,
          atCursor,
          false,
        );
        file = { lines: r.lines, br: file.br, final: r.final };
        cursor = r.after;
      } catch (e) {
        if (e instanceof Fail && e.path === '') throw new Fail('no-match', s.path);
        throw e;
      }
    }
    const out = joinFile(file);
    if (s.moveTo === null) tree.set(s.path, out);
    else tree.move(s.path, s.moveTo, out);
  });
}

/** One JSON edit object (SPEC section 9), or null when the value is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const needFile = (tree: Tree): string => {
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
      tree.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = needFile(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const toLf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = toLf(before);
      const old = toLf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + toLf(newStr) + t.slice(at + old.length);
      tree.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = needFile(tree);
      const file = splitFile(before);
      if (line < 0 || line > file.lines.length) throw new Fail('no-match', p);
      const nl = [...file.lines.slice(0, line), ...add, ...file.lines.slice(line)];
      tree.set(p, joinFile({ lines: nl, br: file.br, final: file.final }));
    };
  }
  return null;
}

/** Read a patch as JSON edits (SPEC section 9): one JSON array of edit objects, or JSON Lines with one edit object a line. */
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
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines, strict)
          : kind === 'search-replace'
            ? searchReplaceEdits(lines, strict)
            : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  // One line per changed path, in byte order of the paths (UTF-8); a move prints one `R <old> -> <new>` line that sorts by <new> and replaces that pair's `D` and `A` lines.
  interface Row {
    key: string;
    line: string;
  }
  const rows: Row[] = [];
  const moved = new Set<string>();
  for (const p of tree.now.keys()) {
    const from = tree.movedFrom(p);
    if (from === null) continue;
    if (tree.original(from) === null || tree.get(from) !== null) continue;
    if (tree.original(p) !== null || tree.get(p) === null) continue;
    rows.push({ key: p, line: `R ${from} -> ${p}` });
    moved.add(from);
    moved.add(p);
  }
  for (const p of tree.now.keys()) {
    if (moved.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const out = rows.map((r) => r.line);
  if (!check) {
    for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...out, `ok: ${out.length} ${out.length === 1 ? 'file' : 'files'}`] };
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
