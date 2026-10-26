// The fix step's edit format, and the code that applies and checks it (phase-1 spike of "prove the fix").
//
// The model never writes a file and never writes a diff. It answers with a short list of edits keyed to the ids of the diff it was shown
// (the same L-ids the cause step cites, lib/cause/diff.ts). Four operations:
//   replace       id = an ADDED line that the cause cited   -> that line becomes `lines` (at least one)
//   delete        id = an ADDED line that the cause cited   -> that line is removed
//   restore       id = a REMOVED line of the bad deploy     -> that exact line (text taken from the diff, not from the model) is put back where it was
//   insert_after  id = any changed line                     -> `lines` are inserted right after it (after the place a removed line used to be)
// Everything else in the bad file -- context lines, and every added line the cause did NOT cite -- cannot be touched by an edit. That is what
// keeps a harmless feature that was shipped in the same deploy ("keep the feature"): a plain revert of the hunk cannot do that.
//
// Checks here are code, not model: the ids exist, the targets are allowed, the text is plain ASCII, and after the edits are applied the
// result is compared with the bad file again, independently of how it was built (keptUncited, insideHunks).
import { z } from "zod";
import { diffFiles, splitLines } from "../shop/diffs.ts";
import type { DiffLine, ParsedDiff } from "../cause/diff.ts";

export const OPS = ["replace", "delete", "restore", "insert_after"] as const;
export type Op = (typeof OPS)[number];

// Plain types only, like the cause output: an answer that is out of shape fails a check; it must not make the structured-output schema unusable.
export const Edit = z.object({ op: z.enum(OPS), id: z.string(), lines: z.array(z.string()) });
export const FixOutput = z.object({ edits: z.array(Edit) });
export type Edit = z.infer<typeof Edit>;
export type FixOutput = z.infer<typeof FixOutput>;

export const EDIT_LIMITS = { edits: 12, charsPerLine: 200, newLines: 30 } as const;

export interface ChangedLine {
  id: string;
  kind: "add" | "del";
  text: string;
  hunk: string;
  // add: its line number in the bad file. del: the number of the bad-file line after which it sat (0 = the top of the file).
  no: number;
  order: number; // position in the diff, over all lines, context included
}

// Every changed line of the diff by id. The diff is the one the model was shown; the shop's diff has exactly one file.
export function indexChanged(diff: ParsedDiff): Map<string, ChangedLine> {
  const out = new Map<string, ChangedLine>();
  let order = 0;
  for (const file of diff.files) {
    for (const hunk of file.hunks) {
      // The gap of a removed line: after the nearest bad-file line before it in the hunk, or (when it opens the hunk) before the nearest one after it.
      const badNo = hunk.lines.map((l) => (l.kind === "del" ? undefined : l.no));
      hunk.lines.forEach((l: DiffLine, i) => {
        order++;
        if (!l.id || (l.kind !== "add" && l.kind !== "del")) return;
        let no: number;
        if (l.kind === "add") no = l.no!;
        else {
          const before = badNo.slice(0, i).reverse().find((n) => n !== undefined);
          const after = badNo.slice(i + 1).find((n) => n !== undefined);
          no = before !== undefined ? before : after !== undefined ? after - 1 : 0;
        }
        out.set(l.id, { id: l.id, kind: l.kind, text: l.text, hunk: hunk.id, no, order });
      });
    }
  }
  return out;
}

export type EditProblemCode =
  | "no_edits"
  | "too_many_edits"
  | "too_many_new_lines"
  | "bad_line_text" // not printable ASCII, too long, or it holds a line break
  | "unknown_id"
  | "target_not_allowed" // replace/delete of a line the cause did not cite, or of a line that is not an added line
  | "restore_not_removed" // restore of a line that was not removed by the deploy
  | "replace_without_text"
  | "insert_without_text"
  | "duplicate_target"
  | "apply_conflict";

export interface EditProblem {
  code: EditProblemCode;
  edit?: number; // index in the list
  detail?: string;
}

const PLAIN = /^[\x20-\x7e]*$/;

// Validation of the list itself, before anything is applied.
export function validateEdits(edits: Edit[], index: Map<string, ChangedLine>, cited: ReadonlySet<string>): EditProblem[] {
  const problems: EditProblem[] = [];
  if (edits.length === 0) return [{ code: "no_edits" }];
  if (edits.length > EDIT_LIMITS.edits) problems.push({ code: "too_many_edits", detail: `${edits.length}` });
  const newLines = edits.reduce((n, e) => n + (e.op === "replace" || e.op === "insert_after" ? e.lines.length : 0), 0);
  if (newLines > EDIT_LIMITS.newLines) problems.push({ code: "too_many_new_lines", detail: `${newLines}` });
  const used = new Set<string>();
  edits.forEach((e, i) => {
    if (e.lines.some((l) => !PLAIN.test(l) || l.length > EDIT_LIMITS.charsPerLine)) problems.push({ code: "bad_line_text", edit: i });
    const target = index.get(e.id);
    if (!target) {
      problems.push({ code: "unknown_id", edit: i, detail: e.id.slice(0, 20) });
      return;
    }
    const key = `${e.op === "insert_after" ? "ins" : e.op === "restore" ? "res" : "mod"}:${e.id}`;
    if (used.has(key)) problems.push({ code: "duplicate_target", edit: i, detail: e.id });
    used.add(key);
    if (e.op === "replace" || e.op === "delete") {
      if (target.kind !== "add" || !cited.has(e.id)) problems.push({ code: "target_not_allowed", edit: i, detail: `${e.op} ${e.id}` });
      if (e.op === "replace" && e.lines.length === 0) problems.push({ code: "replace_without_text", edit: i });
    } else if (e.op === "restore") {
      if (target.kind !== "del") problems.push({ code: "restore_not_removed", edit: i, detail: e.id });
    } else if (e.lines.length === 0) problems.push({ code: "insert_without_text", edit: i });
  });
  // replace/delete of one line, or the same line twice
  const mods = edits.filter((e) => e.op === "replace" || e.op === "delete").map((e) => e.id);
  if (new Set(mods).size !== mods.length) problems.push({ code: "apply_conflict", detail: "one line is both replaced and deleted, or edited twice" });
  return problems;
}

