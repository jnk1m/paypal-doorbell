// The diffs the AI will read: last-good handler -> each bad handler, computed from the real files (plan 5.4 #5, R11).
// scripts/build-diffs.ts runs this at build time. A line has an id, "<file>:<line>": for added and unchanged lines the file is the
// bad handler (the one that runs in that mode) and the line is the line in that file; for a removed line the file is the last-good
// handler. So every id the AI could cite names one real line in one real file, and a test can read that line and compare.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LAST_GOOD, MODE_FILE } from "./mode-files.ts";
import { ALL_MODES, MODES, SETTING_MODES, isPlanted, type PlantedMode, type SettingMode } from "./types.ts";

export interface DiffLine {
  kind: "ctx" | "add" | "del";
  id: string;
  text: string;
}

export interface Hunk {
  id: string; // "<bad file>#<n>"
  lines: DiffLine[];
}

export interface ModeDiff {
  mode: PlantedMode;
  from: string; // the last-good file
  to: string; // the file that runs in this mode
  hunks: Hunk[];
}

// The same diff for a deploy that broke a setting and not the code (types.ts SettingMode). Kept out of `diffs`: everything that walks `diffs`
// (lib/cause and its tests) is built for the three code bugs, and its mode is not a PlantedMode. lib/run/deploy-input.ts reads this list.
export interface SettingDiff {
  mode: SettingMode;
  from: string;
  to: string;
  hunks: Hunk[];
}

export interface DiffBundle {
  files: Record<string, string>; // sha256 of every handler file the diffs were computed from
  texts: Record<string, string>; // the handler files themselves, so that the cause step can rebuild its request (and find its recording) without reading the disk
  diffs: ModeDiff[];
  settingDiffs: SettingDiff[];
}

const CONTEXT = 2;

export const splitLines = (source: string): string[] => {
  const lines = source.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
};

// A line that can be evidence: not blank, not a comment (plan 5.4 C1').
export const isCodeLine = (text: string): boolean => {
  const t = text.trim();
  return t !== "" && !t.startsWith("//") && !t.startsWith("/*") && !t.startsWith("*");
};

// The handlers are plain ASCII, so the line a person sees and the line that is compared are the same characters. If one ever holds
// a non-ASCII or control character the build stops; real normalization of foreign code is the sanitizer's job (R14).
function assertPlainAscii(file: string, lines: string[]): void {
  lines.forEach((line, i) => {
    if (!/^[\x20-\x7e]*$/.test(line)) throw new Error(`${file}:${i + 1} has a character outside printable ASCII; handler files must be plain ASCII so that what is shown is what is compared`);
  });
}

type Op = { kind: "ctx" | "add" | "del"; oldNo?: number; newNo?: number; text: string };

// Line diff by longest common subsequence. Handler files are a few dozen lines, so the quadratic table is fine.
function lineOps(a: string[], b: string[]): Op[] {
  const n = a.length;
  const m = b.length;
  const lcs = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) ops.push({ kind: "ctx", oldNo: ++i, newNo: ++j, text: b[j - 1] });
    else if (i < n && (j >= m || lcs[i + 1][j] >= lcs[i][j + 1])) ops.push({ kind: "del", oldNo: ++i, text: a[i - 1] });
    else ops.push({ kind: "add", newNo: ++j, text: b[j - 1] });
  }
  return ops;
}

export function diffFiles(from: string, to: string, fromSource: string, toSource: string): Hunk[] {
  const ops = lineOps(splitLines(fromSource), splitLines(toSource));
  const keep = new Array<boolean>(ops.length).fill(false);
  ops.forEach((op, i) => {
    if (op.kind === "ctx") return;
    for (let k = Math.max(0, i - CONTEXT); k <= Math.min(ops.length - 1, i + CONTEXT); k++) keep[k] = true;
  });
  const hunks: Hunk[] = [];
  let current: Hunk | undefined;
  ops.forEach((op, i) => {
    if (!keep[i]) {
      current = undefined;
      return;
    }
    if (!current) {
      current = { id: `${to}#${hunks.length + 1}`, lines: [] };
      hunks.push(current);
    }
    const id = op.kind === "del" ? `${from}:${op.oldNo}` : `${to}:${op.newNo}`;
    current.lines.push({ kind: op.kind, id, text: op.text });
  });
  return hunks;
}

// The diff for every planted mode (and every setting mode, in `settingDiffs`), from the files under `root`.
export function computeDiffs(root: string): DiffBundle {
  const read = (file: string): string => {
    const source = readFileSync(join(root, file), "utf8");
    assertPlainAscii(file, splitLines(source));
    return source;
  };
  const files: Record<string, string> = {};
  const sources: Record<string, string> = {};
  for (const mode of ALL_MODES) {
    const file = MODE_FILE[mode];
    sources[file] = read(file);
    files[file] = createHash("sha256").update(sources[file]).digest("hex");
  }
  const from = MODE_FILE[LAST_GOOD];
  const diffs: ModeDiff[] = MODES.filter(isPlanted).map((mode) => {
    const to = MODE_FILE[mode];
    return { mode, from, to, hunks: diffFiles(from, to, sources[from], sources[to]) };
  });
  const settingDiffs: SettingDiff[] = SETTING_MODES.map((mode) => {
    const to = MODE_FILE[mode];
    return { mode, from, to, hunks: diffFiles(from, to, sources[from], sources[to]) };
  });
  return { files, texts: sources, diffs, settingDiffs };
}

export function writeDiffs(root: string, outFile: string): DiffBundle {
  const bundle = computeDiffs(root);
  writeFileSync(outFile, `${JSON.stringify(bundle, null, 2)}\n`);
  return bundle;
}

// The lines of a diff that the AI is allowed to cite: changed (added or removed), and code rather than comment or blank.
export const citableLines = (diff: Pick<ModeDiff, "hunks">): DiffLine[] => diff.hunks.flatMap((h) => h.lines).filter((l) => l.kind !== "ctx" && isCodeLine(l.text));
