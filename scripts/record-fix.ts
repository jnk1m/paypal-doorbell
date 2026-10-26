// Records "prove the fix" for the three planted code bugs, on the owner's machine (LOCAL ONLY; nothing here runs on Vercel):
//
//   npx tsx scripts/record-fix.ts [--live] [--only ack_then_drop,bad_body,last_write_wins] [--cap 0.5] [--captures 3] [--singles 2] [--verify-cache <file>]
//
// For each mode: the recorded cause (lib/cause, a recording; no model call) -> ONE model call for the edits (recorded under fixtures/fix-recordings/,
// at most 3 calls in all, spend capped by docs/measurements/fix-record-spend.jsonl) -> the code checks -> the patched handler in the sandbox child
// process (empty environment, no network, no files) on real signed deliveries that the witness stored, with PayPal's own answer for each order.
// Without --live a missing recording is an error and no money is spent.
//
// PayPal is asked for two things only: verify-webhook-signature on stored deliveries (and on the tampered copies of them, which must fail) and
// GET capture for the orders. Nothing is written to PayPal. Sandbox only (PaypalClient).
//
// It writes: fixtures/fix/results.json (one FixResult per mode), fixtures/fix/patched/<mode>.handler.txt (the whole patched file, as text, for the
// owner to read), docs/measurements/fix-record-<date>.json (everything, including what failed). It never writes fixtures/fix/reviewed.json: only
// scripts/fix-review.ts does, after the owner has read the patch, and until then lib/fix/recorded.ts does not serve a proven patch.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { diagnose } from "../lib/cause/cause.ts";
import { SYMPTOM_CLASSES, type SymptomClass } from "../lib/cause/categories.ts";
import { confirmationOf } from "../lib/cause/confirm.ts";
import type { RecordedReplays } from "../lib/cause/replay.ts";
import { MODEL_ID } from "../lib/core/llm.ts";
import { FIX_RECORDINGS, readPatched, readResults, readReviewed, REPO_ROOT, writePatched, writeResults, writeReviewed } from "../lib/fix/files.ts";
import { FixInfraError, proveFix, type ProposedCause } from "../lib/fix/fix.ts";
import { CapReached, FIX_LLM_PARAMS, FixRecordingMissing, Ledger } from "../lib/fix/llm.ts";
import { FIX_PROMPT_VERSION } from "../lib/fix/prompt.ts";
import { CachedVerifier, Referee } from "../lib/fix/referee.ts";
import { pickScenarios, rowOf, type StoredRow } from "../lib/fix/scenarios.ts";
import { PaypalClientReads } from "../lib/gaps/reads.ts";
import { redisFromEnv } from "../lib/redis.ts";
import { deployInput } from "../lib/run/deploy-input.ts";
import { CAUSE_RECORDINGS_DIR } from "../lib/run/recordings.ts";
import { computeDiffs } from "../lib/shop/diffs.ts";
import type { PlantedMode } from "../lib/shop/types.ts";
import type { AttemptEntry } from "../lib/witness/store.ts";
import { appClient, loadEnv, loadRedisEnv, requireAnthropicKey } from "./env.ts";

const flag = (name: string) => (process.argv.includes(`--${name}`) ? process.argv[process.argv.indexOf(`--${name}`) + 1] : undefined);
const has = (name: string) => process.argv.includes(`--${name}`);
const ALL: PlantedMode[] = ["ack_then_drop", "bad_body", "last_write_wins"];

const live = has("live");
const cap = Number(flag("cap") ?? 0.5);
const modes = (flag("only")?.split(",") ?? ALL) as PlantedMode[];
for (const m of modes) if (!ALL.includes(m)) throw new Error(`--only: "${m}" is not one of ${ALL.join(", ")}`);

if (live) requireAnthropicKey("scripts/record-fix.ts");
else loadEnv();
loadRedisEnv();

