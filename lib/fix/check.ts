// All the code checks a model's edits pass before anything is replayed. They are code, not model, and a patch is shown only when all of them
// pass (DO NOT CHANGE 1, amended 10-20):
//   edits_valid   the edit list is valid: ids exist, targets are allowed, plain ASCII, limits (edits.ts)
//   parses        the edits apply and the patched file parses
//   allowlist     it imports only what a handler may import, exports what the shop needs, reaches for nothing outside ctx (allowlist.ts)
//   uncited_kept  every line of the bad deploy that the cause did not cite is still there, byte for byte and in order ("keep the feature")
//   inside_hunks  the patch stays inside the bad deploy's hunks
// A check that cannot be evaluated because an earlier one failed counts as failed.
import type { ParsedDiff } from "../cause/diff.ts";
import { checkAllowlist, referencedNames, type AllowlistProblem } from "./allowlist.ts";
import { applyEdits, indexChanged, insideHunks, keptUncited, validateEdits, type ChangedLine, type Edit, type EditProblem, type PatchProblem } from "./edits.ts";
import type { FixCheckId } from "./types.ts";

// What the checks work on: the diff the cause step read, its changed lines by id, and the bad file (normalized like the cause step does).
export interface FixTarget {
  diff: ParsedDiff;
  index: Map<string, ChangedLine>;
  bad: string;
}

export const fixTarget = (diff: ParsedDiff, bad: string): FixTarget => ({ diff, bad, index: indexChanged(diff) });

export interface FixCheckResult {
  ok: boolean;
  patched?: string;
  rows: { id: FixCheckId; ok: boolean }[];
  edits: EditProblem[];
  allowlist: AllowlistProblem[];
  patch: PatchProblem[];
}

export function checkFix(t: FixTarget, cited: ReadonlySet<string>, edits: Edit[]): FixCheckResult {
  const editProblems = validateEdits(edits, t.index, cited);
  if (editProblems.length) {
    return { ok: false, rows: (["edits_valid", "parses", "allowlist", "uncited_kept", "inside_hunks"] as const).map((id) => ({ id, ok: false })), edits: editProblems, allowlist: [], patch: [] };
  }
  const patched = applyEdits(t.bad, t.index, edits);
  const allowlist = checkAllowlist(patched, referencedNames(t.bad));
  const parses = !allowlist.some((a) => a.code === "syntax_error");
  const kept = keptUncited(t.bad, patched, t.index, cited);
  const inside = insideHunks(t.bad, patched, t.diff, t.index, cited);
  const rows = [
    { id: "edits_valid" as const, ok: true },
    { id: "parses" as const, ok: parses },
    { id: "allowlist" as const, ok: parses && allowlist.length === 0 },
    { id: "uncited_kept" as const, ok: kept.length === 0 },
    { id: "inside_hunks" as const, ok: inside.length === 0 },
  ];
  return { ok: rows.every((r) => r.ok), patched, rows, edits: [], allowlist, patch: [...kept, ...inside] };
}

// Fixed sentences for the log, built from codes and ids, never from model text.
export function problemSentences(r: FixCheckResult): string[] {
  const out: string[] = [];
  const edit = (e: EditProblem): string => {
    const at = e.edit !== undefined ? `Edit ${e.edit + 1}: ` : "";
    switch (e.code) {
      case "no_edits": return "The list of edits was empty.";
      case "too_many_edits": return `Too many edits (${e.detail}).`;
      case "too_many_new_lines": return `Too many new lines (${e.detail}).`;
      case "bad_line_text": return `${at}a line is not plain ASCII, is longer than 200 characters, or holds a line break.`;
      case "unknown_id": return `${at}the id ${e.detail} is not a changed line of the diff.`;
      case "target_not_allowed": return `${at}"${e.detail}" is not allowed: replace and delete work only on added lines that the cause cited.`;
      case "restore_not_removed": return `${at}${e.detail} is not a removed line, so it cannot be restored.`;
      case "replace_without_text": return `${at}replace needs at least one line of text.`;
      case "insert_without_text": return `${at}insert_after needs at least one line of text.`;
      case "duplicate_target": return `${at}${e.detail} is edited twice in the same way.`;
      default: return `${at}the edits conflict (${e.detail ?? e.code}).`;
    }
  };
  out.push(...r.edits.map(edit));
  for (const a of r.allowlist) {
    if (a.code === "syntax_error") out.push(`The patched file does not parse (${a.detail}).`);
    else if (a.code === "denied_name") out.push(`The patched file uses "${a.detail}", which a handler may never use.`);
    else if (a.code === "unknown_global") out.push(`The patched file uses "${a.detail}", which is neither in the file already nor on the list of things a handler may use.`);
    else if (a.code === "import_not_allowed") out.push(`The patched file has an import a handler may not have (${a.detail}).`);
    else if (a.code === "duplicate_binding") out.push(`The patched file imports "${a.detail}" twice.`);
    else if (a.code === "missing_export") out.push(`The patched file no longer exports ${a.detail}.`);
    else out.push(`The patched file failed the allowlist check (${a.code}: ${a.detail}).`);
  }
  for (const p of r.patch) out.push(p.code === "uncited_line_changed" ? `A line of the bad deploy that was not cited would no longer be there unchanged (${p.detail}).` : `The patch reaches outside the bad deploy's hunks (${p.detail}).`);
  return out;
}
