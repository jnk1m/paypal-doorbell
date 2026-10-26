// The cause step's input for one broken deploy of the shop: the three code bugs and the setting bug (types.ts BrokenMode).
//
// lib/cause/input.ts shopInput() builds this for the three code bugs, and lib/cause is frozen for the evaluation (eval/harness/FREEZE.json), so a
// fourth, different kind of mode cannot be added there. This is the same body, over the diffs of all four (bundle.diffs and bundle.settingDiffs).
// deploy-input.test.ts proves it gives shopInput's request, byte for byte, for the three code bugs on every symptom class: if the two ever drift
// apart, the recordings of the three code bugs would no longer be found, and that test fails first.
import { isSymptomClass, type SymptomClass } from "../cause/categories.ts";
import { diffFromShop } from "../cause/diff.ts";
import { InputRejected, normalizeSource } from "../cause/hygiene.ts";
import type { CauseInput } from "../cause/prompt.ts";
import type { DiffBundle, ModeDiff } from "../shop/diffs.ts";
import { isBroken, type BrokenMode } from "../shop/types.ts";

export function deployInput(mode: BrokenMode, bundle: DiffBundle, symptom: SymptomClass): CauseInput {
  if (!isBroken(mode)) throw new InputRejected("empty_diff", `mode ${String(mode)} has no diff`);
  if (!isSymptomClass(symptom)) throw new InputRejected("empty_diff", "symptom is not one of the classes");
  const d = [...bundle.diffs, ...bundle.settingDiffs].find((x) => x.mode === mode);
  if (!d) throw new InputRejected("empty_diff", `no diff for mode ${mode}`);
  const before = { [d.from]: normalizeSource(bundle.texts[d.from]).text };
  const after = { [d.to]: normalizeSource(bundle.texts[d.to]).text };
  // diffFromShop (frozen) is typed for the three code bugs but reads only from, to and hunks; it never looks at the mode.
  const normalized = { mode: d.mode as ModeDiff["mode"], from: d.from, to: d.to, hunks: d.hunks.map((h) => ({ ...h, lines: h.lines.map((l) => ({ ...l, text: normalizeSource(l.text).text })) })) };
  return { diff: diffFromShop(normalized, { before, after }), files: Object.entries(after).map(([path, text]) => ({ path, text })), symptom };
}
