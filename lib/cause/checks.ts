// The checks the model's answer must pass before anything about it reaches a screen (plan 5.4 #2).
//
//   C2  the category does not contradict the symptom class that code computed from the delivery records
//   C1' every cited line is a changed, non-comment code line of THIS diff, found by its id; the file named is that line's file
//
// Both are consistency checks, not proof (J W1): the proof is the replay (C3, replay.ts). The first failed check ends it: the cause is
// "not proven", nothing the model said is shown, and the gap list does not change.
import { CAUSE_TEMPLATE, consistentWith, type Category, type SymptomClass } from "./categories.ts";
import { indexById, type ParsedDiff, type DiffLine } from "./diff.ts";
import { escapeForDisplay } from "./hygiene.ts";
import type { CauseOutput } from "./prompt.ts";

export const MAX_CITED_LINES = 3;
const SHOWN_CHARS = 200;

export type NotProvenReason =
  | "model_abstained" // NOT_IN_DIFF: the model found no changed line that explains it
  | "inconsistent_with_symptom" // C2
  | "no_citation" // C1': a cause with no line
  | "too_many_lines"
  | "unknown_id" // an id that is not in this diff
  | "not_a_changed_line"
  | "comment_line"
  | "blank_line"
  | "string_line"
  | "mixed_script"
  | "file_mismatch";

// A cited line as the screen gets it: looked up in the diff by id, never a string from the model.
export interface EvidenceLine {
  id: string;
  file: string; // the diff file's path (what C1' compared)
  shownFile: string; // the file the line number counts in: the old path for a removed line; this is what the screen shows next to `no`
  kind: "add" | "del" | "rename";
  no?: number;
  text: string; // the normalized line, the one that was compared
  shown: string; // the same, ASCII-escaped and cut for display
}

export type CheckOutcome = { ok: true; category: Exclude<Category, "NOT_IN_DIFF">; file: string; hunkId: string; lines: EvidenceLine[]; explanation: string } | { ok: false; reason: NotProvenReason };

const WHY_NOT: Record<string, NotProvenReason> = { comment: "comment_line", blank: "blank_line", string: "string_line", mixed_script: "mixed_script", unchanged: "not_a_changed_line" };

export function checkCause(out: CauseOutput, diff: ParsedDiff, symptom: SymptomClass): CheckOutcome {
  if (out.category === "NOT_IN_DIFF") return { ok: false, reason: "model_abstained" };
  if (!consistentWith(symptom, out.category)) return { ok: false, reason: "inconsistent_with_symptom" };

  const ids = [...new Set(out.lineIds)];
  if (ids.length === 0) return { ok: false, reason: "no_citation" };
  if (ids.length > MAX_CITED_LINES) return { ok: false, reason: "too_many_lines" };

  const index = indexById(diff);
  const lines: DiffLine[] = [];
  for (const id of ids) {
    const line = index.get(id);
    if (!line) return { ok: false, reason: "unknown_id" };
    if (!line.citable) return { ok: false, reason: WHY_NOT[line.whyNot ?? "unchanged"] ?? "not_a_changed_line" };
    if (line.kind === "ctx") return { ok: false, reason: "not_a_changed_line" };
    lines.push(line);
  }
  // The file the model names must be the file of every cited line. (Only a git "a/" "b/" or "./" prefix is forgiven; what is shown is the diff's own path.)
  const bare = (p: string) => p.replace(/^(\.\/|a\/|b\/)/, "");
  if (lines.some((l) => bare(l.file) !== bare(out.file))) return { ok: false, reason: "file_mismatch" };

  const evidence = lines.map<EvidenceLine>((l) => {
    const text = escapeForDisplay(l.text);
    return { id: l.id!, file: l.file, shownFile: l.shownFile, kind: l.kind as "add" | "del" | "rename", ...(l.no !== undefined ? { no: l.no } : {}), text: l.text, shown: text.length > SHOWN_CHARS ? `${text.slice(0, SHOWN_CHARS)}...` : text };
  });
  // The hunk is the one the first cited line is in, from the diff; the model's own hunk id is not trusted and not shown.
  return { ok: true, category: out.category, file: lines[0].file, hunkId: lines[0].hunk ?? "", lines: evidence, explanation: CAUSE_TEMPLATE[out.category] };
}
