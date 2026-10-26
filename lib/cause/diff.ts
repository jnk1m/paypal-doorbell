// The diff the cause step reads, as data. Two sources, one shape: a unified diff text (the evaluation sets: git diff output) and the
// shop's build-time diff (lib/shop/diffs.ts: last-good handler -> planted handler). Every changed line gets an id (L1, L2, ...) and every
// hunk one (H1, ...). The model answers in ids; a check looks each id up here, so a line on screen is always a line of this diff,
// never a string the model wrote (plan 5.4 #4).
//
// A line is "citable" when it is a changed line (added or removed) that is code: not a comment, not blank, not a string literal on its
// own, and with no token that mixes Latin with Cyrillic or Greek (C1', plan 5.4 and 9.4). A pure rename has no changed lines, so the
// two "rename from / rename to" header lines count as changed lines (they are what changed).
import type { ModeDiff } from "../shop/diffs.ts";
import { hasMixedScriptToken } from "./hygiene.ts";
import { classifyLine, classifyLines, type LineKind } from "./lines.ts";

export type DiffLineKind = "ctx" | "add" | "del" | "rename";
export type WhyNot = "comment" | "blank" | "string" | "mixed_script" | "unchanged";

export interface DiffLine {
  id?: string; // only changed lines have one
  kind: DiffLineKind;
  file: string; // the path the hunk belongs to (the new path): what a model names and what C1' compares
  shownFile: string; // the path the line number belongs to: the old path for a removed line, otherwise the same as `file`; what the screen shows
  no?: number; // line number in the new file (ctx, add) or the old file (del)
  text: string;
  hunk?: string;
  citable: boolean;
  whyNot?: WhyNot;
}

export interface DiffHunk {
  id: string;
  lines: DiffLine[];
}

export interface DiffFile {
  path: string;
  oldPath: string;
  status: "modified" | "added" | "deleted" | "renamed";
  binary: boolean;
  meta: DiffLine[]; // rename from / rename to
  hunks: DiffHunk[];
}

export interface ParsedDiff {
  files: DiffFile[];
}

export interface Sources {
  before?: Record<string, string>; // by old path
  after?: Record<string, string>; // by new path
}

const strip = (p: string, prefix: string) => (p.startsWith(prefix) ? p.slice(prefix.length) : p);

export function parseUnifiedDiff(text: string, sources: Sources = {}): ParsedDiff {
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const files: DiffFile[] = [];
  let file: DiffFile | undefined;
  let hunk: DiffHunk | undefined;
  let oldNo = 0;
  let newNo = 0;
  let oldLeft = 0;
  let newLeft = 0;

  const start = (oldPath: string, path: string) => {
    file = { path, oldPath, status: oldPath === path ? "modified" : "renamed", binary: false, meta: [], hunks: [] };
    files.push(file);
    hunk = undefined;
  };

  for (const raw of lines) {
    if (hunk && (oldLeft > 0 || newLeft > 0)) {
      if (raw.startsWith("\\")) continue; // "\ No newline at end of file"
      const c = raw[0];
      if (c === "+" || c === "-" || c === " " || raw === "") {
        const kind: DiffLineKind = c === "+" ? "add" : c === "-" ? "del" : "ctx";
        const body = raw === "" ? "" : raw.slice(1);
        const line: DiffLine = { kind, file: file!.path, shownFile: file!.path, text: body, citable: false };
        if (kind === "add") {
          line.no = newNo++;
          newLeft--;
        } else if (kind === "del") {
          line.no = oldNo++;
          oldLeft--;
        } else {
          line.no = newNo++;
          oldNo++;
          newLeft--;
          oldLeft--;
        }
        hunk.lines.push(line);
        continue;
      }
    }
    const git = /^diff --git a\/(.+) b\/(.+)$/.exec(raw);
    if (git) {
      start(git[1], git[2]);
      continue;
    }
    const at = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(raw);
    if (at) {
      if (!file) start("unknown", "unknown");
      oldNo = Number(at[1]);
      newNo = Number(at[3]);
      oldLeft = at[2] === undefined ? 1 : Number(at[2]);
      newLeft = at[4] === undefined ? 1 : Number(at[4]);
      hunk = { id: "", lines: [] };
      file!.hunks.push(hunk);
      continue;
    }
    hunk = undefined;
    if (raw.startsWith("--- ") || raw.startsWith("+++ ")) {
      // A plain `diff -u` has no "diff --git" line: the first "--- " opens the file.
      const name = raw.slice(4).split("\t")[0];
      if (raw.startsWith("--- ") && (!file || file.hunks.length > 0)) start(strip(name, "a/"), strip(name, "a/"));
      if (!file) continue;
      if (raw.startsWith("--- ")) {
        if (name === "/dev/null") file.status = "added";
        else file.oldPath = strip(name, "a/");
      } else if (name === "/dev/null") file.status = "deleted";
      else if (file.hunks.length === 0) file.path = strip(name, "b/");
      continue;
    }
    if (!file) continue;
    if (raw.startsWith("new file mode")) file.status = "added";
    else if (raw.startsWith("deleted file mode")) file.status = "deleted";
    else if (raw.startsWith("rename from ")) file.oldPath = raw.slice("rename from ".length);
    else if (raw.startsWith("rename to ")) file.path = raw.slice("rename to ".length);
    else if (raw.startsWith("Binary files") || raw.startsWith("GIT binary patch")) file.binary = true;
  }
  for (const f of files) {
    if (f.oldPath !== f.path && f.status === "modified") f.status = "renamed";
    if (f.status === "renamed") {
      f.meta = [
        { kind: "rename", file: f.path, shownFile: f.path, text: `rename from ${f.oldPath}`, citable: false },
        { kind: "rename", file: f.path, shownFile: f.path, text: `rename to ${f.path}`, citable: false },
      ];
    }
    f.hunks = f.hunks.filter((h) => h.lines.length > 0);
  }
  return finalize({ files }, sources);
}

