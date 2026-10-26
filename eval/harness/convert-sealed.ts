// Converts a sealed set from its author's file shape into the case-folder shape the frozen harness reads (case.ts), without changing
// anything the model sees: before/, after/ and diff.patch are copied byte for byte; only symptom.json and label.json are rewritten.
// The output is a new folder with its own MANIFEST.sha256 (same line format as the sealed ones), so it is sealed by a row in
// SEAL.md before any run. The sealed folders themselves are only read.
//
//   npx tsx eval/harness/convert-sealed.ts --kind ha --from ~/doorbell-eval-sealed/ha --to ~/doorbell-eval-sealed/ha-run
//   npx tsx eval/harness/convert-sealed.ts --kind hb --from ~/doorbell-eval-sealed/hb --sub nocomment --symptoms <id-to-class.json> \
//       --to ~/doorbell-eval-sealed/hb-nocomment-run
//
// Input shapes (as found on 2026-10-26; the script refuses a case whose shape it does not recognise):
//   ha  <from>/cases/<id>/{before/, after/, diff.patch, symptom.json, label.json}
//       symptom.json {symptom: <class>, deliveries: {...}}
//       label.json   {category, files[], files_before[], lines[number], lines_before[number], bug_text[string],
//                     bug_locations[{side, file, line, text}], decoy_lines[], mix, stack, notes, line_numbering}
//   hb  <from>/cases/<id>/[<sub>/]{before/, after/, diff.patch, label.json}; no symptom file, so --symptoms gives {id: class}
//       label.json   {id, category, files[], lines[{file, side, line, text}], source{ai_attributed_commit, language, framework, ...}, ...}
// Output label.json {category, file, altFiles, lines, altLines, ...tags}: lines = the cited after-side line texts, altLines = the cited
// before-side texts (the harness accepts either half of a modified line), tags = mix and stack (ha) or ai_attributed_commit and stack
// (hb). The author's notes and decoys never leave the sealed folder. Every cited text must be a changed line of diff.patch, or the
// script stops. Output symptom.json is {class}.
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const CATEGORIES = ["RAW_BODY_ALTERED", "WRONG_WEBHOOK_ID", "WORK_AFTER_ACK", "EVENT_TYPE_DROPPED", "APP_OR_ENV_MISMATCH", "ENDPOINT_PATH_CHANGED", "OTHER_CODE_CHANGE", "NOT_IN_DIFF"];
const CLASSES = ["all_401", "2xx_but_books_unchanged", "404_or_no_arrival", "other"];

export interface OutLabel { category: string; file: string | null; altFiles: string[]; lines: string[]; altLines: string[]; [tag: string]: unknown }

const nline = (s: unknown) => String(s ?? "").replace(/^[+-]\s?/, "").replace(/\s+/g, " ").trim();
const uniq = (xs: string[]) => [...new Set(xs)];

// The changed lines of a unified diff, normalised like the harness's score.ts does.
export function changedLines(diff: string): Set<string> {
  const out = new Set<string>();
  for (const l of diff.split("\n")) if ((l.startsWith("+") && !l.startsWith("+++")) || (l.startsWith("-") && !l.startsWith("---"))) out.add(nline(l));
  return out;
}

export function convertHaLabel(l: Record<string, any>): OutLabel {
  const need = ["category", "files", "files_before", "lines", "bug_text", "bug_locations", "mix", "stack"];
  for (const k of need) if (!(k in l)) throw new Error(`label.json lacks ${k}`);
  if (!CATEGORIES.includes(l.category)) throw new Error(`category ${JSON.stringify(l.category)} is not one of the 8`);
  const locs = l.bug_locations as { side: string; file: string; text: string }[];
  const afterTexts = locs.filter((b) => b.side === "after").map((b) => String(b.text));
  const beforeTexts = locs.filter((b) => b.side === "before").map((b) => String(b.text));
  const bugText = (l.bug_text as unknown[]).map(String);
  if (bugText.length !== afterTexts.length || bugText.some((t, i) => t !== afterTexts[i])) throw new Error("bug_text and the after-side bug_locations disagree");
  const files = (l.files as string[]).map(String);
  const filesBefore = (l.files_before as string[]).map(String);
  if (l.category === "NOT_IN_DIFF") {
    if (files.length || filesBefore.length || bugText.length || beforeTexts.length) throw new Error("NOT_IN_DIFF with a citation");
    return { category: l.category, file: null, altFiles: [], lines: [], altLines: [], mix: l.mix, stack: l.stack };
  }
  if (bugText.length + beforeTexts.length === 0) throw new Error("a cause category without a cited line");
  const file = files[0] ?? filesBefore[0] ?? null;
  const altFiles = uniq([...files, ...filesBefore]).filter((f) => f !== file);
  return { category: l.category, file, altFiles, lines: uniq(bugText), altLines: uniq(beforeTexts).filter((t) => !bugText.includes(t)), mix: l.mix, stack: l.stack };
}

