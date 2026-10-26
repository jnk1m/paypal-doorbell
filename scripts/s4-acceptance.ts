// Live acceptance runs for the cause step (plan A25, A13, and the recorded causes), real PayPal Sandbox verify, real Upstash.
// Each subcommand prints its numbers and writes a JSON log; it does not decide pass or fail for you.
//   a25 [--runs 3] [--out file]       C3 replay: the 3 planted modes x runs, real stored deliveries through the real handler files, PayPal's verify
//                                     endpoint; then deliveries older than the replay window must come back as recorded results with no verify call.
//                                     Writes fixtures/replay/recorded.json (results only, no bodies) from the first run of each mode.
//   a13 [--out file]                  the limiter and the budget on the real database: Redis commands for 1,000 requests from one IP (wrapper count and
//                                     the server's own counter), 20 concurrent visitors, the budget stop.
//   record-causes [--only <mode>]     one live model call per planted mode, written to fixtures/recordings/ (the cached default path). RECORD needs the key.
//                                     --only records that one mode and no other (a recording is named by its request, so another mode's file is never touched);
//                                     the setting-bug mode wrong_webhook_id_setting is only ever recorded this way.
// Needs .env (Sandbox keys, ANTHROPIC_API_KEY) and .env.vercel (Upstash). Prints no secret.
import { MockLanguageModelV4 } from "ai/test";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createBudget } from "../lib/budget.ts";
import { buildRequest } from "../lib/cause/prompt.ts";
import { createLiveGate, spendCapGate } from "../lib/cause/gate.ts";
import { diagnose } from "../lib/cause/cause.ts";
import { shopInput } from "../lib/cause/input.ts";
import { loadReplayCase, type ReplayRef } from "../lib/cause/replay-source.ts";
import { REPLAY_WINDOW_MS, replayNow, replayOrRecorded, type RecordedReplays, type ReplayResult } from "../lib/cause/replay.ts";
import { costUsd, worstCaseUsd, type LlmUsage } from "../lib/core/llm.ts";
import { createLimiter, RULES, type LimitKind } from "../lib/limits.ts";
import { PaypalClient } from "../lib/pay/paypal.ts";
import { redisFromEnv } from "../lib/redis.ts";
import { deployInput } from "../lib/run/deploy-input.ts";
import { computeDiffs } from "../lib/shop/diffs.ts";
import { bookingOf } from "../lib/shop/events.ts";
import { SETTING_MODES, type BrokenMode, type PlantedMode } from "../lib/shop/types.ts";
import { deleteByPrefix, TEST_PREFIX } from "../lib/test-redis.ts";
import { RedisWitnessStore, type AttemptEntry } from "../lib/witness/store.ts";
import { loadEnv, loadRedisEnv } from "./env.ts";

loadEnv();
loadRedisEnv();
const ROOT = join(dirname(new URL(import.meta.url).pathname), "..");
const [command, ...rest] = process.argv.slice(2);
const flag = (name: string) => (rest.includes(`--${name}`) ? rest[rest.indexOf(`--${name}`) + 1] : undefined);
const MODES: PlantedMode[] = ["bad_body", "ack_then_drop", "last_write_wins"];
const write = (file: string | undefined, fallback: string, data: unknown) => {
  const path = file ?? join(ROOT, "docs/measurements", fallback);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);
  console.log(`wrote ${path}`);
};

function redisOrDie() {
  const r = redisFromEnv();
  if (!r) throw new Error("KV_REST_API_URL and KV_REST_API_TOKEN are not set (.env.vercel)");
  return r;
}

// ---- a25 ---------------------------------------------------------------------------------------------------------------------------

interface Stored {
  e: AttemptEntry;
  capture: string;
  type: string;
}

async function storedDeliveries(): Promise<Stored[]> {
  const redis = redisOrDie();
  const keys: string[] = [];
  let cursor: string | number = 0;
  do {
    const [next, found]: [string, string[]] = await redis.scan(cursor, { match: "db:w:att:*", count: 500 });
    keys.push(...found);
    cursor = next;
  } while (String(cursor) !== "0");
  const out: Stored[] = [];
  for (const key of keys) {
    const [raw] = await redis.lrange<string>(key, 0, 0);
    const e = JSON.parse(String(raw)) as AttemptEntry;
    if (e.slot !== "D" || e.st !== "ok" || !e.raw || e.big) continue;
    let capture: string | undefined;
    try {
      capture = bookingOf(JSON.parse(e.raw))?.captureId;
    } catch {
      /* not a booking event */
    }
    if (capture) out.push({ e, capture, type: e.type });
  }
  return out;
}

