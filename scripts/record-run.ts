// Records the hosted default (R12, plan 5.6): four real scenarios, driven against the DEPLOYED live shop with real PayPal Sandbox money,
// each captured as 3-5 steps of RunSnapshot and written to fixtures/recorded-run/<id>.json, where lib/run/recorded.ts imports them. The
// hosted site then plays them back with no Redis, PayPal or model call.
//
//   npx tsx scripts/record-run.ts [--only refund_never_booked,late_payment_overwrites,signature_rejected,cause_not_in_code] [--out docs/measurements/record-run.json]
//   npx tsx scripts/record-run.ts --rebuild      recompute each stored step's certificate, heartbeat and the titles that say what happened, from its stored scan (no network)
//   npx tsx scripts/record-run.ts --only dispute_never_heard    the fifth run, "the dispute your shop never heard" (opt-in: it is not in the default list, so a plain run
//                                                               does not record the other four again). About 5 to 6 minutes (18 at the worst, 3 attempts at most); see disputeScenario below.
//
// Actions go to the deployed shop (session, order, refund, mode, ring: the same API the page calls). What is seen is built locally by
// lib/run/build.ts, the code behind the live snapshot route, on the same Upstash and PayPal data: the scan, the certificate, the heartbeat,
// the recorded cause, the replay (real deliveries through the real handler files, PayPal's verify endpoint) and the fix (the reviewed patch, run in
// the sandbox child process on this session's own deliveries: lib/fix/prove.ts). So a recorded step cannot show anything that the live product would not.
//
// Every scenario has 3 orders: one healthy (it stays paid, so one row is TIED) and two $48.00 gift sets that are refunded under the bug.
// The FIRST step is taken when both refunds are gaps (plan 5.6: the first screen already shows 2). Honest recording rules:
//   - a trial in which PayPal itself loses an event is invalid (lib/gaps/invalidation.ts), is recorded as such, and is run again (at most 3 runs);
//   - a resend that PayPal accepted and never delivered is shown as that, never as healed: a row is "healed" only when the books changed
//     and now agree with PayPal's own answer (lib/gaps/heal.ts decides, not this script);
//   - session ids are replaced by a hash before anything is written; PayPal ids (order, capture, refund, event) are kept, for lookup.
// Needs: the main repo's .env (demo app keys), .env.vercel (Upstash), .env.live (live token). Prints no secret.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { certificateOf, rowsInsideListLag } from "../lib/cert/cert.ts";
import type { RecordedReplays, ReplayResult } from "../lib/cause/replay.ts";
import { readPatched } from "../lib/fix/files.ts";
import { proveOnSession } from "../lib/fix/prove.ts";
import type { FixResult } from "../lib/fix/types.ts";
import { PaypalClientDisputeReads } from "../lib/gaps/disputes.ts";
import { LOSS_WINDOW_MS } from "../lib/gaps/invalidation.ts";
import { PaypalClientReads } from "../lib/gaps/reads.ts";
import { scanSessionWithView, type ScanEvent, type ScanResult, type ScanRow } from "../lib/gaps/scan.ts";
import { chargebackBody } from "../lib/pay/chargeback.ts";
import { PaypalError } from "../lib/pay/paypal.ts";
import { redisFromEnv } from "../lib/redis.ts";
import { buildLiveSnapshot, type SnapshotDeps } from "../lib/run/build.ts";
import { checkDisputeScenario } from "../lib/run/check-disputes.ts";
import type { RecordedDisputeScenario, RecordedScenario, RunSnapshot } from "../lib/run/snapshot.ts";
import { disputeTitle, finalTitle, FIRST_TITLES, FIX_TITLES, ringTitle } from "../lib/run/titles.ts";
import { computeDiffs } from "../lib/shop/diffs.ts";
import { RedisShopStore } from "../lib/shop/store.ts";
import { isPlanted, type BrokenMode } from "../lib/shop/types.ts";
import { checkSnapshot } from "../lib/ui/check.ts";
import { heartbeatOfScan } from "../lib/witness/heartbeat.ts";
import { RedisWitnessStore } from "../lib/witness/store.ts";
import { appClient, liveToken, loadEnv, loadRedisEnv } from "./env.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(ROOT, "fixtures/recorded-run");
const BASE = process.env.SHOP_URL ?? "https://paypal-doorbell.vercel.app";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const flag = (name: string) => (process.argv.includes(`--${name}`) ? process.argv[process.argv.indexOf(`--${name}`) + 1] : undefined);
const has = (name: string) => process.argv.includes(`--${name}`);

