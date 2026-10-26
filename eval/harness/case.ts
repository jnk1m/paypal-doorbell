// A case folder (plan 6.2). One folder per case:
//
//   before/        the tree of the last good version (optional: used to judge removed lines in context)
//   after/         the tree of the first bad version (the files the model reads)
//   diff.patch     the unified diff before -> after (git diff format; renames as "rename from/to")
//   symptom.json   {"class": "all_401" | "2xx_but_books_unchanged" | "404_or_no_arrival" | "other"}
//                  The Gate-3 names (SIG_REJECT_ALL, ACK_BUT_MISSING, TYPE_MISSING, NO_DELIVERY_NONE, NO_DELIVERY_404, OTHER_4XX,
//                  HANDLER_5XX) are accepted under "class" or "symClass" and mapped; a "gate3Class" field, if present, is what B1 is given.
//   label.json     {"category": <one of the 8>, "file": <path or null>, "lines": [<the cause line text>, ...],
//                  "altFiles"?: [...], "altLines"?: [...]}   (also read: truthCategory, truth.{file,lines})
//
// Only these files are read. Nothing in a case folder is a place for free text that reaches the model: the symptom is a class.
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { CATEGORIES, isSymptomClass, type Category, type SymptomClass } from "../../lib/cause/categories.ts";

export interface CaseLabel {
  category: Category;
  file: string | null;
  lines: string[];
  altFiles: string[];
  altLines: string[];
  tags: Record<string, unknown>; // anything else in label.json (hard, tail, stack, ...): kept for subset reports
}

export interface CaseFolder {
  id: string;
  dir: string;
  diff: string;
  before?: Record<string, string>;
  after: Record<string, string>;
  symptom: SymptomClass;
  gate3Class?: string;
  label: CaseLabel;
}

// Gate-3 (dev set) symptom names -> the product's classes.
export const GATE3_CLASS: Record<string, SymptomClass> = {
  SIG_REJECT_ALL: "all_401",
  ACK_BUT_MISSING: "2xx_but_books_unchanged",
  TYPE_MISSING: "2xx_but_books_unchanged",
  NO_DELIVERY_NONE: "404_or_no_arrival",
  NO_DELIVERY_404: "404_or_no_arrival",
  OTHER_4XX: "other",
  HANDLER_5XX: "other",
};
// What B1 (frozen, written against the Gate-3 names) is given when a case has no gate3Class of its own.
export const B1_CLASS: Record<SymptomClass, string> = { all_401: "SIG_REJECT_ALL", "2xx_but_books_unchanged": "ACK_BUT_MISSING", "404_or_no_arrival": "NO_DELIVERY_404", other: "HANDLER_5XX" };

function readTree(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      const st = lstatSync(full);
      if (st.isSymbolicLink()) throw new Error(`case folder: ${full} is a symbolic link; not followed`);
      if (st.isDirectory()) walk(full);
      else if (st.isFile()) out[relative(root, full).split("\\").join("/")] = readFileSync(full, "utf8");
    }
  };
  walk(root);
  return out;
}

const readJson = (file: string): Record<string, any> => {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw new Error(`case folder: ${file} is not valid JSON (${(e as Error).message.slice(0, 100)})`);
  }
};

export function loadCase(dir: string): CaseFolder {
  const id = dir.replace(/\/+$/, "").split("/").pop()!;
  for (const need of ["after", "diff.patch", "symptom.json", "label.json"]) if (!existsSync(join(dir, need))) throw new Error(`case ${id}: ${need} is missing in ${dir}`);

  const s = readJson(join(dir, "symptom.json"));
  const raw = String(s.class ?? s.symClass ?? s.symptom_class ?? "");
  const symptom = isSymptomClass(raw) ? raw : GATE3_CLASS[raw];
  if (!symptom) throw new Error(`case ${id}: symptom.json has no known class (got ${JSON.stringify(raw)}; expected one of the product classes or a Gate-3 name)`);

  const l = readJson(join(dir, "label.json"));
  const category = String(l.category ?? l.truthCategory ?? "");
  if (!(CATEGORIES as readonly string[]).includes(category)) throw new Error(`case ${id}: label.json category ${JSON.stringify(category)} is not one of the 8 categories`);
  const truth = (l.truth ?? {}) as { file?: string | null; lines?: string[] };
  const {
    category: _c, truthCategory: _t, truth: _tr, file, lines, altFiles, altLines, ...tags
  } = l;
  return {
    id,
    dir,
    diff: readFileSync(join(dir, "diff.patch"), "utf8"),
    before: existsSync(join(dir, "before")) ? readTree(join(dir, "before")) : undefined,
    after: readTree(join(dir, "after")),
    symptom,
    gate3Class: typeof s.gate3Class === "string" ? s.gate3Class : GATE3_CLASS[raw] ? raw : undefined,
    label: {
      category: category as Category,
      file: (file ?? truth.file ?? null) as string | null,
      lines: (lines ?? truth.lines ?? []) as string[],
      altFiles: (altFiles ?? []) as string[],
      altLines: (altLines ?? []) as string[],
      tags,
    },
  };
}

export function listCaseDirs(root: string): string[] {
  return readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(root, d.name, "label.json")))
    .map((d) => join(root, d.name))
    .sort();
}