// `attributed`: the co-author flag when the label itself lacks it (the twin's label may), from the nocomment label of the same id.
export function convertHbLabel(l: Record<string, any>, attributed?: boolean): OutLabel {
  for (const k of ["category", "files", "lines"]) if (!(k in l)) throw new Error(`label.json lacks ${k}`);
  if (!CATEGORIES.includes(l.category)) throw new Error(`category ${JSON.stringify(l.category)} is not one of the 8`);
  const lines = l.lines as { file: string; side: string; text: string }[];
  for (const x of lines) if (!["after", "before"].includes(x.side) || typeof x.text !== "string" || typeof x.file !== "string") throw new Error("lines[] entry is not {file, side, text}");
  const after = lines.filter((x) => x.side === "after");
  const before = lines.filter((x) => x.side === "before");
  const src = (l.source ?? {}) as Record<string, unknown>;
  const ai = l.ai_attributed_commit ?? src.ai_attributed_commit ?? attributed;
  if (typeof ai !== "boolean") throw new Error("ai_attributed_commit is not a boolean (needed for the pre-registered H-b split)");
  const tags = { ai_attributed_commit: ai, stack: String(src.framework ?? src.language ?? l.stack ?? "") };
  if (l.category === "NOT_IN_DIFF") return { category: l.category, file: null, altFiles: [], lines: [], altLines: [], ...tags };
  if (lines.length === 0) throw new Error("a cause category without a cited line");
  const file = after[0]?.file ?? before[0].file;
  const altFiles = uniq([...lines.map((x) => x.file), ...(l.files as string[]).map(String)]).filter((f) => f !== file);
  const afterTexts = uniq(after.map((x) => x.text));
  return { category: l.category, file, altFiles, lines: afterTexts, altLines: uniq(before.map((x) => x.text)).filter((t) => !afterTexts.includes(t)), ...tags };
}

function copyTree(from: string, to: string): number {
  let n = 0;
  mkdirSync(to, { recursive: true });
  for (const d of readdirSync(from, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const src = join(from, d.name);
    if (lstatSync(src).isSymbolicLink()) throw new Error(`${src} is a symbolic link; not followed`);
    if (d.isDirectory()) n += copyTree(src, join(to, d.name));
    else {
      copyFileSync(src, join(to, d.name));
      n++;
    }
  }
  return n;
}

const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");

// MANIFEST.sha256 in the sealed sets' format: "<sha256>  <relative path>", byte-ordered, no "./", every file but the manifest itself.
export function writeManifest(root: string): { sha256: string; files: number } {
  const rels: string[] = [];
  const walk = (dir: string) => {
    for (const d of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, d.name);
      if (d.isDirectory()) walk(full);
      else {
        const rel = relative(root, full).split(sep).join("/");
        if (rel !== "MANIFEST.sha256") rels.push(rel);
      }
    }
  };
  walk(root);
  rels.sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  const text = rels.map((rel) => `${sha256(readFileSync(join(root, rel)))}  ${rel}\n`).join("");
  writeFileSync(join(root, "MANIFEST.sha256"), text);
  return { sha256: sha256(Buffer.from(text)), files: rels.length };
}

