// The evaluation harness (R21, plan 6). It imports the PRODUCT cause module (lib/cause/cause.ts: the request builder, callLlm, C2, C1')
// and nothing else makes a model call or a verdict, so a harness number is a product number. It adds only: case loading, repetition,
// scoring against the label, the B1/B2 baselines, and a spend ledger with a hard stop.
//
//   npx tsx eval/harness/run.ts --set eval/dev [--cases C1a,Z] [--runs 3] [--out eval/runs/<name>] [--max-usd 3] [--b2 path.mjs]
//   npx tsx eval/harness/run.ts --set <dir> --validate          reads the cases and builds the requests; no model call, no spend
//   npx tsx eval/harness/run.ts --freeze                        writes eval/harness/FREEZE.json (do this, and commit it, before a sealed run)
//   npx tsx eval/harness/run.ts --sealed ha                     a sealed set: SEAL.md hash check and FREEZE.json must both pass first
//
// Infrastructure failures (network, timeout, 429, 5xx) are re-run with the SAME request, up to --retry-infra times
// (default 2); the number that failed on the first attempt is reported. Nothing about the prompt or the input changes between attempts.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { diagnose, type CauseResult } from "../../lib/cause/cause.ts";
import { spendCapGate } from "../../lib/cause/gate.ts";
import { prepareInput } from "../../lib/cause/input.ts";
import { buildRequest } from "../../lib/cause/prompt.ts";
import { costUsd, LLM_PARAMS, type LlmUsage } from "../../lib/core/llm.ts";
import { loadEnv } from "../../scripts/env.ts";
import { baselineCause } from "../baseline/B1.mjs";
import { B1_CLASS, listCaseDirs, loadCase, type CaseFolder } from "./case.ts";
import { currentFreeze, freezeProblems, productSourceFiles, type Freeze } from "./freeze.ts";
import { gitHead, parseSeal, sealedRootOf, uncommittedProblems } from "./seal.ts";
import { resolveSet } from "./sets.ts";
import { score, shownOf, shownOfBaseline, type Score, type Shown } from "./score.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const FREEZE_FILE = join(ROOT, "eval/harness/FREEZE.json");
const SEAL_FILE = join(ROOT, "docs/planning/eval/SEAL.md");
// Only failures of the transport are re-run: the call did not get an answer to judge. An unreadable or empty answer (bad_json, empty) is what the
// product would show, "not diagnosed", so it is a result and is counted as one.
const INFRA = new Set(["timeout", "network", "rate_limited", "upstream_error"]);

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const flag = (name: string) => process.argv.includes(`--${name}`);

interface RunRecord {
  case: string;
  run: number;
  status: CauseResult["status"];
  reason?: string;
  category?: string;
  shown: Shown;
  score: Score;
  attempts: number; // 1 = no infrastructure retry
  firstAttemptFailed: boolean;
  usage: LlmUsage;
  usd: number;
  ms: number;
  requestHash: string;
  raw?: unknown; // the model's own output (from the recording), for audit only
}

