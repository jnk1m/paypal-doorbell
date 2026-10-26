// Text with two kinds of emphasis and the glossary words, as data. A sentence is written once as a string with **bold** and ==highlight==
// markers; planRich() cuts it into runs and hands each run's words to the page's TermPlanner (lib/ui/glossary.ts), so the first occurrence
// of a glossary word on the page carries its explanation whatever style it sits in. A text that is not eligible for explained words (the
// path panel, a label, a variant that replaces another) is planned with no planner and stays plain.
import type { Piece, TermPlanner } from "./glossary.ts";

export type Style = "b" | "hl" | null;
export interface Run {
  style: Style;
  pieces: Piece[];
}
export type Rich = Run[];

const MARK = /(\*\*[^*]+\*\*|==[^=]+==)/;

export function parseMarkup(s: string): { style: Style; text: string }[] {
  return s
    .split(MARK)
    .filter((part) => part !== "")
    .map((part) => (part.startsWith("**") ? { style: "b" as const, text: part.slice(2, -2) } : part.startsWith("==") ? { style: "hl" as const, text: part.slice(2, -2) } : { style: null, text: part }));
}

export function planRich(planner: TermPlanner | null, s: string): Rich {
  return parseMarkup(s).map((r) => ({ style: r.style, pieces: planner ? planner.text(r.text) : [r.text] }));
}

export const plainRich = (s: string): Rich => planRich(null, s);

export const richText = (r: Rich): string => r.map((run) => run.pieces.map((p) => (typeof p === "string" ? p : p.text)).join("")).join("");