const ageH = (e: AttemptEntry) => (Date.now() - Date.parse(e.h.time)) / 3_600_000;

// Real arrival order at the shop (S): a capture whose refund reached S before a (resent, late) payment did.
async function lateCompletedAfterRefund(captures: Map<string, Stored[]>): Promise<string[]> {
  const redis = redisOrDie();
  const found: string[] = [];
  for (const [capture, rows] of captures) {
    const completed = rows.find((r) => r.type === "PAYMENT.CAPTURE.COMPLETED");
    const refunded = rows.find((r) => r.type === "PAYMENT.CAPTURE.REFUNDED");
    if (!completed || !refunded) continue;
    const [c, r] = await redis.mget<(string | null)[]>(`db:shop:r:${completed.e.eid}`, `db:shop:r:${refunded.e.eid}`);
    const rx = (s: string | null) => String(s ?? "").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { k: string; at: number }).filter((l) => l.k === "rx").map((l) => l.at);
    const cRx = rx(c);
    const rRx = rx(r);
    if (cRx.length && rRx.length && Math.max(...cRx) > Math.min(...rRx)) found.push(capture);
  }
  return found;
}

async function a25() {
  const redis = redisOrDie();
  const witness = new RedisWitnessStore(redis, { prefix: "db:", budgetPerMinute: 60 });
  const frozen = JSON.parse(readFileSync(join(ROOT, "fixtures/demo-webhooks.frozen.json"), "utf8")) as { webhooks: { id: string; url: string }[] };
  const dId = frozen.webhooks.find((w) => w.url.endsWith("/api/witness"))!.id;
  // Deliveries stored before 2026-10-19 03:59:13 UTC under slot "D" were signed for the DEV app's witness webhook (the demo app's took the
  // slot over at S2); verifying them against the demo's id would fail for a reason that is not age (scripts/reverify-stored.ts, s4-reverify-run1.json).
  const devId = process.env.PAYPAL_WITNESS_DEV_WEBHOOK_ID ?? "7N5964230U472033D";
  const DEMO_D_SINCE = Date.parse("2026-10-19T03:59:13Z");
  const idOf = (e: AttemptEntry) => (e.slot === "D-dev" || Date.parse(e.h.time) < DEMO_D_SINCE ? devId : dId);
  const paypal = PaypalClient.fromEnv(process.env, { timeoutMs: 15_000 });
  let verifyCalls = 0;
  const verify = (p: Parameters<PaypalClient["verifyWebhookSignature"]>[0]) => (verifyCalls++, paypal.verifyWebhookSignature(p));

  const all = await storedDeliveries();
  const captures = new Map<string, Stored[]>();
  for (const s of all) captures.set(s.capture, [...(captures.get(s.capture) ?? []), s]);
  const youngest = (rows: Stored[]) => Math.min(...rows.map((r) => ageH(r.e)));
  const oldest = (rows: Stored[]) => Math.max(...rows.map((r) => ageH(r.e)));
  const windowH = REPLAY_WINDOW_MS / 3_600_000;
  const pairs = [...captures.entries()].filter(([, rows]) => rows.some((r) => r.type.endsWith("COMPLETED")) && rows.some((r) => r.type.endsWith("REFUNDED")) && oldest(rows) < windowH - 0.25).sort((a, b) => youngest(a[1]) - youngest(b[1]));
  const lww = (await lateCompletedAfterRefund(captures)).filter((c) => oldest(captures.get(c)!) < windowH - 0.25).sort((a, b) => youngest(captures.get(a)!) - youngest(captures.get(b)!));
  console.log(`stored D deliveries ${all.length}; captures with both events inside the window: ${pairs.length}; with the late-payment order: ${lww.length}`);
  if (pairs.length < 2 || lww.length < 1) throw new Error("not enough fresh stored events inside the replay window; make orders (scripts/s3-acceptance.ts trials) and run again");

  const pick = (capture: string, order: ("PAYMENT.CAPTURE.COMPLETED" | "PAYMENT.CAPTURE.REFUNDED")[]) => order.map((t) => captures.get(capture)!.find((r) => r.type === t)!.e.tid);
  const refs: ReplayRef[] = [
    { mode: "bad_body", tids: pick(pairs[0][0], ["PAYMENT.CAPTURE.COMPLETED", "PAYMENT.CAPTURE.REFUNDED"]) },
    { mode: "ack_then_drop", tids: pick(pairs[1][0], ["PAYMENT.CAPTURE.COMPLETED", "PAYMENT.CAPTURE.REFUNDED"]) },
    { mode: "last_write_wins", tids: pick(lww[0], ["PAYMENT.CAPTURE.REFUNDED", "PAYMENT.CAPTURE.COMPLETED"]) },
  ];

  const runs = Number(flag("runs") ?? 3);
  const log: { mode: PlantedMode; run: number; result: ReplayResult; ageHours: number; verifyCalls: number }[] = [];
  for (let run = 1; run <= runs; run++) {
    for (const ref of refs) {
      const c = await loadReplayCase(witness, ref, idOf);
      const before = verifyCalls;
      const t0 = Date.now();
      const result = await replayNow(c, verify);
      const age = Math.max(...c.deliveries.map((d) => (Date.now() - Date.parse(d.headers.transmissionTime)) / 3_600_000));
      log.push({ mode: ref.mode, run, result, ageHours: Number(age.toFixed(2)), verifyCalls: verifyCalls - before });
      console.log(`run ${run} ${ref.mode.padEnd(16)} ${result.verdict.padEnd(20)} good ${JSON.stringify(result.good)} bad ${JSON.stringify(result.bad)} (${Date.now() - t0} ms, oldest delivery ${age.toFixed(2)} h)`);
    }
  }

  // Recorded results: the first run of each mode.
  const recorded: RecordedReplays = Object.fromEntries(MODES.map((m) => [m, log.find((l) => l.mode === m && l.run === 1)!.result]));
  mkdirSync(join(ROOT, "fixtures/replay"), { recursive: true });
  writeFileSync(join(ROOT, "fixtures/replay/recorded.json"), `${JSON.stringify(recorded, null, 2)}\n`);

  // Outside the window: stored deliveries older than the window -> "recorded result" with no verify call.
  const stale = [...captures.entries()].filter(([, rows]) => youngest(rows) > windowH + 0.1 && rows.some((r) => r.type.endsWith("REFUNDED"))).slice(0, 6);
  let recordedShown = 0;
  const callsBeforeStale = verifyCalls;
  for (const [i, [capture]] of stale.entries()) {
    const mode = MODES[i % 3];
    const types = mode === "last_write_wins" ? (["PAYMENT.CAPTURE.REFUNDED", "PAYMENT.CAPTURE.COMPLETED"] as const) : (["PAYMENT.CAPTURE.COMPLETED", "PAYMENT.CAPTURE.REFUNDED"] as const);
    const rows = captures.get(capture)!;
    if (!types.every((t) => rows.some((r) => r.type === t))) continue;
    const c = await loadReplayCase(witness, { mode, tids: types.map((t) => rows.find((r) => r.type === t)!.e.tid) }, idOf);
    const shown = await replayOrRecorded(c, verify, recorded);
    if (shown.basis === "recorded") recordedShown++;
    console.log(`outside the window (${(Math.min(...c.deliveries.map((d) => (Date.now() - Date.parse(d.headers.transmissionTime)) / 3_600_000))).toFixed(2)} h): ${mode} -> ${shown.basis} ${shown.verdict}`);
  }
  const staleChecked = stale.length;
  const staleVerifyCalls = verifyCalls - callsBeforeStale;
  // What a forced replay of an old event does (why the window exists): the good build is rejected too.
  let forced: unknown = null;
  if (stale[0]) {
    const rows = captures.get(stale[0][0])!;
    const c = await loadReplayCase(witness, { mode: "bad_body", tids: ["PAYMENT.CAPTURE.COMPLETED", "PAYMENT.CAPTURE.REFUNDED"].map((t) => rows.find((r) => r.type === t)?.e.tid).filter((x): x is string => Boolean(x)) }, idOf);
    const f = await replayNow(c, verify);
    forced = { ageHours: Number(Math.max(...c.deliveries.map((d) => (Date.now() - Date.parse(d.headers.transmissionTime)) / 3_600_000)).toFixed(2)), verdict: f.verdict, good: f.good, bad: f.bad };
    console.log("forced replay of an event outside the window:", JSON.stringify(forced));
  }
  const confirmed = log.filter((l) => l.result.verdict === "CONFIRMED BY REPLAY").length;
  const summary = { replayWindowHours: windowH, confirmed: `${confirmed}/${log.length}`, byMode: Object.fromEntries(MODES.map((m) => [m, `${log.filter((l) => l.mode === m && l.result.verdict === "CONFIRMED BY REPLAY").length}/${log.filter((l) => l.mode === m).length}`])), outsideWindow: { checked: staleChecked, shownAsRecorded: recordedShown, verifyCallsMade: staleVerifyCalls }, forcedReplayOutsideWindow: forced };
  console.log(JSON.stringify(summary, null, 1));
  write(flag("out"), "s4-a25-run1.json", { at: new Date().toISOString(), refs: refs.map((r) => ({ mode: r.mode, tids: r.tids.map((t) => t.slice(0, 8)) })), summary, log });
}