const frozen = JSON.parse(readFileSync(join(REPO_ROOT, "fixtures/demo-webhooks.frozen.json"), "utf8")) as { webhooks: { id: string; url: string }[] };
const hookOf = (suffix: string) => {
  const w = frozen.webhooks.find((x) => x.url.endsWith(suffix));
  if (!w) throw new Error(`no webhook ending ${suffix} in fixtures/demo-webhooks.frozen.json`);
  return w.id;
};
const IDS = { demo: hookOf("/api/witness"), dev: process.env.PAYPAL_WITNESS_DEV_WEBHOOK_ID ?? "7N5964230U472033D" };
const RECORDED_REPLAYS = JSON.parse(readFileSync(join(REPO_ROOT, "fixtures/replay/recorded.json"), "utf8")) as RecordedReplays;
const bundle = computeDiffs(REPO_ROOT);
const good = readFileSync(join(REPO_ROOT, "handlers/good.ts"), "utf8");

// The orders the proof runs on: the freshest in the witness's record, with PayPal's own answer for each (GET capture).
async function pickOrders() {
  const redis = redisFromEnv();
  if (!redis) throw new Error("KV_REST_API_URL and KV_REST_API_TOKEN are not set (.env.vercel): the deliveries the witness stored are in Redis");
  const keys: string[] = [];
  let cursor: string | number = 0;
  do {
    const [next, found]: [string, string[]] = await redis.scan(cursor, { match: "db:w:att:*", count: 500 });
    keys.push(...found);
    cursor = next;
  } while (String(cursor) !== "0");
  const rows: StoredRow[] = [];
  for (const key of keys) {
    const [raw] = await redis.lrange<string>(key, 0, 0); // the first attempt: the one that was verified and processed
    const row = rowOf(JSON.parse(String(raw)) as AttemptEntry);
    if (row) rows.push(row);
  }
  const reads = new PaypalClientReads(appClient("demo"));
  const scenarios = await pickScenarios(rows, Number(flag("captures") ?? 3), IDS, async (id) => (await reads.capture(id, 15_000)).status, Date.now(), Number(flag("singles") ?? 2));
  return { stored: rows.length, scenarios };
}

// The recorded cause of a mode, and whether the recorded replay confirms it (the fix is only for a cause that is both).
async function causeOf(mode: PlantedMode): Promise<{ input: ReturnType<typeof deployInput>; cause: ProposedCause; symptom: SymptomClass } | string> {
  for (const symptom of SYMPTOM_CLASSES) {
    const input = deployInput(mode, bundle, symptom);
    const cause = await diagnose(input, { mode: "replay", onMiss: "none", dir: CAUSE_RECORDINGS_DIR, log: () => undefined });
    if (cause.status !== "proposed") continue;
    const confirmation = confirmationOf(cause, RECORDED_REPLAYS[mode]);
    return confirmation.confirmed ? { input, cause, symptom } : `the cause is proposed but the recorded replay does not confirm it (${confirmation.chip})`;
  }
  return "no recorded cause is proposed for this mode";
}

const { stored, scenarios } = await pickOrders();
console.log(`witness record: ${stored} booking rows; picked ${scenarios.length} orders: ${scenarios.map((s) => `${s.capture.slice(0, 6)}.. ${s.truthStatus} (${s.ageHoursWhenPrepared.toFixed(1)} h old, ${s.deliveries.map((d) => (JSON.parse(d.raw).event_type as string).slice(16)).join("->")})`).join("; ")}`);
const client = appClient("demo", { timeoutMs: 15_000 });
const verifier = new CachedVerifier((p) => client.verifyWebhookSignature(p), flag("verify-cache"));
const referee = new Referee(scenarios, good, verifier);
await referee.prepare();
console.log(`the good build satisfies ${referee.scenarioCount} of ${scenarios.length} orders; dropped: ${JSON.stringify(referee.dropped)}`);

const ledger = new Ledger(join(REPO_ROOT, "docs/measurements/fix-record-spend.jsonl"), cap);
console.log(`model ${MODEL_ID}, prompt ${FIX_PROMPT_VERSION}, spent so far $${ledger.total().toFixed(4)} of $${cap.toFixed(2)}, live=${live}`);

const results = readResults();
const reviewed = readReviewed();
const log: Record<string, unknown>[] = [];
let stopped: string | undefined;
let modelCalls = 0;

