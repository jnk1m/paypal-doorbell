// Turns raw material into a CauseInput, through the one normalization (hygiene.ts) and nothing else. Two sources:
//   prepareInput    a unified diff text and file trees as strings (the evaluation sets, any future local CLI)
//   shopInput       the demo shop: the build-time diff of lib/shop/diffs.ts and the handler files, plus a symptom class
// Neither takes a free-text field (shop name, order note, customer name): there is no parameter for one (plan 5.4 #6, R8).
import type { DiffBundle } from "../shop/diffs.ts";
import { isPlanted, type PlantedMode } from "../shop/types.ts";
import { isSymptomClass, type SymptomClass } from "./categories.ts";
import { diffFromShop, parseUnifiedDiff } from "./diff.ts";
import { byteLength, InputRejected, LIMITS, normalizeSource, type NormalizeNotes } from "./hygiene.ts";
import type { CauseInput } from "./prompt.ts";

export interface PreparedInput {
  input: CauseInput;
  notes: { diff: NormalizeNotes; files: Record<string, NormalizeNotes> };
}

function normalizeTree(tree: Record<string, string>, notes: Record<string, NormalizeNotes>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [path, text] of Object.entries(tree)) {
    const n = normalizeSource(text);
    out[path] = n.text;
    notes[path] = n.notes;
  }
  return out;
}

export function prepareInput(raw: { diff: string; before?: Record<string, string>; after: Record<string, string>; symptom: SymptomClass }): PreparedInput {
  if (!isSymptomClass(raw.symptom)) throw new InputRejected("empty_diff", "symptom is not one of the classes"); // a class, never a sentence
  if (byteLength(raw.diff) > LIMITS.diffBytes) throw new InputRejected("diff_too_large", `${byteLength(raw.diff)} bytes`);
  const diff = normalizeSource(raw.diff);
  const notes: Record<string, NormalizeNotes> = {};
  const before = raw.before ? normalizeTree(raw.before, {}) : undefined;
  const after = normalizeTree(raw.after, notes);
  const parsed = parseUnifiedDiff(diff.text, { before, after });
  return { input: { diff: parsed, files: Object.entries(after).map(([path, text]) => ({ path, text })), symptom: raw.symptom }, notes: { diff: diff.notes, files: notes } };
}

export function shopInput(mode: PlantedMode, bundle: DiffBundle, symptom: SymptomClass): CauseInput {
  if (!isPlanted(mode)) throw new InputRejected("empty_diff", `mode ${String(mode)} has no diff`);
  if (!isSymptomClass(symptom)) throw new InputRejected("empty_diff", "symptom is not one of the classes");
  const d = bundle.diffs.find((x) => x.mode === mode);
  if (!d) throw new InputRejected("empty_diff", `no diff for mode ${mode}`);
  const before = { [d.from]: normalizeSource(bundle.texts[d.from]).text };
  const after = { [d.to]: normalizeSource(bundle.texts[d.to]).text };
  const normalized = { ...d, hunks: d.hunks.map((h) => ({ ...h, lines: h.lines.map((l) => ({ ...l, text: normalizeSource(l.text).text })) })) };
  return { diff: diffFromShop(normalized, { before, after }), files: Object.entries(after).map(([path, text]) => ({ path, text })), symptom };
}