// ---- a13 ---------------------------------------------------------------------------------------------------------------------------

async function primaryTotal(): Promise<number> {
  for (let i = 0; i < 60; i++) {
    const res = await fetch(process.env.KV_REST_API_URL!, { method: "POST", headers: { Authorization: `Bearer ${process.env.KV_REST_API_TOKEN}` }, body: JSON.stringify(["INFO"]) });
    const text = String(((await res.json()) as { result: string }).result);
    if (Number(text.match(/total_writes_processed:(\d+)/)?.[1]) > 0) return Number(text.match(/total_commands_processed:(\d+)/)![1]);
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("INFO never reached the primary");
}

async function a13() {
  const redis = redisOrDie();
  const prefix = `${TEST_PREFIX}s4-${randomUUID().slice(0, 6)}:`;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const result: Record<string, unknown> = { at: new Date().toISOString() };
  try {
    // 1. 1,000 requests from one IP within a minute, per kind that has more than one counter.
    for (const kind of ["scan", "session", "order"] as LimitKind[]) {
      let evals = 0;
      const counted = new Proxy(redis, { get: (t, p, r) => (p === "eval" ? (...a: Parameters<typeof t.eval>) => (evals++, t.eval(...a)) : Reflect.get(t, p, r)) });
      const { checkLimit } = createLimiter({ redis: counted, prefix: `${prefix}${kind}:` });
      const a = await primaryTotal();
      const t0 = Date.now();
      let ok = 0;
      for (let i = 0; i < 1000; i++) if ((await checkLimit(kind, { ip: "198.51.100.7", session: "flood" })).ok) ok++;
      const ms = Date.now() - t0;
      await sleep(400);
      const server = (await primaryTotal()) - a;
      const calm = (await checkLimit(kind, { ip: "198.51.100.8", session: "calm" })).ok;
      result[`flood_${kind}`] = { requests: 1000, ms, passed: ok, evalCalls: evals, serverCommands: server, normalVisitorStillPasses: calm };
      console.log(`1,000 requests from one IP (${kind}, ${ms} ms): ${ok} passed, ${evals} eval calls (wrapper), ${server} commands counted by the server, normal visitor ${calm ? "passes" : "BLOCKED"}`);
    }
    // 2. blocked requests cost nothing: fill a global pool of 10, then 500 blocked requests.
    {
      let evals = 0;
      const counted = new Proxy(redis, { get: (t, p, r) => (p === "eval" ? (...a: Parameters<typeof t.eval>) => (evals++, t.eval(...a)) : Reflect.get(t, p, r)) });
      const { checkLimit } = createLimiter({ redis: counted, prefix: `${prefix}pool:` });
      let passed = 0;
      for (let i = 0; i < 40; i++) if ((await checkLimit("refund", { ip: `203.0.113.${i}` })).ok) passed++;
      const after = evals;
      const a = await primaryTotal();
      let blocked = 0;
      for (let i = 0; i < 500; i++) if (!(await checkLimit("refund", { ip: `203.0.114.${i % 250}` })).ok) blocked++;
      await sleep(400);
      result.blockedRequests = { pool: 10, passedOfFirst40: passed, evalCallsToFill: after, blockedAfterwards: blocked, extraEvalCalls: evals - after, extraServerCommands: (await primaryTotal()) - a };
      console.log(`global pool of 10: ${passed} passed; then ${blocked}/500 blocked with ${evals - after} more eval calls and ${(await primaryTotal()) - a} more server commands`);
    }
    // 3. the money budget on the real database: the reservation is the worst case of THIS request; failures that were not billed give it back,
    //    timeouts keep it, and when the day's cap would be passed no model call is made.
    {
      const input = shopInput("bad_body", computeDiffs(ROOT), "all_401");
      const reserve = worstCaseUsd(buildRequest(input));
      const budget = createBudget({ redis, prefix: `${prefix}bud:`, dailyUsd: reserve * 2.5 });
      const limiter = createLimiter({ redis, prefix: `${prefix}gate:`, rules: { ...RULES, model: [{ scope: "global", max: 1000, windowSec: 3600 }] } }); // the hourly limit of 6 and the per-address burst would hide the budget here
      let visitor = 0;
      const failWith = (e: Error) =>
        new MockLanguageModelV4({
          doGenerate: async () => {
            throw e;
          },
        });
      let calls = 0;
      const run = async (model: MockLanguageModelV4) => {
        const gate = createLiveGate({ limiter, budget, ip: `198.51.100.${visitor++ % 250}` });
        const r = await diagnose(input, { mode: "live", gate, log: () => undefined, onLiveCall: () => calls++, model });
        return r.status === "not_diagnosed" ? r.reason : r.status;
      };
      const unbilled: string[] = [];
      for (let i = 0; i < 20; i++) unbilled.push(await run(failWith(Object.assign(new Error("x"), { name: "AI_APICallError", statusCode: [429, 401, 503, 529][i % 4] }))));
      const spentAfterUnbilled = await budget.spentUsd();
      const timeouts: string[] = [];
      for (let i = 0; i < 4; i++) timeouts.push(await run(failWith(Object.assign(new Error("t"), { name: "TimeoutError" }))));
      result.budget = { requestWorstCaseUsd: Number(reserve.toFixed(4)), dailyCapUsd: Number((reserve * 2.5).toFixed(4)), unbilledFailures: 20, spentAfterUnbilledUsd: spentAfterUnbilled, timeoutOutcomes: timeouts, modelCallsMade: calls };
      console.log(`reservation for this request $${reserve.toFixed(4)}, cap $${(reserve * 2.5).toFixed(4)}: 20 failures that were not billed leave $${spentAfterUnbilled} spent; then timeouts: ${timeouts.join(", ")}; model calls made ${calls}`);
    }
  } finally {
    console.log(`cleanup: deleted ${await deleteByPrefix(redis, prefix)} keys`);
  }
  write(flag("out"), "s4-a13-run1.json", result);
}

// ---- record-causes -----------------------------------------------------------------------------------------------------------------

const SYMPTOM: Record<BrokenMode, "all_401" | "2xx_but_books_unchanged"> = { bad_body: "all_401", ack_then_drop: "2xx_but_books_unchanged", last_write_wins: "2xx_but_books_unchanged", wrong_webhook_id_setting: "all_401" };
const RECORDABLE: readonly BrokenMode[] = [...MODES, ...SETTING_MODES];

async function recordCauses() {
  const only = flag("only");
  if (only !== undefined && !RECORDABLE.includes(only as BrokenMode)) throw new Error(`--only ${only}: not a mode with a diff (one of ${RECORDABLE.join(", ")})`);
  const modes: readonly BrokenMode[] = only ? [only as BrokenMode] : MODES;
  const bundle = computeDiffs(ROOT);
  const gate = spendCapGate(only ? 0.05 : 0.25); // one call is about $0.01 (never more than about $0.03): the cap is only a guard
  const usage: LlmUsage = { inputTokens: 0, outputTokens: 0, reasoningTokens: 0 };
  const out: Record<string, unknown> = {};
  for (const mode of modes) {
    const r = await diagnose(deployInput(mode, bundle, SYMPTOM[mode]), { mode: "record", gate, log: () => undefined, onUsage: (u) => ((usage.inputTokens += u.inputTokens), (usage.outputTokens += u.outputTokens), (usage.reasoningTokens += u.reasoningTokens)) });
    out[mode] = { ...(r.status === "proposed" ? { status: r.status, category: r.category, file: r.file, lines: r.lines.map((l) => `${l.id} ${l.kind} ${l.text.trim()}`) } : { status: r.status, reason: r.reason }), requestHash: r.requestHash };
    console.log(mode, JSON.stringify(out[mode]));
  }
  console.log(`spend $${costUsd(usage).toFixed(4)} (${usage.inputTokens} in / ${usage.outputTokens} out)`);
  write(flag("out"), only ? `s4-record-causes-${only}.json` : "s4-record-causes.json", { at: new Date().toISOString(), only: only ?? null, results: out, usage, usd: Number(costUsd(usage).toFixed(4)) });
}

const commands: Record<string, () => Promise<void>> = { a25, a13, "record-causes": recordCauses };
if (!commands[command]) {
  console.error(`usage: tsx scripts/s4-acceptance.ts <${Object.keys(commands).join("|")}> [flags]`);
  process.exit(2);
}
commands[command]().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
