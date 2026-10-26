// Runs the sealed B2 baseline as what it is: a command-line program ("node b2.mjs <case-dir>", one JSON line out), on the same case
// folders the harness reads, scores its answer with the frozen scorer (score.ts), and writes the rows into a copy of a results.json
// from run.ts as perCase[].B2, so that verdict.ts can read them (it needs the model's runs and the baseline in one file). run.ts
// imports a --b2 module; b2.mjs exports nothing, so this runner spawns it instead. Deterministic, no model, no network.
//
//   npx tsx eval/harness/b2-run.ts --sealed ha-run,b2 --b2 ~/doorbell-eval-sealed/b2/b2.mjs --merge eval/runs/sealed-ha/results.json --out eval/runs/sealed-ha/results+b2.json
//   npx tsx eval/harness/b2-run.ts --set eval/dev --b2 <module outside the sealed folder> [--cases a,b] [--merge …] --out <file>
//
// Same gate as run.ts (sets.ts): a sealed set only after the freeze, the committed-file and the SEAL.md checks; --b2 must lie inside
// the checked b2 set. B2 reads symptom.json's "symptom" key (the converted sets carry it beside "class") and cites line numbers;
// the numbers are turned into the lines' text here, because the scorer compares text. Without --merge the rows are written alone.
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { listCaseDirs, loadCase, type CaseFolder } from "./case.ts";
import { currentFreeze, freezeProblems, productSourceFiles, type Freeze } from "./freeze.ts";
import { gitHead, parseSeal, sealedRootOf, uncommittedProblems } from "./seal.ts";
import { resolveSet } from "./sets.ts";
import { score, type Score, type Shown } from "./score.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const FREEZE_FILE = join(ROOT, "eval/harness/FREEZE.json");
const SEAL_FILE = join(ROOT, "docs/planning/eval/SEAL.md");

export interface B2Row {
  case: string;
  label: string;
  category: string | null;
  file: string | null;
  evidence_line: string;
  lines: string[];
  rule?: string;
  error?: string;
  ms: number;
  score: Score;
}

const lineText = (tree: Record<string, string> | undefined, file: string, n: number): string | undefined => {
  const text = tree?.[file];
  if (text === undefined) return undefined;
  return text.split("\n")[n - 1];
};

// One case: spawn the program, read its one JSON line, map the cited numbers to text, score.
export function runB2Case(c: CaseFolder, b2Path: string, node: string = process.execPath): B2Row {
  const t0 = Date.now();
  const p = spawnSync(node, [b2Path, c.dir], { encoding: "utf8", timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });
  const ms = Date.now() - t0;
  const fail = (error: string): B2Row => ({ case: c.id, label: c.label.category, category: null, file: null, evidence_line: "", lines: [], error, ms, score: score(c.label, { category: null, file: null, lines: [], abstained: false }) });
  if (p.error) return fail(`spawn: ${p.error.message}`);
  if (p.status !== 0) return fail(`exit ${p.status}: ${(p.stderr ?? "").trim().slice(0, 200)}`);
  const last = (p.stdout ?? "").trim().split("\n").filter((l) => l.trim()).pop() ?? "";
  let out: { category?: unknown; file?: unknown; lines?: unknown; lines_before?: unknown; rule?: unknown };
  try {
    out = JSON.parse(last);
  } catch {
    return fail(`no JSON line on stdout: ${last.slice(0, 120)}`);
  }
  const category = typeof out.category === "string" ? out.category : null;
  const file = typeof out.file === "string" ? out.file : null;
  const nums = (x: unknown) => (Array.isArray(x) ? x.filter((n): n is number => typeof n === "number") : []);
  const lines: string[] = [];
  if (file) {
    for (const n of nums(out.lines)) {
      const t = lineText(c.after, file, n) ?? lineText(c.before, file, n);
      if (t !== undefined) lines.push(t);
    }
    for (const n of nums(out.lines_before)) {
      const t = lineText(c.before, file, n) ?? lineText(c.after, file, n);
      if (t !== undefined) lines.push(t);
    }
  }
  const shown: Shown = category === "NOT_IN_DIFF" ? { category: null, file: null, lines: [], abstained: true } : { category: category as Shown["category"], file, lines, abstained: false };
  return { case: c.id, label: c.label.category, category, file, evidence_line: lines[0] ?? "", lines, ...(typeof out.rule === "string" ? { rule: out.rule } : {}), ms, score: score(c.label, shown) };
}

export const runB2 = (cases: CaseFolder[], b2Path: string, node?: string): B2Row[] => cases.map((c) => runB2Case(c, b2Path, node));