type Spec = { id: RecordedScenario["id"]; title: string; mode: BrokenMode } | { id: RecordedDisputeScenario["id"]; title: string; mode: "none" };
const SPECS: Spec[] = [
  { id: "refund_never_booked", title: "A refund PayPal made never reached the books", mode: "ack_then_drop" },
  { id: "late_payment_overwrites", title: "A late payment message overwrote a refund", mode: "last_write_wins" },
  { id: "signature_rejected", title: "The shop rejected PayPal's signed messages", mode: "bad_body" },
  { id: "cause_not_in_code", title: "The shop rejected PayPal's signed messages after a deploy that only changed a comment", mode: "wrong_webhook_id_setting" },
];
// The 10-19 recording of the bad_body bug, kept as its own story because its ending is the honest one (a resend PayPal accepted and never delivered). It is not
// recorded again (it is not in SPECS, so --only cannot name it); --rebuild still recomputes it, because the tests hold its stored steps to the product's code.
const ARCHIVED_SPEC: Spec = { id: "resend_not_delivered", title: "PayPal accepted a resend and never delivered it", mode: "bad_body" };
// Opt-in (--only dispute_never_heard): no handler is broken. A customer's bank disputes one order at PayPal, and no webhook of the demo app subscribes
// to dispute events (D, S and U do not: fixtures/demo-webhooks.frozen.json), so the shop was never going to be told. Nothing is registered or changed.
const DISPUTE_SPEC: Spec = { id: "dispute_never_heard", title: "A customer's bank disputed an order at PayPal and the shop was never told", mode: "none" };
const DISPUTE_STEPS = ["before", "listed", "due", "ring"] as const;

// ---- --rebuild: no network --------------------------------------------------------------------------------------------------------------
function rebuild(): void {
  for (const spec of [...SPECS, ARCHIVED_SPEC]) {
    const file = join(OUT_DIR, `${spec.id}.json`);
    if (!existsSync(file)) {
      console.log(`skipped ${spec.id}: ${file} does not exist yet (it has not been recorded)`);
      continue;
    }
    const s = JSON.parse(readFileSync(file, "utf8")) as RecordedScenario;
    for (const step of s.steps) {
      if (!step.scan) continue;
      step.certificate = certificateOf(step.scan, { rowsInsideListLag: rowsInsideListLag(step.session.orders, step.scan.at) });
      step.heartbeat = heartbeatOfScan(step.scan, step.session);
    }
    // The titles that say what happened are a function of the rows: the third step is "Ring again", the last one is how the resends ended.
    const caps = s.steps[0].scan!.rows.filter((r) => r.status === "GAP").map((r) => r.captureId);
    s.steps[0].step!.title = FIRST_TITLES[s.id];
    s.steps[1].step!.title = FIX_TITLES[s.id];
    if (s.steps.length >= 4) {
      s.steps[2].step!.title = ringTitle(s.steps[2], caps);
      s.steps[s.steps.length - 1].step!.title = finalTitle(s.steps[s.steps.length - 1], caps);
    }
    writeFileSync(file, `${JSON.stringify(s, null, 1)}\n`);
    console.log(`rebuilt the certificate and heartbeat of ${s.steps.length} steps in ${spec.id}`);
  }
  // The dispute run: the same recomputation, and its four titles from their own steps.
  const disputeFile = join(OUT_DIR, `${DISPUTE_SPEC.id}.json`);
  if (existsSync(disputeFile)) {
    const d = JSON.parse(readFileSync(disputeFile, "utf8")) as RecordedDisputeScenario;
    const target = d.steps.at(-1)!.scan!.rows.find((r) => r.disputes?.length)!.captureId;
    d.steps.forEach((step, i) => {
      step.certificate = certificateOf(step.scan!, { rowsInsideListLag: rowsInsideListLag(step.session.orders, step.scan!.at) });
      step.heartbeat = heartbeatOfScan(step.scan!, step.session);
      step.step!.title = disputeTitle(DISPUTE_STEPS[i], step, target);
    });
    writeFileSync(disputeFile, `${JSON.stringify(d, null, 1)}\n`);
    console.log(`rebuilt the certificate, heartbeat and titles of ${d.steps.length} steps in ${DISPUTE_SPEC.id}`);
  }
}
if (has("rebuild")) {
  rebuild();
  process.exit(0);
}