export function convertSet(o: { kind: "ha" | "hb"; from: string; to: string; sub?: string; symptoms?: Record<string, string>; attributed?: Record<string, boolean> }): { cases: number; manifest: { sha256: string; files: number }; lines: string[] } {
  const from = resolve(o.from), to = resolve(o.to);
  if (to === from || to.startsWith(`${from}${sep}`)) throw new Error("refusing: --to lies inside --from (a sealed folder is only read)");
  if (existsSync(to) && readdirSync(to).length) throw new Error(`refusing: ${to} exists and is not empty`);
  const casesDir = join(from, "cases");
  if (!existsSync(casesDir)) throw new Error(`${casesDir} does not exist`);
  const ids = readdirSync(casesDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
  if (ids.length === 0) throw new Error(`no case folders under ${casesDir}`);
  const log: string[] = [];
  for (const id of ids) {
    const src = o.sub ? join(casesDir, id, o.sub) : join(casesDir, id);
    for (const need of ["before", "after", "diff.patch", "label.json"]) if (!existsSync(join(src, need))) throw new Error(`case ${id}: ${need} is missing in ${src}`);
    const raw = JSON.parse(readFileSync(join(src, "label.json"), "utf8"));
    let label: OutLabel, cls: string;
    try {
      if (o.kind === "ha") {
        label = convertHaLabel(raw);
        const s = JSON.parse(readFileSync(join(src, "symptom.json"), "utf8"));
        cls = String(s.symptom ?? "");
      } else {
        label = convertHbLabel(raw, o.attributed?.[id]);
        cls = String(o.symptoms?.[id] ?? "");
      }
    } catch (e) {
      throw new Error(`case ${id}: ${(e as Error).message}`);
    }
    if (!CLASSES.includes(cls)) throw new Error(`case ${id}: symptom class ${JSON.stringify(cls)} is not one of the product classes`);
    const diff = readFileSync(join(src, "diff.patch"), "utf8");
    const changed = changedLines(diff);
    for (const t of [...label.lines, ...label.altLines]) if (!changed.has(nline(t))) throw new Error(`case ${id}: a cited line is not a changed line of diff.patch`);
    const dst = join(to, id);
    mkdirSync(dst, { recursive: true });
    const n = copyTree(join(src, "before"), join(dst, "before")) + copyTree(join(src, "after"), join(dst, "after"));
    copyFileSync(join(src, "diff.patch"), join(dst, "diff.patch"));
    // "class" is what the harness reads (case.ts); "symptom" is what the sealed B2 command-line baseline reads. Same value.
    writeFileSync(join(dst, "symptom.json"), `${JSON.stringify({ class: cls, symptom: cls }, null, 2)}\n`);
    writeFileSync(join(dst, "label.json"), `${JSON.stringify(label, null, 2)}\n`);
    log.push(`${id.padEnd(12)} ${label.category.padEnd(22)} ${cls.padEnd(24)} lines ${label.lines.length}+${label.altLines.length}  tree files ${n}`);
  }
  return { cases: ids.length, manifest: writeManifest(to), lines: log };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = (name: string) => {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 ? process.argv[i + 1] : undefined;
  };
  const home = (p: string) => (p.startsWith("~/") ? join(homedir(), p.slice(2)) : p);
  const kind = arg("kind"), from = arg("from"), to = arg("to"), sub = arg("sub"), symptomsFile = arg("symptoms"), attributedFile = arg("attributed");
  if ((kind !== "ha" && kind !== "hb") || !from || !to) {
    console.error("usage: convert-sealed.ts --kind ha|hb --from <sealed set> --to <new folder> [--sub <variant>] [--symptoms <id-to-class.json>] [--attributed <id-to-boolean.json>]");
    process.exit(2);
  }
  const readMap = <T,>(file: string | undefined) => (file ? (JSON.parse(readFileSync(home(file), "utf8")) as Record<string, T>) : undefined);
  const symptoms = readMap<string>(symptomsFile), attributed = readMap<boolean>(attributedFile);
  if (kind === "hb" && !symptoms) {
    console.error("--kind hb needs --symptoms <json {id: class}>: the H-b set carries no symptom file");
    process.exit(2);
  }
  const r = convertSet({ kind, from: home(from), to: home(to), ...(sub ? { sub } : {}), ...(symptoms ? { symptoms } : {}), ...(attributed ? { attributed } : {}) });
  for (const l of r.lines) console.log(l);
  console.log(`${r.cases} cases written to ${home(to)}; MANIFEST.sha256 sha256 ${r.manifest.sha256}, ${r.manifest.files} files, ${new Date().toISOString()}`);
}