// Applies validated edits to the bad file's text. Pure; the result is checked again by keptUncited and insideHunks.
export function applyEdits(bad: string, index: Map<string, ChangedLine>, edits: Edit[]): string {
  const lines = splitLines(bad);
  const changed = new Map<number, string[] | null>(); // bad-file line number -> replacement lines (null = deleted)
  const inserted = new Map<number, { order: number; lines: string[] }[]>(); // gap -> pieces
  const insert = (gap: number, order: number, text: string[]) => inserted.set(gap, [...(inserted.get(gap) ?? []), { order, lines: text }]);
  for (const e of edits) {
    const t = index.get(e.id)!;
    if (e.op === "replace") changed.set(t.no, e.lines);
    else if (e.op === "delete") changed.set(t.no, null);
    else if (e.op === "restore") insert(t.no, t.order, [t.text]);
    else insert(t.no, t.order + 0.5, e.lines);
  }
  const out: string[] = [];
  for (let gap = 0; gap <= lines.length; gap++) {
    for (const piece of (inserted.get(gap) ?? []).sort((a, b) => a.order - b.order)) out.push(...piece.lines);
    if (gap < lines.length) {
      const c = changed.get(gap + 1);
      if (c === undefined) out.push(lines[gap]);
      else if (c !== null) out.push(...c);
    }
  }
  return `${out.join("\n")}\n`;
}

export type PatchProblemCode = "uncited_line_changed" | "edit_outside_hunks";
export interface PatchProblem {
  code: PatchProblemCode;
  detail?: string;
}

// Independent of how the patch was built: every line of the bad file except the cited added lines must still be there, byte for byte and
// in the same order (a subsequence of the patched file). This is the "keep the feature" check.
export function keptUncited(bad: string, patched: string, index: Map<string, ChangedLine>, cited: ReadonlySet<string>): PatchProblem[] {
  const citedNos = new Set([...cited].map((id) => index.get(id)).filter((l): l is ChangedLine => l?.kind === "add").map((l) => l.no));
  const protectedLines = splitLines(bad)
    .map((text, i) => ({ text, no: i + 1 }))
    .filter((l) => !citedNos.has(l.no));
  const have = splitLines(patched);
  let at = 0;
  for (const l of protectedLines) {
    while (at < have.length && have[at] !== l.text) at++;
    if (at >= have.length) return [{ code: "uncited_line_changed", detail: `line ${l.no} of the bad file: ${l.text.trim().slice(0, 80)}` }];
    at++;
  }
  return [];
}

// Independent of how the patch was built: diffing the patched file against the bad file, every removed line must be a cited added line and
// every inserted line must sit in a place the bad deploy's own diff covers (inside one of its hunks, context included).
export function insideHunks(bad: string, patched: string, diff: ParsedDiff, index: Map<string, ChangedLine>, cited: ReadonlySet<string>): PatchProblem[] {
  const problems: PatchProblem[] = [];
  const covered: [number, number][] = [];
  for (const f of diff.files) {
    for (const h of f.hunks) {
      const nos = h.lines.filter((l) => l.kind !== "del").map((l) => l.no!);
      const gaps = [...index.values()].filter((l) => l.hunk === h.id && l.kind === "del").map((l) => l.no);
      const lo = Math.min(...nos, ...gaps.map((g) => g + 1));
      const hi = Math.max(...nos, ...gaps);
      covered.push([lo - 1, hi]); // a gap g (insert after line g) is inside [lo-1, hi]
    }
  }
  const citedNos = new Set([...cited].map((id) => index.get(id)).filter((l): l is ChangedLine => l?.kind === "add").map((l) => l.no));
  const hunks = diffFiles("bad", "patched", bad, patched);
  let addedBefore = 0; // lines added by the patch so far, to turn a patched-file number into a bad-file gap
  let removedBefore = 0;
  for (const h of hunks) {
    for (const l of h.lines) {
      const n = Number(/:(\d+)$/.exec(l.id)![1]);
      if (l.kind === "del") {
        removedBefore++;
        if (!citedNos.has(n)) problems.push({ code: "edit_outside_hunks", detail: `removed line ${n} of the bad file was not a cited added line` });
      } else if (l.kind === "add") {
        const gap = n - 1 - addedBefore + removedBefore; // bad-file lines that precede it
        addedBefore++;
        if (!covered.some(([lo, hi]) => gap >= lo && gap <= hi)) problems.push({ code: "edit_outside_hunks", detail: `a line was inserted after line ${gap} of the bad file, outside the deploy's hunks` });
      }
    }
  }
  return problems;
}