// ---- the deployed shop and the local view of the same data ---------------------------------------------------------------------------------
loadEnv();
loadRedisEnv();
const TOKEN = liveToken();
const demo = appClient("demo");
const redis = redisFromEnv();
if (!redis) throw new Error("no Upstash settings (.env.vercel): the recording reads the shop's and the witness's records");
const store = new RedisShopStore(redis, "db:");
const witnessStore = new RedisWitnessStore(redis, { prefix: "db:", budgetPerMinute: 60 });
const frozen = JSON.parse(readFileSync(join(ROOT, "fixtures/demo-webhooks.frozen.json"), "utf8")) as { webhooks: { id: string; url: string }[] };
const hookOf = (suffix: string) => {
  const w = frozen.webhooks.find((x) => x.url.endsWith(suffix));
  if (!w) throw new Error(`no webhook ending ${suffix} in fixtures/demo-webhooks.frozen.json`);
  return w.id;
};
const SHOP_HOOK = hookOf("/api/shop/webhook");
const WITNESS_HOOK = hookOf("/api/witness");
const reads = new PaypalClientReads(demo);

const goodHandler = readFileSync(join(ROOT, "handlers/good.ts"), "utf8");

// The dispute run also asks PayPal for the disputes of each capture (the deployed shop does this on every scan); the other four runs were recorded without it.
// The fix is proven on the session's own deliveries once (the first step that has causes), whatever the number of snapshots built: the reviewed
// patch, the sandbox child process, and PayPal's verify endpoint on the stored deliveries. A patch the owner has not reviewed has no recorded
// result to prove again (lib/fix/recorded.ts), so a step then carries no fix.
function snapshotDeps(cache: Map<string, ReplayResult>, o: { disputes?: boolean } = {}): SnapshotDeps {
  const proved = new Map<string, Promise<FixResult | null>>();
  return {
    scan: { store, reads, shopWebhookId: SHOP_HOOK, log: () => undefined, ...(o.disputes ? { disputes: { reads: new PaypalClientDisputeReads(demo) } } : {}) },
    bundle: computeDiffs(ROOT),
    recordedReplays: JSON.parse(readFileSync(join(ROOT, "fixtures/replay/recorded.json"), "utf8")) as RecordedReplays,
    replay: { witness: () => witnessStore, webhookIdOf: () => WITNESS_HOOK, verify: (p) => demo.verifyWebhookSignature(p, 15_000), cache },
    fix: {
      prove: ({ mode, recorded, scan }) => {
        const key = `${scan.session.id}|${mode}`;
        if (!proved.has(key)) proved.set(key, proveOnSession({ witness: witnessStore, webhookIdOf: () => WITNESS_HOOK, verify: (p) => demo.verifyWebhookSignature(p, 15_000), goodText: goodHandler, patchedText: readPatched }, { recorded, scan }));
        return proved.get(key)!;
      },
    },
    log: (line) => console.log(`    [snapshot] ${JSON.stringify(line)}`),
  };
}

async function api<T>(path: string, sid?: string, body?: unknown): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(BASE + path, {
        method: "POST",
        headers: { "x-live-token": TOKEN, ...(sid ? { "x-session": sid } : {}), ...(body ? { "content-type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(45_000),
      });
      const text = await res.text();
      if (!res.ok) throw Object.assign(new Error(`POST ${path} -> HTTP ${res.status} ${text.slice(0, 120)}`), { status: res.status });
      return JSON.parse(text) as T;
    } catch (e) {
      const status = (e as { status?: number }).status;
      if (attempt >= 2 || (status !== undefined && status < 500)) throw e;
      await sleep(1500);
    }
  }
}

async function until<T>(what: string, timeoutMs: number, everyMs: number, f: () => Promise<T | undefined | false>): Promise<T | undefined> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    try {
      const v = await f();
      if (v) return v;
    } catch (e) {
      console.log(`    ${what}: ${e instanceof Error ? e.message.slice(0, 100) : "error"}`);
    }
    if (Date.now() > end) return undefined;
    await sleep(everyMs);
  }
}

// ---- one scenario's context ----------------------------------------------------------------------------------------------------------------
interface Ctx {
  spec: Spec;
  sid: string;
  caps: { healthy: string; gift: string[] };
  steps: { at: number; title: string; snapshot: RunSnapshot }[];
  notes: string[];
  startedAt: number;
  deps: SnapshotDeps;
}

const eventOf = (row: ScanRow | undefined, kind: "completed" | "refunded"): ScanEvent | undefined => row?.events.find((e) => e.kind === kind);
const rowOf = (scan: ScanResult, cap: string) => scan.rows.find((r) => r.captureId === cap);

async function scanNow(c: Ctx): Promise<ScanResult> {
  const session = (await store.getSession(c.sid))!;
  return (await scanSessionWithView(c.deps.scan, c.sid, session, { listing: true })).scan;
}

