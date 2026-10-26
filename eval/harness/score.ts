// Scoring (the Gate-3 rule, ported without change of meaning, applied equally to the model path and to B1/B2):
//   cat      the category equals the label's
//   pointer  the file and one cited line match the label (lines compared after trimming and collapsing spaces; a leniency list per case
//            for "the other half of a modified line" or "the same change in its companion file"); for NOT_IN_DIFF a correct abstention counts
//   both     cat and pointer
//
// A product result counts only as what the product would SHOW: "proposed" (it passed C2 and C1'), or an abstention. A right category
// that C1' rejected (a comment cited, an id that is not in the diff) is a miss, because the screen would show "not proven".
import type { CauseResult } from "../../lib/cause/cause.ts";
import type { Category } from "../../lib/cause/categories.ts";
import type { CaseLabel } from "./case.ts";

export interface Score {
  cat: boolean;
  pointer: boolean;
  both: boolean;
}

export interface Shown {
  category: Category | null; // what a screen would show; null = no cause shown
  file: string | null;
  lines: string[];
  abstained: boolean; // NOT_IN_DIFF
}

const nline = (s: unknown) => String(s ?? "").replace(/^[+-]\s?/, "").replace(/\s+/g, " ").trim();

export function score(label: CaseLabel, shown: Shown): Score {
  const cat = label.category === "NOT_IN_DIFF" ? shown.abstained : shown.category === label.category;
  let pointer = false;
  if (label.category === "NOT_IN_DIFF") pointer = cat;
  else if (shown.category !== null) {
    const files = [...(label.file ? [label.file] : []), ...label.altFiles];
    const truths = [...label.lines, ...label.altLines].map(nline);
    const fileOk = shown.file !== null && files.some((f) => shown.file!.endsWith(f) || f.endsWith(shown.file!));
    const lineOk = shown.lines.some((l) => {
      const q = nline(l);
      return q.length >= 8 && truths.some((x) => x === q || (x.length >= 15 && q.includes(x)) || (q.length >= 15 && x.includes(q)));
    });
    pointer = fileOk && lineOk;
  }
  return { cat, pointer, both: cat && pointer };
}

export function shownOf(r: CauseResult): Shown {
  if (r.status === "proposed") return { category: r.category, file: r.file, lines: r.lines.map((l) => l.text), abstained: false };
  return { category: null, file: null, lines: [], abstained: r.status === "not_proven" && r.reason === "model_abstained" };
}

// B1/B2 answer in the Gate-3 shape {category, file, evidence_line}.
export function shownOfBaseline(b: { category: Category; file: string | null; evidence_line: string }): Shown {
  if (b.category === "NOT_IN_DIFF") return { category: null, file: null, lines: [], abstained: true };
  return { category: b.category, file: b.file, lines: [b.evidence_line], abstained: false };
}