for (const mode of modes) {
  const found = await causeOf(mode);
  if (typeof found === "string") {
    console.log(`${mode}: skipped, ${found}`);
    log.push({ mode, skipped: found });
    continue;
  }
  try {
    const attempt = await proveFix({ mode, input: found.input, cause: found.cause, referee, llm: { dir: FIX_RECORDINGS, live, ledger } });
    if (attempt.call.source === "live") modelCalls++;
    const r = attempt.result;
    results[mode] = r;
    if (r.verdict === "proven" && attempt.patched !== undefined) writePatched(mode, attempt.patched);
    // An earlier approval is for the earlier file: it no longer opens anything, and it is removed so the file says who is approved.
    if (reviewed[mode] !== undefined && reviewed[mode] !== r.patchSha256) delete reviewed[mode];
    console.log(`${mode}: ${r.verdict.toUpperCase()} (${attempt.call.source} model answer, $${attempt.call.costUsd.toFixed(4)}); checks ${r.checks.map((c) => `${c.id}=${c.ok ? "ok" : "FAIL"}`).join(" ")}; controls ${r.controls.map((c) => `${c.id}=${c.ok ? "ok" : "FAIL"}(${c.n})`).join(" ")}${attempt.problems.length ? `; ${attempt.problems.join(" ")}` : ""}`);
    log.push({
      mode,
      symptom: found.symptom,
      cause: { category: found.cause.category, cited: found.cause.lines.map((l) => `${l.id} ${l.kind === "add" ? "+" : "-"} ${l.text.trim()}`), requestHash: found.cause.requestHash },
      fixRequestHash: attempt.call.hash,
      modelAnswer: { source: attempt.call.source, recordedAt: attempt.call.recordedAt, usage: attempt.call.usage, costUsd: attempt.call.costUsd, edits: attempt.edits },
      problems: attempt.problems,
      result: r,
      patchedLineCount: attempt.patched?.split("\n").length,
      refereeFailures: attempt.referee && !attempt.referee.pass ? attempt.referee.runs.filter((v) => !v.sameAsGood || v.matchesPaypal === false).slice(0, 6).map((v) => ({ run: v.name, capture: v.capture.slice(0, 6), good: v.good, got: v.got })) : [],
    });
  } catch (e) {
    if (e instanceof CapReached) {
      stopped = e.message;
      console.log(`STOPPED: ${stopped}`);
      break;
    }
    if (e instanceof FixRecordingMissing) {
      console.log(`${mode}: skipped, ${e.message}`);
      log.push({ mode, skipped: e.message });
      continue;
    }
    if (e instanceof FixInfraError) {
      console.log(`${mode}: not judged, ${e.message}`);
      log.push({ mode, infra: e.message });
      continue;
    }
    throw e;
  }
}

writeResults(results);
writeReviewed(reviewed);
const date = new Date().toISOString().slice(0, 10);
const out = join(REPO_ROOT, `docs/measurements/fix-record-${date}.json`);
writeFileSync(
  out,
  `${JSON.stringify(
    {
      at: new Date().toISOString(),
      model: MODEL_ID,
      promptVersion: FIX_PROMPT_VERSION,
      params: FIX_LLM_PARAMS,
      live,
      modelCallsThisRun: modelCalls,
      spendCapUsd: cap,
      spentUsdAllRuns: Number(ledger.total().toFixed(4)),
      orders: scenarios.map((s) => ({ capture: s.capture.slice(0, 6), truth: s.truthStatus, deliveries: s.deliveries.length, ageHoursWhenPrepared: Number(s.ageHoursWhenPrepared.toFixed(1)) })),
      refereeDropped: referee.dropped,
      verify: { liveCalls: verifier.stats.live, answeredFromStored: verifier.stats.cached },
      stoppedByCap: stopped ?? null,
      modes: log,
      reviewedPatchesOnFile: Object.keys(readReviewed()),
      patchedFilesOnFile: ALL.filter((m) => readPatched(m) !== undefined),
      costOfRecordedAnswersUsd: Number(log.reduce((s, l) => s + ((l.modelAnswer as { costUsd?: number } | undefined)?.costUsd ?? 0), 0).toFixed(4)),
    },
    null,
    2,
  )}\n`,
);
console.log(`wrote ${out}; results in fixtures/fix/results.json (a proven patch is shown only after scripts/fix-review.ts approves it)`);