// The shop's build-time diff (lib/shop/diffs.ts). The two handler files are two files, not a rename: nothing in it is a rename line.
export function diffFromShop(d: ModeDiff, sources: Sources = {}): ParsedDiff {
  const file: DiffFile = {
    path: d.to,
    oldPath: d.from,
    status: "modified",
    binary: false,
    meta: [],
    hunks: d.hunks.map((h) => ({
      id: "",
      lines: h.lines.map((l) => ({ kind: l.kind, file: d.to, shownFile: d.to, no: Number(/:(\d+)$/.exec(l.id)?.[1]), text: l.text, citable: false })),
    })),
  };
  return finalize({ files: [file] }, sources);
}

// Ids, hunk membership and the citable flag. `sources` are the normalized file texts; with them a line is judged in the context of its
// file (a line inside a block comment is a comment), without them (or when the file does not match the diff) on its own.
function finalize(diff: ParsedDiff, sources: Sources): ParsedDiff {
  let nextLine = 1;
  let nextHunk = 1;
  const kinds = new Map<string, LineKind[]>();
  const kindsOf = (side: "before" | "after", path: string): LineKind[] | undefined => {
    const text = sources[side]?.[path];
    if (text === undefined) return undefined;
    const key = `${side}:${path}`;
    if (!kinds.has(key)) kinds.set(key, classifyLines(text, path));
    return kinds.get(key);
  };
  const lineOf = (side: "before" | "after", path: string, no: number): string | undefined => {
    const text = sources[side]?.[path];
    if (text === undefined) return undefined;
    const rows = text.split("\n");
    return rows[no - 1];
  };

  for (const f of diff.files) {
    for (const m of f.meta) {
      m.id = `L${nextLine++}`;
      m.citable = !hasMixedScriptToken(m.text);
      if (!m.citable) m.whyNot = "mixed_script";
    }
    for (const h of f.hunks) {
      h.id = `H${nextHunk++}`;
      for (const l of h.lines) {
        l.hunk = h.id;
        if (l.kind === "ctx") {
          l.whyNot = "unchanged";
          continue;
        }
        l.id = `L${nextLine++}`;
        const side = l.kind === "del" ? "before" : "after";
        const path = l.kind === "del" ? f.oldPath : f.path;
        l.shownFile = path; // a removed line's number counts in the OLD file; C1' still compares `file`, the diff file's own path
        const inFile = l.no !== undefined && lineOf(side, path, l.no) === l.text ? kindsOf(side, path)?.[l.no - 1] : undefined;
        const kind: LineKind = inFile ?? classifyLine(l.text, f.path);
        if (kind !== "code") l.whyNot = kind;
        else if (hasMixedScriptToken(l.text)) l.whyNot = "mixed_script";
        l.citable = l.whyNot === undefined;
      }
    }
  }
  return diff;
}

export function allLines(diff: ParsedDiff): DiffLine[] {
  return diff.files.flatMap((f) => [...f.meta, ...f.hunks.flatMap((h) => h.lines)]);
}

export function indexById(diff: ParsedDiff): Map<string, DiffLine> {
  const out = new Map<string, DiffLine>();
  for (const l of allLines(diff)) if (l.id) out.set(l.id, l);
  return out;
}

export const hunkIds = (diff: ParsedDiff): Set<string> => new Set(diff.files.flatMap((f) => f.hunks.map((h) => h.id)));

// What the model reads. The id column exists only for changed lines; unchanged context carries none and cannot be cited.
export function renderDiff(diff: ParsedDiff): string {
  const out: string[] = [];
  for (const f of diff.files) {
    out.push(`FILE ${f.path} (${f.status}${f.status === "renamed" ? ` from ${f.oldPath}` : ""})`);
    if (f.binary) out.push("(binary file: not shown)");
    for (const m of f.meta) out.push(`${m.id!.padEnd(6)}R ${m.text}`);
    for (const h of f.hunks) {
      out.push(`HUNK ${h.id}`);
      for (const l of h.lines) out.push(`${(l.id ?? "").padEnd(6)}${l.kind === "add" ? "+" : l.kind === "del" ? "-" : " "} ${l.text}`);
    }
  }
  return out.join("\n");
}