async function capture(c: Ctx, titleOf: string | ((s: RunSnapshot) => string)): Promise<RunSnapshot> {
  const session = (await store.getSession(c.sid))!;
  const snapshot = await buildLiveSnapshot(c.deps, c.sid, session);
  const title = typeof titleOf === "string" ? titleOf : titleOf(snapshot);
  c.steps.push({ at: Date.now(), title, snapshot });
  const n = snapshot.scan!.summary;
  console.log(`  [${c.spec.id}] step ${c.steps.length} "${title}": ${n.tied} tied / ${n.gaps} gap / ${n.unverified} unverified, stamp ${snapshot.certificate!.stamp}, causes ${snapshot.causes.length}${snapshot.causes[0] ? ` (${snapshot.causes[0].confirmation?.chip ?? "no confirmation"}${snapshot.causes[0].fix ? `, fix ${snapshot.causes[0].fix.verdict} ${snapshot.causes[0].fix.basis}` : ""})` : ""}`);
  return snapshot;
}

// PayPal's own resend, straight (the scenario trigger of last_write_wins: the old payment event is sent again, as if it came late).
async function rawResend(eid: string, giveUpAt: number): Promise<boolean> {
  while (Date.now() < giveUpAt) {
    try {
      await demo.request("resend event", "POST", `/v1/notifications/webhooks-events/${eid}/resend`, { body: { webhook_ids: [SHOP_HOOK] } });
      return true;
    } catch (e) {
      if (!(e instanceof PaypalError) || e.status !== 404) throw e;
      await sleep(6000); // not in PayPal's list yet
    }
  }
  return false;
}

type Outcome = { valid: true } | { valid: false; reason: string };
const invalid = (reason: string): Outcome => ({ valid: false, reason });

async function prelude(c: Ctx): Promise<Outcome> {
  const healthy = await api<{ order: { captureId: string } }>("/api/shop/order", c.sid, { item: "house-250" });
  c.caps.healthy = healthy.order.captureId;
  for (let i = 0; i < 2; i++) c.caps.gift.push((await api<{ order: { captureId: string } }>("/api/shop/order", c.sid, { item: "gift-set" })).order.captureId);
  const all = [c.caps.healthy, ...c.caps.gift];
  const booked = await until("three orders booked", LOSS_WINDOW_MS + 60_000, 4000, async () => {
    const scan = await scanNow(c);
    return all.every((cap) => rowOf(scan, cap)?.book?.state === "paid") && scan;
  });
  if (!booked) return invalid("the payment events of the three orders did not all reach the shop within 4 minutes (PayPal-side loss, F6)");
  return { valid: true };
}

async function refundGifts(c: Ctx): Promise<void> {
  for (const cap of c.caps.gift) await api("/api/shop/refund", c.sid, { captureId: cap });
}

// Ring again for every gift row, once the product says it is ready (the event is in PayPal's list and its own retries are over).
async function ringBoth(c: Ctx): Promise<Outcome> {
  const pending = new Set(c.caps.gift);
  const done = await until("ring", 420_000, 4000, async () => {
    const scan = await scanNow(c);
    for (const cap of [...pending]) {
      const row = rowOf(scan, cap);
      const ev = row?.events.find((e) => e.finding);
      if (row?.status === "TIED") {
        pending.delete(cap);
        continue;
      }
      if (ev?.ring?.state !== "ready") continue;
      const r = await api<{ sent: boolean }>("/api/shop/ring", c.sid, { captureId: cap });
      if (r.sent) pending.delete(cap);
    }
    return pending.size === 0 && true;
  });
  return done ? { valid: true } : invalid(`Ring again was not available for every row in 7 minutes (rows still waiting: ${pending.size})`);
}

// Waits until every gift row's heal has ended one way or another. Returns the scan.
async function healsSettled(c: Ctx): Promise<ScanResult | undefined> {
  return until("heals settled", 330_000, 5000, async () => {
    const scan = await scanNow(c);
    const ended = c.caps.gift.every((cap) => {
      const row = rowOf(scan, cap);
      const h = row?.events.find((e) => e.heal)?.heal;
      return row?.status === "TIED" || (!!h && (h.state === "healed" || h.state === "unchanged" || h.state === "lost"));
    });
    return ended && scan;
  });
}