// A copy of a run.ts results.json with perCase[].B2 and summary.B2 added. The case sets must be the same; nothing else is touched.
export function mergeB2(results: Record<string, any>, rows: B2Row[], b2: { module: string; sha256: string }): Record<string, any> {
  if (!Array.isArray(results.perCase)) throw new Error("--merge: not a results.json from run.ts (no perCase list)");
  const byId = new Map(rows.map((r) => [r.case, r]));
  const ids = new Set<string>(results.perCase.map((p: { case: string }) => p.case));
  const missing = [...ids].filter((id) => !byId.has(id));
  const extra = rows.filter((r) => !ids.has(r.case)).map((r) => r.case);
  if (missing.length || extra.length) throw new Error(`--merge: the case sets differ (B2 lacks ${missing.join(",") || "none"}; results lack ${extra.join(",") || "none"})`);
  const perCase = results.perCase.map((p: Record<string, unknown>) => {
    const r = byId.get(p.case as string)!;
    return { ...p, B2: { category: r.category, file: r.file, evidence_line: r.evidence_line, ...(r.rule ? { rule: r.rule } : {}), ...(r.error ? { error: r.error } : {}), score: r.score } };
  });
  const summary = { ...(results.summary ?? {}), B2: { category: rows.filter((r) => r.score.cat).length, both: rows.filter((r) => r.score.both).length } };
  return { ...results, summary, perCase, b2 };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = (name: string): string | undefined => {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 ? process.argv[i + 1] : undefined;
  };
  const home = (p: string) => (p.startsWith("~/") ? join(homedir(), p.slice(2)) : p);
  const b2Flag = arg("b2"), out = arg("out");
  if (!b2Flag || !out) {
    console.error("usage: b2-run.ts (--sealed <set>,b2 | --set <dir>) --b2 <b2.mjs> --out <file.json> [--merge <results.json>] [--cases a,b]");
    process.exit(2);
  }
  const freeze = existsSync(FREEZE_FILE) ? (JSON.parse(readFileSync(FREEZE_FILE, "utf8")) as Freeze & { frozenAt: string }) : undefined;
  const problems = freeze ? freezeProblems(freeze, currentFreeze(ROOT)) : ["eval/harness/FREEZE.json does not exist"];
  const homeDir = process.env.HOME ?? homedir();
  const chosen = resolveSet(
    { set: arg("set"), sealed: arg("sealed"), sub: arg("sub"), b2: home(b2Flag) },
    {
      sealedRoot: sealedRootOf(homeDir),
      home: homeDir,
      sealRows: () => parseSeal(readFileSync(SEAL_FILE, "utf8")),
      freezeProblems: () => problems,
      uncommittedProblems: () => uncommittedProblems(["eval/harness/FREEZE.json", "docs/planning/eval/SEAL.md", ...productSourceFiles(ROOT)], (rel) => (existsSync(join(ROOT, rel)) ? readFileSync(join(ROOT, rel)) : null), gitHead(ROOT)),
      log: (line) => console.log(line),
    },
  );
  if (!chosen.b2) throw new Error("--b2 is required");
  if (!chosen.sealed && problems.length) console.warn(`freeze: ${problems.length} difference(s) from eval/harness/FREEZE.json (dev run, continuing)`);
  const only = arg("cases")?.split(",");
  const cases = listCaseDirs(resolve(chosen.setDir)).map(loadCase).filter((c) => !only || only.includes(c.id));
  if (cases.length === 0) throw new Error(`no case folders found under ${chosen.setDir}`);
  const b2Bytes = readFileSync(chosen.b2);
  const b2 = { module: relative(homeDir, chosen.b2).startsWith("..") ? chosen.b2 : `~/${relative(homeDir, chosen.b2)}`, sha256: createHash("sha256").update(b2Bytes).digest("hex") };
  const startedAt = new Date().toISOString();
  const rows = runB2(cases, chosen.b2);
  for (const r of rows) console.log(`${r.case.padEnd(12)} label ${r.label.padEnd(22)} B2 ${(r.category ?? "-").padEnd(22)} cat ${r.score.cat ? "ok" : "--"} ptr ${r.score.pointer ? "ok" : "--"}${r.error ? `  error: ${r.error}` : ""}  ${r.ms} ms`);
  const right = rows.filter((r) => r.score.cat).length, both = rows.filter((r) => r.score.both).length;
  console.log(`B2 on ${rows.length} cases: category ${right}/${rows.length}, category+pointer ${both}/${rows.length}; module ${b2.module} sha256 ${b2.sha256.slice(0, 12)}…`);
  const mergeFile = arg("merge");
  const body = mergeFile
    ? mergeB2(JSON.parse(readFileSync(mergeFile, "utf8")), rows, b2)
    : { startedAt, finishedAt: new Date().toISOString(), sealed: chosen.sealed, set: chosen.sealed ? arg("sealed") : relative(ROOT, chosen.setDir), b2, summary: { cases: rows.length, B2: { category: right, both } }, rows };
  mkdirSync(dirname(resolve(out)), { recursive: true });
  writeFileSync(out, `${JSON.stringify(body, null, 2)}\n`);
  console.log(`wrote ${out}${mergeFile ? ` (a copy of ${mergeFile} with perCase[].B2)` : ""}`);
}
