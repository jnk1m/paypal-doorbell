// What "prove the fix" hands to a screen: the fix result of one confirmed code bug (snapshot.ts GapCause.fix).
//
// Everything on a screen about a fix is one of three things: a fixed sentence from this file, a number the code counted, or a line of the
// patch -- shown only as a labelled diff ("proposed by Claude") and only when every check and every control passed. The model's answer is
// edits keyed to the ids of the diff it was shown (edits.ts); it never writes prose that reaches a screen.
//
// This file is pure data and fixed sentences: a deployed function imports it (lib/run/build.ts), so it imports nothing heavy.
import type { PlantedMode } from "../shop/types.ts";

export const FIX_CHECK_IDS = ["edits_valid", "parses", "allowlist", "uncited_kept", "inside_hunks"] as const;
export type FixCheckId = (typeof FIX_CHECK_IDS)[number];

export const FIX_CONTROL_IDS = ["arrival_order", "reversed", "tampered", "paypal_books"] as const;
export type FixControlId = (typeof FIX_CONTROL_IDS)[number];

export const CHECK_LABEL: Record<FixCheckId, string> = {
  edits_valid: "The edits name changed lines of the diff, and replace or delete only lines the cause cited.",
  parses: "The patched file parses.",
  allowlist: "It uses only the imports and names a handler may use.",
  uncited_kept: "Lines of the bad deploy that the cause did not cite are unchanged, byte for byte.",
  inside_hunks: "The edits stay inside the bad deploy's changed hunks.",
};

export const CONTROL_LABEL: Record<FixControlId, string> = {
  arrival_order: "The events in the order they arrived: same answers and same books as the good build.",
  reversed: "The same events, last one first: same answers and same books as the good build.",
  tampered: "One amount in each body changed: 401 and nothing booked, like the good build.",
  paypal_books: "The books equal PayPal's own answer for the order (GET capture).",
};

// How a control is named inside a sentence: "the tampered control".
export const CONTROL_NAME: Record<FixControlId, string> = { arrival_order: "arrival-order", reversed: "reversed", tampered: "tampered", paypal_books: "PayPal's-answer" };

export const BASELINE_LABEL = "The same patch with its signature check removed (written by us)";
export const NOT_PROVEN_FIX_TEXT = "Fix not proven.";

// What a patch leaves behind: the places where the patched file still differs from the shop's last good build. leftovers.ts finds them by
// diffing the two files; a screen turns each into the fixed sentence below. The model's text is never in here: a name is an identifier that
// the code read out of the patched file (plain ASCII, checked by rules.ts), the rest are counts.
export type Leftover =
  | { kind: "comment"; lines: number } // added comment lines: a comment can go on describing code that has changed
  | { kind: "unused"; name: string; declares: "function" | "value" } // a declaration that nothing else in the file uses
  | { kind: "imports" } // the import lines are written differently and name the same things
  | { kind: "other"; added: number; removed: number }; // any other difference, as counts of lines

const plural = (n: number, one: string, many = `${one}s`): string => (n === 1 ? one : many);

export function leftoverText(l: Leftover): string {
  switch (l.kind) {
    case "comment":
      return l.lines === 1 ? "a comment that may no longer match the code" : `${l.lines} comments that may no longer match the code`;
    case "unused":
      return `\u201c${l.name}\u201d, ${l.declares === "function" ? "a function nothing calls" : "a value nothing reads"}`;
    case "imports":
      return "the imports written differently, naming the same things";
    case "other":
      return `${l.added + l.removed} other changed ${plural(l.added + l.removed, "line")} (${l.added} added, ${l.removed} removed)`;
  }
}

// The one line about what a patch leaves behind, and the sentence about what no check of the proof can see.
export const leftoversLine = (items: readonly Leftover[]): string => (items.length === 0 ? "Compared with the shop's last good build, nothing else differs." : `Compared with the shop's last good build, the patch still has: ${items.map(leftoverText).join("; ")}.`);
export const CANNOT_SEE = "The checks do not look at comments or leftover code.";

// The one claim the proof makes. Never "correct": only what was run.
export const claimOf = (orders: number, inputs: number): string => `Behaves like the good build and PayPal's answer on these ${inputs} inputs (${orders} orders x arrival order, reversed, tampered).`;

export interface FixCheckRow {
  id: FixCheckId;
  label: string;
  ok: boolean;
}

export interface FixControlRow {
  id: FixControlId;
  label: string;
  ok: boolean;
  n: number; // deliveries replayed for this control (paypal_books: order outcomes compared); 0 = the control was not run
}

export interface PatchLine {
  kind: "ctx" | "add" | "del";
  text: string; // a line of the bad deploy's file (ctx, del) or of the patched file (ctx, add): plain ASCII
}

// The diff from the bad deploy's file to the patched file, as the owner reviewed it. Hunks are separated: a gap between two hunks is a skip.
export interface PatchView {
  file: string; // the bad deploy's file
  hunks: PatchLine[][];
  added: number;
  removed: number;
}

// The patch with its signature check taken out, run through the same controls: it passes the first controls and fails the tampered one.
export interface FixBaseline {
  id: "skips_signature_check";
  label: string;
  controls: FixControlRow[];
}

export interface FixResult {
  mode: PlantedMode; // the broken mode this fix is for; a fix is never paired with another mode's cause
  causeRequestHash: string; // the cause (lib/cause) this fix answers: both come from the same recorded answer
  fixRequestHash: string; // the recording of the model's edits
  promptVersion: string;
  model: string; // the model id from lib/core/llm.ts MODEL_ID
  source: "recording"; // the edits come from a recorded answer; no model call is ever made at request time
  basis: "replayed" | "recorded"; // the controls: run on this session's own deliveries now, or an earlier run
  recordedAt: number; // when the model's answer was recorded, ms
  ranAt: number; // when the controls ran, ms
  verdict: "proven" | "not_proven";
  claim: string; // claimOf(orders, inputs) when proven, NOT_PROVEN_FIX_TEXT otherwise
  orders: number;
  inputs: number; // deliveries replayed across the arrival-order, reversed and tampered runs
  patchSha256: string; // sha256 of the patched file the owner reviewed (fixtures/fix/patched/<mode>.handler.txt)
  patch: PatchView | null; // only when proven
  checks: FixCheckRow[];
  controls: FixControlRow[];
  baseline: FixBaseline | null; // only when proven
  // What the patched file still has that the shop's last good build does not (leftovers.ts). Only when proven; absent in a result recorded before it
  // existed, and a screen then says only what the checks cannot see.
  leftovers?: Leftover[];
}

export const checkRows = (rows: { id: FixCheckId; ok: boolean }[]): FixCheckRow[] => rows.map((r) => ({ id: r.id, label: CHECK_LABEL[r.id], ok: r.ok }));
export const controlRow = (id: FixControlId, ok: boolean, n: number): FixControlRow => ({ id, label: CONTROL_LABEL[id], ok, n });