// ---- the three scenarios -------------------------------------------------------------------------------------------------------------------
async function scenario(c: Ctx): Promise<Outcome> {
  if (c.spec.id === "dispute_never_heard") return disputeScenario(c);
  const pre = await prelude(c);
  if (!pre.valid) return pre;
  await api("/api/shop/mode", c.sid, { mode: c.spec.mode });
  await refundGifts(c);

  if (c.spec.id === "refund_never_booked") {
    // The shop answers 200 and drops the booking: both refunds are gaps as soon as the shop has answered and the books had 10 s.
    const found = await until("both refunds are gaps", 300_000, 4000, async () => {
      const scan = await scanNow(c);
      return c.caps.gift.every((cap) => eventOf(rowOf(scan, cap), "refunded")?.finding?.final && rowOf(scan, cap)?.status === "GAP") && scan;
    });
    if (!found) return invalid("the two refund gaps were not found within 5 minutes (a refund event that did not reach the shop, PayPal-side loss)");
    await capture(c, FIRST_TITLES.refund_never_booked);
  } else if (c.spec.id === "late_payment_overwrites") {
    // The refunds are booked; then the old payment events arrive again, late, and overwrite them.
    const booked = await until("refunds booked", 300_000, 4000, async () => {
      const scan = await scanNow(c);
      return c.caps.gift.every((cap) => rowOf(scan, cap)?.book?.state === "refunded") && scan;
    });
    if (!booked) return invalid("the two refunds were not booked within 5 minutes (PayPal-side loss)");
    for (const cap of c.caps.gift) {
      const eid = eventOf(rowOf(booked, cap), "completed")?.eid;
      if (!eid) return invalid("the payment event id is not known");
      let arrived = false;
      for (let n = 0; n < 3 && !arrived; n++) {
        if (!(await rawResend(eid, Date.now() + 320_000))) return invalid("PayPal never accepted the resend of the old payment event within 5 minutes");
        arrived = !!(await until("late payment arrives", 75_000, 4000, async () => {
          const scan = await scanNow(c);
          return new Set((eventOf(rowOf(scan, cap), "completed")?.s ?? []).filter((a) => a.state === "responded").map((a) => a.tid)).size >= 2 && scan;
        }));
      }
      if (!arrived) return invalid("the resent payment event was accepted by PayPal and never reached the shop in 3 tries (PayPal-side loss of the scenario trigger)");
    }
    const found = await until("both rows are gaps (out of order)", 120_000, 4000, async () => {
      const scan = await scanNow(c);
      return c.caps.gift.every((cap) => {
        const f = eventOf(rowOf(scan, cap), "refunded")?.finding;
        return f?.final && f.flag === "OUT_OF_ORDER" && rowOf(scan, cap)?.status === "GAP";
      }) && scan;
    });
    if (!found) return invalid("the two out-of-order gaps were not found within 2 minutes of the late payments");
    await capture(c, FIRST_TITLES.late_payment_overwrites);
  } else {
    // bad_body and wrong_webhook_id_setting: every delivery of the refund is answered 401. PayPal tries 3 times (about 0 s, 34 s and 160 s); the
    // timeline is complete once every refund has had its third attempt or 190 s have passed since its first.
    const over = await until("PayPal's attempts are over", 420_000, 5000, async () => {
      const scan = await scanNow(c);
      const attempts = (cap: string) => (eventOf(rowOf(scan, cap), "refunded")?.s ?? []).filter((a) => a.state === "responded" && a.status === 401);
      const complete = c.caps.gift.every((cap) => {
        const a = attempts(cap);
        return a.length >= 3 || (a.length > 0 && scan.at - Math.min(...a.map((x) => x.receivedAt ?? Infinity)) > 190_000);
      });
      return complete && c.caps.gift.every((cap) => rowOf(scan, cap)?.status === "GAP") && scan;
    });
    if (!over) return invalid("the rejected refund deliveries did not finish their attempts within 7 minutes (PayPal-side loss)");
    await capture(c, FIRST_TITLES[c.spec.id]);
  }

  // The first step has been taken: what a visitor sees first. The rest of the story follows what really happens.
  const first = c.steps[0].snapshot;
  if (first.scan!.summary.gaps < 2) return invalid(`the first step shows ${first.scan!.summary.gaps} gaps, not 2`);
  if (first.causes.length < 2) c.notes.push(`the first step has ${first.causes.length} causes for ${first.scan!.summary.gaps} gaps`);
  const replay = first.causes[0]?.replay;
  if (isPlanted(c.spec.mode) && replay?.basis !== "replayed") c.notes.push(`the replay in the first step is "${replay?.basis ?? "missing"}", not a live replay (the witness did not hold both deliveries, or the replay was not allowed)`);
  const fix = first.causes[0]?.fix;
  if (isPlanted(c.spec.mode) && fix?.basis !== "replayed") c.notes.push(`the fix in the first step is ${fix ? `"${fix.basis}", not proven on this session's deliveries` : "missing (no recorded fix, or the patch has not been reviewed: scripts/fix-review.ts)"}`);
  if (fix && fix.verdict !== "proven") c.notes.push("the reviewed patch was NOT proven on this session's deliveries; the step shows 'fix not proven'");

  // The fix is deployed.
  await api("/api/shop/mode", c.sid, { mode: "good" });
  await capture(c, FIX_TITLES[c.spec.id]);

  const rang = await ringBoth(c);
  if (!rang.valid) return rang;
  await capture(c, (snap) => ringTitle(snap, c.caps.gift));

  if (!(await healsSettled(c))) return invalid("the resends neither healed the rows nor ended within 5.5 minutes");
  const finalSnapshot = await capture(c, (snap) => finalTitle(snap, c.caps.gift));
  c.notes.push(`heals: ${JSON.stringify(c.caps.gift.map((cap) => { const row = rowOf(finalSnapshot.scan!, cap); return { status: row?.status, heal: row?.events.find((e) => e.heal)?.heal }; }))}`);
  return { valid: true };
}

// ---- the fifth scenario: the dispute your shop never heard -------------------------------------------------------------------------------------
// Three orders ($14.00, $48.00, $14.00); the middle one is charged back with the Sandbox-only process-chargeback call (the demo app's own keys; the body is
// lib/pay/chargeback.ts, the merchant id is the order's payee). No webhook is registered or changed; the shop runs the good handler.
// Timings measured on 2026-10-20 (docs/measurements/disputes-probe-2026-10-20.json, from the call): the disputes API lists the dispute after 39 to 100 s,
// the response-due date appears after 218 to 221 s, the capture shows PENDING after 175 to 204 s (and no PAYMENT.CAPTURE.PENDING event is ever made).
//   step 1 before   the three orders are tied
//   step 2 listed   the dispute is listed; the scan finds it (the shop's books have none, no webhook of the app subscribes to dispute events)
//   step 3 due      PayPal has set the response-due date and the capture shows PENDING (the row stays a dispute gap, not "a state the shop does not book")
//   step 4 ring     Ring again on the deployed shop: nothing is sent
// The deployed shop's own scan (POST /api/shop/scan) must show the same dispute, so that what a judge sees there is what was recorded here.
const randomDigits = (n: number): string => Array.from({ length: n }, () => Math.floor(Math.random() * 10)).join("");

async function disputeScenario(c: Ctx): Promise<Outcome> {
  type Made = { order: { n: number; captureId: string; orderId: string; amount: string; at: number } };
  const ordered: Made["order"][] = [];
  for (const item of ["house-250", "gift-set", "house-250"]) ordered.push((await api<Made>("/api/shop/order", c.sid, { item })).order);
  const target = ordered[1];
  c.caps = { healthy: ordered[0].captureId, gift: [target.captureId] };
  const booked = await until("three orders booked", LOSS_WINDOW_MS + 60_000, 4000, async () => {
    const scan = await scanNow(c);
    return ordered.every((o) => rowOf(scan, o.captureId)?.book?.state === "paid") && scan;
  });
  if (!booked) return invalid("the payment events of the three orders did not all reach the shop within 4 minutes (PayPal-side loss, F6)");

  // Step 1: nothing is wrong yet. If PayPal's dispute lists cannot be read at all, stop before a chargeback is made for nothing.
  const before = await capture(c, (snap) => disputeTitle("before", snap, target.captureId));
  if (before.scan!.summary.tied !== 3) return invalid(`before the chargeback ${before.scan!.summary.tied} of 3 orders were tied`);
  if (before.scan!.disputeReads?.unreadable !== 0) return invalid(`PayPal's dispute list could not be read for ${before.scan!.disputeReads?.unreadable ?? "all"} of the 3 orders (does the demo app have the disputes API?)`);

  // The chargeback. The merchant id is the order's payee; the capture has had 30 s to settle (the probe waited 30 s as well).
  const merchantId = (await demo.request<{ purchase_units?: { payee?: { merchant_id?: string } }[] }>("get order", "GET", `/v2/checkout/orders/${target.orderId}`)).purchase_units?.[0]?.payee?.merchant_id;
  if (!merchantId) return invalid("the order has no payee merchant id, which the chargeback call needs");
  await sleep(Math.max(0, target.at + 30_000 - Date.now()));
  const t0 = Date.now();
  try {
    await demo.request("process chargeback", "POST", "/v2/customer-support/process-chargeback", { body: chargebackBody({ merchantId, captureId: target.captureId, amount: target.amount, at: t0, respondWithinDays: 10, digits: randomDigits }) });
  } catch (e) {
    return invalid(`the chargeback call failed: ${e instanceof PaypalError ? e.message : "error"}`);
  }
  const since = (ms: number) => Math.round((ms - t0) / 1000);
  const disputeOf = (scan: ScanResult) => rowOf(scan, target.captureId)?.disputes?.[0];

  // Step 2: the scan finds the dispute.
  const listed = await until("the dispute is listed", 300_000, 5000, async () => {
    const scan = await scanNow(c);
    return rowOf(scan, target.captureId)?.status === "GAP" && !!disputeOf(scan)?.finding?.final && scan;
  });
  if (!listed) return invalid("PayPal did not list a dispute for the charged-back capture within 5 minutes of the call");
  c.notes.push(`the scan found the dispute ${since(listed.at)} s after the chargeback call`);
  const second = await capture(c, (snap) => disputeTitle("listed", snap, target.captureId));
  const found = disputeOf(second.scan!);
  if (found?.finding?.flag !== "UNSUBSCRIBED_EVENT_TYPE" || found.webhooks.any !== false) return invalid(`the dispute is not one that no webhook of the app subscribes to: finding ${found?.finding?.cls}/${found?.finding?.flag}, webhooks ${JSON.stringify(found?.webhooks)}`);

  // The deployed shop must see the same: it is the shop a judge uses, and its PayPal app is the one on Vercel.
  const deployed = await api<ScanResult>("/api/shop/scan", c.sid);
  const seen = rowOf(deployed, target.captureId);
  if (seen?.status !== "GAP" || !seen.disputes?.some((d) => d.finding?.final)) return invalid(`the deployed shop's scan does not show the dispute (row ${seen?.status ?? "missing"}, dispute reads ${JSON.stringify(deployed.disputeReads)}): is this change deployed, and can the app on Vercel read disputes?`);
  c.notes.push(`deployed scan: ${deployed.durationMs} ms, dispute reads ${JSON.stringify(deployed.disputeReads)}`);

  // Step 3: the response-due date, then the capture's PENDING status (not required: if it never shows, the step says COMPLETED and a note says so).
  const due = await until("the response-due date is set", 360_000, 5000, async () => {
    const scan = await scanNow(c);
    return disputeOf(scan)?.sellerResponseDueAt != null && scan;
  });
  if (!due) return invalid("PayPal did not set a response-due date within 6 minutes of the chargeback call");
  c.notes.push(`the response-due date was there ${since(due.at)} s after the call`);
  const pending = await until("the capture shows PENDING", 120_000, 5000, async () => {
    const scan = await scanNow(c);
    return rowOf(scan, target.captureId)?.paypalStatus === "PENDING" && scan;
  });
  c.notes.push(pending ? `the capture showed PENDING ${since(pending.at)} s after the call` : "the capture did not show PENDING within 2 minutes after the response-due date: step 3 says COMPLETED");
  await capture(c, (snap) => disputeTitle("due", snap, target.captureId));

  // Step 4: Ring again on the deployed shop. Nothing may be sent, and no resend may be counted against the session.
  const ring = await api<{ sent: boolean; ring?: { state: string; label: string } }>("/api/shop/ring", c.sid, { captureId: target.captureId });
  if (ring.sent !== false || ring.ring?.state !== "cannot_heal") return invalid(`Ring again on the disputed order answered ${JSON.stringify(ring).slice(0, 200)}, not "nothing sent"`);
  if ((await store.heals(c.sid)).resends !== 0) return invalid("Ring again on the disputed order counted a resend against the session");
  c.notes.push(`Ring again answered: ${ring.ring.state} / ${ring.ring.label}`);
  await capture(c, (snap) => disputeTitle("ring", snap, target.captureId));
  return { valid: true };
}

// ---- sanitizing and writing ----------------------------------------------------------------------------------------------------------------
function paypalIdsOf(steps: RunSnapshot[]): string[] {
  const ids = new Set<string>();
  for (const s of steps) {
    for (const o of s.session.orders) {
      ids.add(o.orderId);
      ids.add(o.captureId);
      for (const e of o.events) {
        ids.add(e.resourceId);
        if (e.eid) ids.add(e.eid);
      }
    }
    for (const row of s.scan?.rows ?? []) {
      for (const e of row.events) if (e.eid) ids.add(e.eid);
      for (const d of row.disputes ?? []) {
        ids.add(d.disputeId);
        if (d.eid) ids.add(d.eid);
      }
    }
  }
  return [...ids].filter((x) => /^[A-Za-z0-9_-]{10,}$/.test(x)).sort();
}

// The session id is replaced by a hash (the session has expired by the time anyone reads this, but it is a credential's shape); the first 8
// characters of it are also inside the invoice ids, so they go too.
function sanitize<T>(value: T, sid: string): T {
  const fake = createHash("sha256").update(`recorded:${sid}`).digest("hex").slice(0, 32);
  return JSON.parse(JSON.stringify(value).split(sid).join(fake).split(sid.slice(0, 8)).join(fake.slice(0, 8))) as T;
}

async function run(spec: Spec): Promise<{ scenario?: RecordedScenario | RecordedDisputeScenario; runs: unknown[] }> {
  const runs: unknown[] = [];
  for (let attempt = 1; attempt <= 3; attempt++) {
    const { session } = await api<{ session: string }>("/api/shop/session");
    const c: Ctx = { spec, sid: session, caps: { healthy: "", gift: [] }, steps: [], notes: [], startedAt: Date.now(), deps: snapshotDeps(new Map(), { disputes: spec.id === "dispute_never_heard" }) };
    console.log(`[${spec.id}] run ${attempt}: session ${session.slice(0, 8)}`);
    let outcome: Outcome;
    try {
      outcome = await scenario(c);
    } catch (e) {
      outcome = invalid(`the script failed: ${e instanceof Error ? e.message.slice(0, 200) : "error"}`);
    }
    runs.push({ attempt, session: session.slice(0, 8), valid: outcome.valid, reason: outcome.valid ? undefined : outcome.reason, seconds: Math.round((Date.now() - c.startedAt) / 1000), steps: c.steps.map((s) => ({ at: new Date(s.at).toISOString(), title: s.title })), notes: c.notes });
    if (!outcome.valid) {
      console.log(`[${spec.id}] run ${attempt} INVALID: ${outcome.reason}`);
      continue;
    }
    const of = c.steps.length;
    const steps: RunSnapshot[] = c.steps.map((s, i) => ({ ...s.snapshot, mode: "RECORDED RUN", recordedAt: s.at, step: { index: i + 1, of, title: s.title } }));
    const common = { title: spec.title, capturedAt: c.steps[0].at, steps, paypalIds: paypalIdsOf(steps) };
    const result: RecordedScenario | RecordedDisputeScenario = spec.id === "dispute_never_heard" ? { id: spec.id, plantedMode: "none", ...common } : { id: spec.id, plantedMode: spec.mode, ...common };
    // A recording that breaks a rule of the snapshot is not written: the same rules the tests run on the stored file. (lib/ui/check.ts does not yet know that a
    // row can be a gap because of a dispute, so its one rule about that is left to the dispute rules, which hold the dispute-aware form.)
    if (result.id === "dispute_never_heard") {
      const broken = [...checkDisputeScenario(result), ...steps.flatMap((st, i) => checkSnapshot(st).filter((v) => !/ is a gap without a final finding$/.test(v)).map((v) => `step ${i + 1}: ${v}`))];
      if (broken.length > 0) {
        runs[runs.length - 1] = { ...(runs[runs.length - 1] as object), valid: false, reason: `the recording breaks the snapshot rules: ${broken.join("; ").slice(0, 400)}` };
        console.log(`[${spec.id}] run ${attempt} INVALID: ${broken.join("; ")}`);
        continue;
      }
    }
    return { scenario: sanitize(result, session), runs };
  }
  return { runs };
}

const wanted = (flag("only") ?? SPECS.map((s) => s.id).join(",")).split(",");
console.log(`recording ${wanted.join(", ")} against ${BASE}`);
const toRecord = [...SPECS, DISPUTE_SPEC].filter((s) => wanted.includes(s.id));
const results = await Promise.all(toRecord.map(run));
mkdirSync(OUT_DIR, { recursive: true });
for (const r of results) {
  if (!r.scenario) continue;
  writeFileSync(join(OUT_DIR, `${r.scenario.id}.json`), `${JSON.stringify(r.scenario, null, 1)}\n`);
  console.log(`wrote fixtures/recorded-run/${r.scenario.id}.json (${r.scenario.steps.length} steps, ${r.scenario.paypalIds.length} PayPal ids)`);
}
const log = { at: new Date().toISOString(), base: BASE, scenarios: results.map((r, i) => ({ id: toRecord[i].id, recorded: !!r.scenario, runs: r.runs })) };
// The log of the dispute run has a name of its own, so that it cannot replace the log of the same day's other recordings.
const logName = wanted.length === 1 && wanted[0] === DISPUTE_SPEC.id ? "record-run-dispute" : "record-run";
const logFile = flag("out") ?? join(ROOT, `docs/measurements/${logName}-${new Date().toISOString().slice(0, 10)}.json`);
writeFileSync(logFile, `${JSON.stringify(log, null, 1)}\n`);
console.log(`wrote ${logFile}`);
if (results.some((r) => !r.scenario)) process.exit(1);