async function main() {
  loadEnv(); // ANTHROPIC_API_KEY from the main repo .env (never printed)
  if (flag("freeze")) {
    const f = currentFreeze(ROOT);
    writeFileSync(FREEZE_FILE, `${JSON.stringify({ frozenAt: new Date().toISOString(), ...f }, null, 2)}\n`);
    console.log(`wrote ${FREEZE_FILE}: prompt ${f.promptVersion}, model ${f.modelId}, B1 md5 ${f.b1Md5}, ${Object.keys(f.productSources).length} product files`);
    return;
  }

  // 1. The set. resolveSet (sets.ts) decides which folder may be read: a development folder by --set (never one inside the sealed folder),
  // or sealed sets by --sealed after the freeze, the committed-file and the SEAL.md hash checks. --validate goes through the same gate.
  const freeze = existsSync(FREEZE_FILE) ? (JSON.parse(readFileSync(FREEZE_FILE, "utf8")) as Freeze & { frozenAt: string }) : undefined;
  const problems = freeze ? freezeProblems(freeze, currentFreeze(ROOT)) : ["eval/harness/FREEZE.json does not exist"];
  const sealedName = arg("sealed");
  const home = process.env.HOME ?? homedir();
  const chosen = resolveSet(
    { set: arg("set"), sealed: sealedName, sub: arg("sub"), b2: arg("b2") },
    {
      sealedRoot: sealedRootOf(home),
      home,
      sealRows: () => parseSeal(readFileSync(SEAL_FILE, "utf8")),
      freezeProblems: () => problems,
      uncommittedProblems: () => uncommittedProblems(["eval/harness/FREEZE.json", "docs/planning/eval/SEAL.md", ...productSourceFiles(ROOT)],(rel) => (existsSync(join(ROOT, rel)) ? readFileSync(join(ROOT, rel)) : null), gitHead(ROOT)),
      log: (line) => console.log(line),
    },
  );
  if (!chosen.sealed && problems.length) console.warn(`freeze: ${problems.length} difference(s) from eval/harness/FREEZE.json (dev run, continuing):\n  ${problems.slice(0, 6).join("\n  ")}`);
  const setDir = chosen.setDir;

  const only = arg("cases")?.split(",");
  const cases = listCaseDirs(resolve(setDir)).map(loadCase).filter((c) => !only || only.includes(c.id));
  if (cases.length === 0) throw new Error(`no case folders found under ${setDir}`);

  if (flag("validate")) {
    for (const c of cases) {
      const { input } = prepareInput({ diff: c.diff, before: c.before, after: c.after, symptom: c.symptom });
      const req = buildRequest(input);
      console.log(`${c.id.padEnd(6)} ${c.symptom.padEnd(24)} label ${c.label.category.padEnd(22)} request ${req.prompt.length} chars`);
    }
    console.log(`${cases.length} cases read and turned into requests; no model call was made`);
    return;
  }

  // 2. Run.
  const runs = Number(arg("runs") ?? 1);
  const maxUsd = Number(arg("max-usd") ?? 3);
  const retryInfra = Number(arg("retry-infra") ?? 2);
  const outDir = resolve(arg("out") ?? join(ROOT, "eval/runs", new Date().toISOString().replace(/[:.]/g, "-")));
  mkdirSync(outDir, { recursive: true });
  const startedAt = new Date().toISOString();
  let spent = 0;
  const gate = spendCapGate(maxUsd);
  const queue = cases.flatMap((c) => Array.from({ length: runs }, (_, r) => ({ c, r })));
  const records: RunRecord[] = [];

  const one = async (c: CaseFolder, run: number): Promise<RunRecord> => {
    const t0 = Date.now();
    const dir = join(outDir, "recordings", `r${run}`);
    let result: CauseResult;
    let attempts = 0;
    let firstAttemptFailed = false;
    const usage: LlmUsage = { inputTokens: 0, outputTokens: 0, reasoningTokens: 0 };
    try {
      const { input } = prepareInput({ diff: c.diff, before: c.before, after: c.after, symptom: c.symptom });
      do {
        attempts++;
        result = await diagnose(input, {
          mode: "record",
          dir,
          gate, // the spend cap: a call whose worst case would pass --max-usd is not made (not_diagnosed: budget)
          log: () => undefined,
          onUsage: (u) => {
            usage.inputTokens += u.inputTokens;
            usage.outputTokens += u.outputTokens;
            usage.reasoningTokens += u.reasoningTokens;
            spent += costUsd(u);
          },
        });
        const infra = result.status === "not_diagnosed" && INFRA.has(result.reason);
        if (attempts === 1) firstAttemptFailed = infra;
        if (!infra || attempts > retryInfra) break;
      } while (true);
    } catch (e) {
      // prepareInput refused the input (binary, too large, ...): the product would say "not diagnosed" as well
      result = { status: "not_diagnosed", reason: "input_rejected", text: "Not diagnosed.", promptVersion: "", requestHash: "" };
      console.warn(`${c.id}: ${(e as Error).message.slice(0, 120)}`);
    }
    const shown = shownOf(result);
    const rec = existsSync(join(dir, `${result.requestHash}.json`)) ? (JSON.parse(readFileSync(join(dir, `${result.requestHash}.json`), "utf8")) as { output?: unknown }).output : undefined;
    return {
      case: c.id,
      run,
      status: result.status,
      ...(result.status !== "proposed" ? { reason: result.reason } : {}),
      ...(result.status === "proposed" ? { category: result.category } : {}),
      shown,
      score: score(c.label, shown),
      attempts,
      firstAttemptFailed,
      usage,
      usd: costUsd(usage),
      ms: Date.now() - t0,
      requestHash: result.requestHash,
      raw: rec,
    };
  };

  const workers = Array.from({ length: Math.min(4, queue.length) }, async () => {
    while (queue.length) {
      const next = queue.shift()!;
      const r = await one(next.c, next.r);
      records.push(r);
      console.log(`${r.case.padEnd(5)} run ${r.run}  ${r.status.padEnd(13)} ${(r.reason ?? r.category ?? "").padEnd(24)} cat ${r.score.cat ? "ok" : "--"} ptr ${r.score.pointer ? "ok" : "--"}  $${r.usd.toFixed(4)}  ${r.ms} ms`);
    }
  });
  await Promise.all(workers);
  records.sort((a, b) => a.case.localeCompare(b.case) || a.run - b.run);

  // 3. Baselines. B1 is the frozen file, given the Gate-3 class name; B2, if one is given, is any module with the same function.
  const base = (fn: (c: unknown) => { category: any; file: string | null; evidence_line: string }, c: CaseFolder) => {
    const b = fn({ diff: c.diff, files: c.after, symClass: c.gate3Class ?? B1_CLASS[c.symptom] });
    const shown = shownOfBaseline(b);
    return { category: b.category as string, evidence_line: b.evidence_line, score: score(c.label, shown) };
  };
  const b2Path = chosen.b2;
  const b2fn = b2Path ? ((await import(resolve(b2Path))) as { baselineCause: (c: unknown) => any }).baselineCause : undefined;
  const perCase = cases.map((c) => {
    const mine = records.filter((r) => r.case === c.id);
    return { case: c.id, label: c.label.category, tags: c.label.tags, runs: mine.map((r) => ({ run: r.run, status: r.status, reason: r.reason, category: r.category, cat: r.score.cat, pointer: r.score.pointer, both: r.score.both })), B1: base(baselineCause as any, c), ...(b2fn ? { B2: base(b2fn, c) } : {}) };
  });

  // 4. Summary.
  const n = cases.length;
  const meanBoth = records.filter((r) => r.score.both).length / (records.length || 1);
  const allRuns = perCase.filter((p) => p.runs.length > 0 && p.runs.every((r) => r.both)).length;
  const shownWrong = records.filter((r) => r.status === "proposed" && !r.score.cat).length;
  const byStatus: Record<string, number> = {};
  for (const r of records) byStatus[r.reason ? `${r.status}:${r.reason}` : r.status] = (byStatus[r.reason ? `${r.status}:${r.reason}` : r.status] ?? 0) + 1;
  const summary = {
    set: chosen.sealed ? sealedName : relative(ROOT, setDir) || setDir, // relative to the repository: no home-folder path in a result file
    cases: n,
    runsPerCase: runs,
    productCorrectMean: Number((meanBoth * n).toFixed(2)), // of n, mean over runs (category and pointer)
    productCorrectMeanCategoryOnly: Number(((records.filter((r) => r.score.cat).length / (records.length || 1)) * n).toFixed(2)),
    casesCorrectInAllRuns: allRuns,
    shownWrong, // proposed (passed C2 and C1') with the wrong category: the plan's "confidently wrong", stricter because the product has no confidence field
    shownNotRight: records.filter((r) => r.status === "proposed" && !r.score.both).length, // proposed with a wrong category or a wrong line: for A8, "correct or not proven" fails exactly here
    outcomes: byStatus,
    infraFirstAttemptFailures: records.filter((r) => r.firstAttemptFailed).length, // network, timeout, 429 or 5xx on the first attempt
    infraRetriesMade: records.reduce((a, r) => a + Math.max(0, r.attempts - 1), 0), // same-request re-runs after such a failure; unreadable or empty answers are never re-run and show up in "outcomes"
    B1: { category: perCase.filter((p) => p.B1.score.cat).length, both: perCase.filter((p) => p.B1.score.both).length },
    ...(b2fn ? { B2: { category: perCase.filter((p) => (p as any).B2.score.cat).length, both: perCase.filter((p) => (p as any).B2.score.both).length } } : {}),
    spendUsd: Number(spent.toFixed(4)),
    tokens: records.reduce((a, r) => ({ in: a.in + r.usage.inputTokens, out: a.out + r.usage.outputTokens, reasoning: a.reasoning + r.usage.reasoningTokens }), { in: 0, out: 0, reasoning: 0 }),
  };
  const out = { startedAt, finishedAt: new Date().toISOString(), freeze: currentFreeze(ROOT), llmParams: LLM_PARAMS, sealed: chosen.sealed, summary, perCase, records };
  writeFileSync(join(outDir, "results.json"), `${JSON.stringify(out, null, 1)}\n`);
  console.table(perCase.map((p) => ({ case: p.case, label: p.label, product: p.runs.map((r) => (r.both ? "ok" : r.status === "proposed" ? `X(${r.category})` : `${r.status}`)).join(" "), B1: `${p.B1.category}${p.B1.score.both ? " ok" : p.B1.score.cat ? " (cat only)" : " X"}`, ...(b2fn ? { B2: `${(p as any).B2.category}${(p as any).B2.score.both ? " ok" : " X"}` } : {}) })));
  console.log(JSON.stringify(summary, null, 1));
  console.log(`results: ${join(outDir, "results.json")}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
