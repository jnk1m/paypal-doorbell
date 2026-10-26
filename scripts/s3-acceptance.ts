// Live acceptance runs for the gap finder (plan A3, A4, A5) against the deployed site, real PayPal Sandbox (demo app), real Upstash.
// Each subcommand prints its numbers and writes a JSON log; it does not decide pass or fail for you.
//   a3 [--out file]                     A3: 24 orders (12 planted gaps, 12 healthy), deployed scans timed, then 5 mocked re-query failures in process
//   trials [--rounds 3] [--modes a,b] [--control] [--raw N] [--tag t] [--out file]   A4 + A5: every planted mode x rounds, each followed through the fix, "Ring again" and the heal; --control adds a run without the fix, --raw N adds N bad_body runs with a raw resend while PayPal retries
//   summary --files a.json,b.json [--a4 a.json] [--out file]   merges trial logs: A4 over the nine main trials of the --a4 file, A5 over all fix trials
//   cross [--out file]                  A5: five ring requests for another session's ids -> 403, nothing sent
//   absence [--out file]                A4/A5: absence claims on real PayPal events that the shop can never receive (the dev app's), timed against 6 minutes
//   reverify [--out file]               R1 via the scan: a quarantined delivery is re-verified by a scan
// SHOP_URL overrides https://paypal-doorbell.vercel.app. Needs .env (demo app keys for the truth check), .env.vercel (Upstash), .env.live.
//
// The invalidation rule is lib/gaps/invalidation.ts (pre-registered, plan R4): a trial in which PayPal itself lost an event is recorded
// as invalid with its reason, run again (at most 3 runs of a trial) and counted; more than 30% invalid means "environment unstable".
import { readFileSync, writeFileSync } from "node:fs";
import { judgeEvent, LOSS_WINDOW_MS, tally } from "../lib/gaps/invalidation.ts";
import { PaypalClientReads, type PaypalReads } from "../lib/gaps/reads.ts";
import { scanSession, type ScanEvent, type ScanResult, type ScanRow } from "../lib/gaps/scan.ts";
import { PaypalClient, PaypalError } from "../lib/pay/paypal.ts";
import { redisFromEnv } from "../lib/redis.ts";
import { RedisShopStore } from "../lib/shop/store.ts";
import type { Mode } from "../lib/shop/types.ts";
import type { SessionView } from "../lib/shop/view.ts";
import { RedisWitnessStore, type AttemptEntry } from "../lib/witness/store.ts";
import { appClient, liveToken, loadEnv, loadRedisEnv } from "./env.ts";

loadEnv();
loadRedisEnv();
const BASE = process.env.SHOP_URL ?? "https://paypal-doorbell.vercel.app";
const TOKEN = liveToken();
const demo: PaypalClient = appClient("demo");
const demoReads = new PaypalClientReads(demo);
const [command, ...rest] = process.argv.slice(2);
const flag = (name: string) => (rest.includes(`--${name}`) ? rest[rest.indexOf(`--${name}`) + 1] : undefined);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const rel = (at = Date.now()) => Math.round((at - t0) / 100) / 10;
const secs = (ms: number) => Math.round(ms / 100) / 10;

async function api<T>(method: "GET" | "POST", path: string, sid?: string, body?: unknown, tries = 2): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      const res = await fetch(BASE + path, {
        method,
        headers: { "x-live-token": TOKEN, ...(sid ? { "x-session": sid } : {}), ...(body ? { "content-type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(45_000),
      });
      const text = await res.text();
      if (!res.ok) throw Object.assign(new Error(`${method} ${path} -> HTTP ${res.status} ${text.slice(0, 120)}`), { status: res.status });
      return JSON.parse(text) as T;
    } catch (e) {
      const status = (e as { status?: number }).status;
      if (i >= tries || (status !== undefined && status < 500)) throw e;
      await sleep(1500);
    }
  }
}

async function scan(sid: string): Promise<{ r: ScanResult; ms: number }> {
  const t = Date.now();
  const r = await api<ScanResult>("POST", "/api/shop/scan", sid);
  return { r, ms: Date.now() - t };
}
const state = (sid: string) => api<SessionView>("GET", "/api/shop/state", sid);
const rowOf = (r: ScanResult, cap: string): ScanRow | undefined => r.rows.find((x) => x.captureId === cap);
const eventOf = (row: ScanRow | undefined, kind: "completed" | "refunded"): ScanEvent | undefined => row?.events.find((e) => e.kind === kind);
const answered = (e: ScanEvent | undefined) => (e?.s ?? []).filter((a) => a.state === "responded");
const truthOf = async (captureId: string) => (await demo.request<{ status: string }>("get capture", "GET", `/v2/payments/captures/${captureId}`)).status;

let shopWebhookId: string | undefined;
async function shopHook(): Promise<string> {
  shopWebhookId ??= (await demo.request<{ webhooks: { id: string; url: string }[] }>("list webhooks", "GET", "/v1/notifications/webhooks")).webhooks.find((w) => w.url.endsWith("/api/shop/webhook"))?.id;
  if (!shopWebhookId) throw new Error("no shop webhook on the demo app");
  return shopWebhookId;
}

// Asks PayPal for a resend straight (not through the product): the scenario trigger of last_write_wins, and the "resend while PayPal
// retries" measurement. Until the event is listed PayPal answers 404, so it is asked again every 6 s until `giveUpAt`.
async function rawResend(eid: string, giveUpAt: number): Promise<{ accepted: boolean; refusals: number; acceptedAt?: number; error?: string }> {
  const hook = await shopHook();
  let refusals = 0;
  while (Date.now() < giveUpAt) {
    try {
      await demo.request("resend event", "POST", `/v1/notifications/webhooks-events/${eid}/resend`, { body: { webhook_ids: [hook] } });
      return { accepted: true, refusals, acceptedAt: Date.now() };
    } catch (e) {
      if (!(e instanceof PaypalError) || e.status !== 404) return { accepted: false, refusals, error: e instanceof Error ? e.message : "error" };
      refusals++;
      await sleep(6000);
    }
  }
  return { accepted: false, refusals, error: "never accepted before the time was up" };
}

async function until<T>(what: string, timeoutMs: number, everyMs: number, f: () => Promise<T | undefined | false>): Promise<T | undefined> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    try {
      const v = await f();
      if (v) return v;
    } catch (e) {
      console.log(`  [${rel()}s] ${what}: ${e instanceof Error ? e.message.slice(0, 100) : "error"}`);
    }
    if (Date.now() > end) return undefined;
    await sleep(everyMs);
  }
}

const dump = (name: string, data: unknown) => {
  const file = flag("out") ?? `s3-${name}-${Date.now()}.json`;
  writeFileSync(file, JSON.stringify(data, null, 2));
  console.log(`wrote ${file}`);
};

// ------------------------------------------------------------------------------------------------------------------------
// A3
// ------------------------------------------------------------------------------------------------------------------------
async function a3() {
  const { session: sid } = await api<{ session: string }>("POST", "/api/shop/session");
  console.log(`session ${sid.slice(0, 8)}: 24 orders`);
  const caps: string[] = [];
  for (let i = 0; i < 24; i++) caps.push((await api<{ order: { captureId: string } }>("POST", "/api/shop/order", sid, { item: "gift-set" })).order.captureId);
  console.log(`  [${rel()}s] 24 orders placed`);
  const allPaid = await until("paid", 300_000, 8000, async () => {
    const { r } = await scan(sid);
    const n = r.rows.filter((x) => x.book?.state === "paid").length;
    console.log(`  [${rel()}s] booked paid: ${n}/24`);
    return n === 24 && r;
  });
  if (!allPaid) throw new Error("not all 24 payments were booked in 5 minutes (a PayPal-side loss? rerun)");

  const healthyRefunded = caps.slice(0, 6);
  const planted = caps.slice(6, 18);
  const healthyPaid = caps.slice(18);
  for (const c of healthyRefunded) await api("POST", "/api/shop/refund", sid, { captureId: c });
  const six = await until("refunds booked", 240_000, 8000, async () => {
    const { r } = await scan(sid);
    return healthyRefunded.every((c) => rowOf(r, c)?.book?.state === "refunded") && r;
  });
  if (!six) throw new Error("the 6 healthy refunds were not booked in 4 minutes");
  console.log(`  [${rel()}s] 6 healthy refunds booked; the bug is deployed (ack_then_drop), 12 refunds follow`);
  await api("POST", "/api/shop/mode", sid, { mode: "ack_then_drop" });
  for (const c of planted) await api("POST", "/api/shop/refund", sid, { captureId: c });
  const refundedAt = Date.now();
  const heard = await until("planted refunds answered", 300_000, 8000, async () => {
    const { r } = await scan(sid);
    const n = planted.filter((c) => answered(eventOf(rowOf(r, c), "refunded")).length > 0).length;
    console.log(`  [${rel()}s] planted refunds answered by the shop: ${n}/12`);
    return n === 12 && r;
  });
  if (!heard) console.log("  some planted refunds were not answered in 5 minutes: they will be found as whatever PayPal's loss makes them, and reported");
  await sleep(12_000);

  const runs = [];
  for (let i = 1; i <= 3; i++) {
    const { r, ms } = await scan(sid);
    const found = planted.filter((c) => rowOf(r, c)?.status === "GAP");
    const classes = Object.fromEntries(Object.entries(r.summary.byClass));
    const falseAlarms = [...healthyRefunded, ...healthyPaid].filter((c) => rowOf(r, c)?.status !== "TIED");
    runs.push({ run: i, clientMs: ms, serverMs: r.durationMs, deadlineHit: r.deadlineHit, found: found.length, falseAlarms: falseAlarms.length, classes, calls: r.calls, tied: r.summary.tied, unverified: r.summary.unverified, listing: r.listing });
    console.log(`  [${rel()}s] deployed scan ${i}: ${found.length}/12 planted found, ${falseAlarms.length} false alarms, ${r.summary.tied} tied, server ${r.durationMs} ms, client ${ms} ms, classes ${JSON.stringify(classes)}`);
    await sleep(2000);
  }

  // Five mocked re-query failures, in this process, against the same real session and real PayPal for every other read.
  const redis = redisFromEnv();
  if (!redis) throw new Error("no Upstash settings");
  const store = new RedisShopStore(redis, "db:");
  const session = await store.getSession(sid);
  const real = new PaypalClientReads(demo);
  const failing = new Set([...healthyRefunded.slice(0, 2), healthyPaid[0], planted[0], planted[1]]);
  const wrapped: PaypalReads = {
    capture: (id, t) => (failing.has(id) ? Promise.reject(new PaypalError("get capture", 503, "mocked", undefined)) : real.capture(id, t)),
    refund: (id, t) => real.refund(id, t),
    listedEvents: (s, t) => real.listedEvents(s, t),
    subscribedTypes: (w, t) => real.subscribedTypes(w, t),
    resend: () => Promise.reject(new Error("a scan must not resend")),
  };
  const mocked = await scanSession({ store, reads: wrapped, shopWebhookId: await shopHook() }, sid, session!);
  const hit = mocked.rows.filter((x) => failing.has(x.captureId));
  const tiedAmongFailed = hit.filter((x) => x.status === "TIED").length;
  const clean = await scanSession({ store, reads: real, shopWebhookId: await shopHook() }, sid, session!);
  const mockedResult = { failedReads: failing.size, rowsUnverified: hit.filter((x) => x.status === "UNVERIFIED").length, tiedAmongFailed, othersTied: mocked.rows.filter((x) => !failing.has(x.captureId) && x.status === "TIED").length, othersGap: mocked.rows.filter((x) => !failing.has(x.captureId) && x.status === "GAP").length, retries: mocked.calls.retries, serverMs: mocked.durationMs, cleanLocalScanMs: clean.durationMs };
  console.log(`  mocked: ${JSON.stringify(mockedResult)}`);

  dump("a3", { session: sid.slice(0, 8), refundedAt, heardAll: !!heard, runs, mocked: mockedResult });
  const ok = runs.every((x) => x.found === 12 && x.falseAlarms === 0 && x.serverMs <= 10_000 && x.clientMs <= 10_000) && tiedAmongFailed === 0;
  console.log(`A3: ${ok ? "numbers meet the criteria" : "CRITERIA NOT MET"}: found ${runs.map((x) => x.found).join("/")} of 12, false alarms ${runs.map((x) => x.falseAlarms).join("/")}, 5 failed reads -> TIED ${tiedAmongFailed}, 24-row scan ${runs.map((x) => x.serverMs).join("/")} ms (server) ${runs.map((x) => x.clientMs).join("/")} ms (client)`);
}

// ------------------------------------------------------------------------------------------------------------------------
// A4 + A5 trials
// ------------------------------------------------------------------------------------------------------------------------
type Planted = "ack_then_drop" | "bad_body" | "last_write_wins";
interface Variant {
  mode: Planted;
  label: string;
  fix: boolean; // deploy the fix (switch to good) before ringing; false = the negative control
  rawResendDuringRetries?: boolean; // bad_body only: also ask PayPal for a resend while its own retries are pending (measurement, not the product)
}
const EXPECTED: Record<Planted, { cls: string; flag?: string }> = {
  ack_then_drop: { cls: "ACKED_BUT_NOT_APPLIED" },
  bad_body: { cls: "HANDLER_REJECTING" },
  last_write_wins: { cls: "ACKED_BUT_NOT_APPLIED", flag: "OUT_OF_ORDER" },
};
const ABSENCE_CLASSES = new Set(["NO_REPORT", "NO_EVENT_FOUND"]);
const ABSENCE_MS = 6 * 60_000;

interface Poll {
  t: number; // seconds since the trial started
  at: number; // the scan's own clock, ms
  status: string;
  cls?: string;
  flag?: string;
  final?: boolean;
  waiting?: string;
  ring?: string;
  heal?: string;
  books?: string;
}

interface TrialLog {
  mode: Planted;
  label: string;
  session: string;
  valid: boolean;
  invalidReason?: string;
  note?: string;
  expected: string;
  seen?: { cls?: string; flag?: string; final?: boolean };
  classOk?: boolean;
  wrongFinal: string[];
  detection?: { secondsAfterDReceipt: number | null; secondsAfterGapCreated: number; gapCreatedBy: string; viaTrigger?: unknown };
  absence: { scansHoldingBack: number; claimsBeforeSixMinutes: number; claimsAfterSixMinutes: number };
  a4Set?: boolean; // one of the nine trials A4 counts (3 modes x 3)
  ringRefusedAfterReady?: number;
  earlyRing?: { state: string; sent: boolean }[];
  rawResend?: unknown;
  heal?: { readyAfterRefundS?: number; ringed: boolean; sends?: number; state?: string; arrivalSeconds?: number; answer?: number; timeToTiedAfterDetectionS?: number; timeToTiedAfterRingS?: number; rowTied?: boolean; paypal?: string; books?: string };
  expectedHeal: string;
  pass: boolean;
  failure?: string;
  seconds: number;
  polls: Poll[];
  ids: { capture: string; refund?: string; completedEid?: string | null; refundEid?: string | null };
}

const pollOf = (sc: ScanResult, row: ScanRow | undefined, t: number): Poll => {
  const ev = eventOf(row, "refunded");
  return { t, at: sc.at + sc.durationMs, status: row?.status ?? "?", cls: ev?.finding?.cls, flag: ev?.finding?.flag, final: ev?.finding?.final, waiting: ev?.finding?.waiting ?? row?.waiting, ring: ev?.ring?.state, heal: ev?.heal ? `${ev.heal.state}/${ev.heal.sends}` : undefined, books: row?.book?.state };
};

async function trial(v: Variant): Promise<TrialLog> {
  const started = Date.now();
  const T = () => Math.round((Date.now() - started) / 100) / 10;
  const expect = EXPECTED[v.mode];
  const { session: sid } = await api<{ session: string }>("POST", "/api/shop/session");
  const { order } = await api<{ order: { captureId: string; at: number } }>("POST", "/api/shop/order", sid, { item: "gift-set" });
  const cap = order.captureId;
  const orderAt = Date.now();
  const log: TrialLog = { mode: v.mode, label: v.label, session: sid.slice(0, 8), valid: true, expected: `${expect.cls}${expect.flag ? "+" + expect.flag : ""}`, wrongFinal: [], absence: { scansHoldingBack: 0, claimsBeforeSixMinutes: 0, claimsAfterSixMinutes: 0 }, expectedHeal: v.fix ? "healed" : "unchanged", pass: false, seconds: 0, polls: [], ids: { capture: cap } };
  let refundAtMs: number | undefined;
  let preRing = true; // wrong-class detection only counts until the ring is pressed
  const done = (over: Partial<TrialLog>): TrialLog => ({ ...log, ...over, seconds: Math.round((Date.now() - started) / 1000) });

  const observe = (sc: ScanResult): ScanRow | undefined => {
    const row = rowOf(sc, cap);
    const p = pollOf(sc, row, T());
    const last = log.polls[log.polls.length - 1];
    if (!last || JSON.stringify({ ...last, t: 0, at: 0 }) !== JSON.stringify({ ...p, t: 0, at: 0 })) log.polls.push(p);
    for (const e of row?.events ?? []) {
      const f = e.finding;
      if (!f) continue;
      if (f.waiting === "absence_window") log.absence.scansHoldingBack++;
      if (ABSENCE_CLASSES.has(f.cls)) {
        // An absence claim about an event is allowed 6 minutes after the action that made it (the payment, or the refund).
        if (sc.at < (e.kind === "completed" ? orderAt : refundAtMs ?? orderAt) + ABSENCE_MS) log.absence.claimsBeforeSixMinutes++;
        else log.absence.claimsAfterSixMinutes++;
      }
    }
    const f = eventOf(row, "refunded")?.finding;
    if (preRing && f?.final) {
      const key = `${f.cls}${f.flag ? "+" + f.flag : ""}`;
      if (key !== log.expected && !log.wrongFinal.includes(key)) log.wrongFinal.push(key);
    }
    return row;
  };
  const scanOnce = async () => {
    const { r } = await scan(sid);
    return { r, row: observe(r) };
  };

  // Validity of an event the trial depends on: independent of the gap finder (D's note and the shop's reporter from the state view, PayPal's own list).
  const validity = async (kind: "completed" | "refunded", resourceId: string, sinceAt: number, what: string) => {
    const v0 = await state(sid);
    const ev = v0.orders[0].events.find((e) => e.kind === kind);
    const listed = (await demoReads.listedEvents(sinceAt - 120_000, 15_000).catch(() => [])).some((l) => l.resourceId === resourceId);
    return judgeEvent({ what, sinceMs: Date.now() - sinceAt, dHeard: !!ev?.heard, listed, sReceived: (ev?.received ?? []).length > 0 });
  };

  // 1. the payment reaches the shop and is booked
  const paid = await until("paid", LOSS_WINDOW_MS + 20_000, 4000, async () => {
    const { row } = await scanOnce();
    return row?.book?.state === "paid" && row;
  });
  if (!paid) {
    const j = await validity("completed", cap, orderAt, "payment");
    return done(j.valid === false ? { valid: false, invalidReason: j.reason } : { failure: "the payment was not booked in 200 s although the shop received it" });
  }

  // 2. the bug is deployed and the order is refunded
  await api("POST", "/api/shop/mode", sid, { mode: v.mode });
  const actionAt = Date.now(); // the refund
  refundAtMs = actionAt;
  const refundOrder = (await api<{ order: { refund: { id: string } } }>("POST", "/api/shop/refund", sid, { captureId: cap })).order;
  const refundId = refundOrder.refund.id;
  log.ids.refund = refundId;

  // 3. what the gap finder says; for last_write_wins the old "payment completed" is first sent again, as if it had arrived late
  let lateAt: number | undefined;
  let trigger: unknown;
  if (v.mode === "last_write_wins") {
    const refundBooked = await until("refund booked", 200_000, 4000, async () => {
      const { row } = await scanOnce();
      return row?.book?.state === "refunded" && row;
    });
    if (!refundBooked) {
      const j = await validity("refunded", refundId, actionAt, "refund");
      return done(j.valid === false ? { valid: false, invalidReason: j.reason } : { failure: "the refund was not booked in 200 s" });
    }
    const completed = eventOf(refundBooked, "completed");
    log.ids.completedEid = completed?.eid ?? null;
    if (!completed?.eid) return done({ failure: "the payment event id is not known" });
    const sends: unknown[] = [];
    let arrived: ScanRow | undefined;
    for (let n = 0; n < 3 && !arrived; n++) {
      const r = await rawResend(completed.eid, Date.now() + 320_000);
      sends.push(r);
      if (!r.accepted) break;
      arrived = await until("late payment arrives", 60_000, 4000, async () => {
        const { row } = await scanOnce();
        return new Set(answered(eventOf(row, "completed")).map((a) => a.tid)).size >= 2 && row;
      });
    }
    trigger = sends;
    if (!arrived) return done({ valid: false, invalidReason: "the resent payment event was accepted by PayPal (or refused) and never reached the shop in 3 tries (PayPal-side loss of the scenario trigger)", rawResend: trigger });
    lateAt = Math.max(...answered(eventOf(arrived, "completed")).map((a) => a.receivedAt ?? 0));
  }

  const detected = await until("class", 240_000, v.mode === "bad_body" ? 3000 : 4000, async () => {
    const { r, row } = await scanOnce();
    const f = eventOf(row, "refunded")?.finding;
    return f?.final && f.cls === expect.cls && f.flag === expect.flag && { r, row };
  });
  if (!detected) {
    const last = log.polls[log.polls.length - 1];
    const j = await validity("refunded", refundId, actionAt, "refund");
    if (j.valid === false) return done({ valid: false, invalidReason: j.reason, rawResend: trigger });
    return done({ failure: `the expected class ${log.expected} was not seen in 240 s (last: ${JSON.stringify(last)})`, rawResend: trigger });
  }
  const ev = eventOf(detected.row, "refunded")!;
  const dAt = ev.d?.at ?? null;
  const sFirst = Math.min(...(ev.s ?? []).map((a) => a.receivedAt ?? Infinity));
  const doneAt = detected.r.at + detected.r.durationMs;
  const created = lateAt ?? dAt ?? sFirst;
  log.seen = { cls: ev.finding!.cls, flag: ev.finding!.flag, final: ev.finding!.final };
  log.classOk = true;
  log.ids.refundEid = ev.eid;
  log.detection = { secondsAfterDReceipt: dAt ? secs(doneAt - dAt) : null, secondsAfterGapCreated: secs(doneAt - created), gapCreatedBy: lateAt ? "the late payment event reached the shop (the witness is not asked to hear a resend)" : dAt ? "the witness heard the refund" : "the shop first received the refund (the witness did not hear it)", viaTrigger: trigger };
  const dMissing = dAt === null ? (await validity("refunded", refundId, actionAt, "refund")).valid === true : false;
  if (dMissing) log.note = "the witness did not hear the refund; the class rests on the shop's own record";
  const detectedAtServer = detected.r.at;
  console.log(`  [${T()}s] ${v.label} ${log.session}: ${log.expected} final ${log.detection.secondsAfterDReceipt ?? "?"} s after D, ${log.detection.secondsAfterGapCreated} s after the gap was created`);

  // 4. the early ring: just after the gap is found the event is almost never in PayPal's list yet (it shows up 80 to 163 s late), so
  // ringing must send nothing. The fix goes out first (except for bad_body, whose fix waits for PayPal's own retries to end, and the
  // control), so that a ring that does go out is a real one.
  if (v.fix && v.mode !== "bad_body") await api("POST", "/api/shop/mode", sid, { mode: "good" });
  log.earlyRing = [];
  let ringAt: number | undefined;
  {
    const early = await api<{ sent: boolean; ring?: { state: string } }>("POST", "/api/shop/ring", sid, { captureId: cap });
    log.earlyRing.push({ state: early.sent ? "SENT" : early.ring!.state, sent: early.sent });
    if (early.sent) {
      preRing = false; // it was already listed: this ring is the heal's
      ringAt = Date.now();
    }
  }

  // 5. bad_body: PayPal's own retries run for about 3 minutes; the ring stays disabled until they are over, then the fix goes out
  if (v.mode === "bad_body" && v.rawResendDuringRetries) {
    const mid = await until("second attempt", 120_000, 3000, async () => {
      const { row } = await scanOnce();
      const ev2 = eventOf(row, "refunded");
      return answered(ev2).length >= 2 && ev2?.finding && ev2;
    });
    if (mid?.eid) {
      const before = new Set(answered(mid).map((a) => a.tid));
      const r = await rawResend(mid.eid, Date.now() + 100_000);
      const got = r.accepted
        ? await until("resend while retrying", 60_000, 3000, async () => {
            const { row } = await scanOnce();
            const e2 = eventOf(row, "refunded");
            const fresh = answered(e2).filter((a) => !before.has(a.tid));
            return fresh.length > 0 && { status: fresh[0].status, secondsAfterAccepted: secs((fresh[0].receivedAt ?? 0) - (r.acceptedAt ?? 0)) };
          })
        : undefined;
      log.rawResend = { ...r, acceptedAt: undefined, arrivedWhileRetrying: got ?? null, productRingStateAtTheTime: log.polls[log.polls.length - 1]?.ring };
      console.log(`  [${T()}s] ${v.label} ${log.session}: resend while PayPal retries: ${JSON.stringify(log.rawResend)}`);
    }
  }
  if (v.mode === "bad_body" && ringAt === undefined) {
    // PayPal's retries are over when the third attempt has come or 190 s have passed since the first (read from the reporter's record,
    // not from the ring state, which says "not listed" first while the list is late).
    const over = await until("retries over", 260_000, 4000, async () => {
      const { r, row } = await scanOnce();
      const e2 = eventOf(row, "refunded");
      const attempts = e2?.s ?? [];
      // Every delivery (a transmission id; a resend has its own) has had its three attempts or 190 s.
      const byTid = new Map<string, { n: number; first: number }>();
      for (const a of attempts) {
        const g = byTid.get(a.tid) ?? { n: 0, first: Infinity };
        byTid.set(a.tid, { n: g.n + 1, first: Math.min(g.first, a.receivedAt ?? Infinity) });
      }
      return attempts.length > 0 && [...byTid.values()].every((g) => g.n >= 3 || r.at - g.first > 190_000) && e2;
    });
    if (!over) return done({ failure: "PayPal's retries did not end within 260 s", rawResend: log.rawResend });
    if (v.fix) await api("POST", "/api/shop/mode", sid, { mode: "good" }); // the fix goes out after PayPal gave up
  }

  // 6. ring again once the product says it is ready
  // PayPal's event list is not steady: a scan can see the event listed and the ring's own read a moment later not. The ring then sends
  // nothing and says why; the page would show the button again, so the run presses it again and counts how often that happened.
  let readyAt = ringAt;
  let refusedAfterReady = 0;
  if (ringAt === undefined) {
    const pressed = await until("ring", 300_000, 4000, async () => {
      const { row } = await scanOnce();
      const e2 = eventOf(row, "refunded");
      if (e2?.ring?.state !== "ready") return false;
      preRing = false;
      readyAt ??= Date.now();
      const ringed = await api<{ sent: boolean; ring?: { state: string } }>("POST", "/api/shop/ring", sid, { captureId: cap });
      if (!ringed.sent) {
        refusedAfterReady++;
        return false;
      }
      ringAt = Date.now();
      return true;
    });
    if (!pressed) {
      const j = await validity("refunded", refundId, actionAt, "refund");
      return done({ failure: `Ring again never went out in 300 s (last ring state ${log.polls[log.polls.length - 1]?.ring}, refused after ready ${refusedAfterReady})`, rawResend: log.rawResend, ...(j.valid === false ? { valid: false, invalidReason: j.reason } : {}) });
    }
  }
  log.ringRefusedAfterReady = refusedAfterReady;
  log.heal = { readyAfterRefundS: secs((readyAt ?? ringAt ?? actionAt) - actionAt), ringed: true };

  // 7. the heal: arrival is confirmed from the reporter, the books are read again
  const healed = await until("heal", 300_000, 4000, async () => {
    const { r, row } = await scanOnce();
    const h = eventOf(row, "refunded")?.heal;
    return (h?.state === "healed" || h?.state === "unchanged" || h?.state === "lost") && { r, row, h };
  });
  if (!healed) return done({ failure: "the resend neither healed nor was reported unchanged or lost in 300 s", rawResend: log.rawResend });
  const final = await scan(sid);
  const finalRow = observe(final.r);
  const truth = await truthOf(cap);
  const h = healed.h;
  log.heal = { ...log.heal, sends: h.sends, state: h.state, arrivalSeconds: h.arrivalSeconds, answer: h.answer, timeToTiedAfterDetectionS: secs(healed.r.at + healed.r.durationMs - detectedAtServer), timeToTiedAfterRingS: secs(healed.r.at + healed.r.durationMs - ringAt!), rowTied: finalRow?.status === "TIED", paypal: truth, books: finalRow?.book?.state };
  // The same rule as for any event (lib/gaps/invalidation.ts): PayPal accepted the resend (202) every time and delivered none of them.
  // The numbers stay in the log either way; the trial is only not counted as a pass or a failure of the shop.
  if (h.state === "lost") return done({ valid: false, invalidReason: `PayPal accepted ${h.sends} resends of an event it lists (HTTP 202) and none reached the shop within 60 s each (PayPal-side loss of the resend, the same kind as F6)` });
  const healOk = v.fix ? h.state === "healed" && finalRow?.status === "TIED" && finalRow.book?.state === "refunded" : h.state === "unchanged" && finalRow?.status === "GAP" && finalRow.book?.state === "paid";
  const absenceOk = log.absence.claimsBeforeSixMinutes === 0;
  log.pass = healOk && absenceOk && log.wrongFinal.length === 0 && truth === "REFUNDED";
  if (!log.pass) log.failure = `heal ${healOk ? "ok" : `NOT as expected (${h.state}, row ${finalRow?.status}, books ${finalRow?.book?.state})`}; absence claims before 6 minutes ${log.absence.claimsBeforeSixMinutes}; wrong final classes ${JSON.stringify(log.wrongFinal)}; PayPal says ${truth}`;
  console.log(`  [${T()}s] ${v.label} ${log.session}: heal ${h.state}, ${h.sends} send(s), arrival ${h.arrivalSeconds} s after the 202, TIED ${log.heal.timeToTiedAfterDetectionS} s after detection`);
  void detectedAtServer;
  return done({});
}

async function validTrial(v: Variant, max = 3): Promise<TrialLog[]> {
  const out: TrialLog[] = [];
  for (let i = 0; i < max; i++) {
    let t: TrialLog;
    try {
      t = await trial(v);
    } catch (e) {
      t = { mode: v.mode, label: v.label, session: "?", valid: true, expected: "?", wrongFinal: [], absence: { scansHoldingBack: 0, claimsBeforeSixMinutes: 0, claimsAfterSixMinutes: 0 }, expectedHeal: "?", pass: false, failure: `the script failed: ${e instanceof Error ? e.message.slice(0, 200) : "error"}`, seconds: 0, polls: [], ids: { capture: "?" } };
    }
    out.push(t);
    console.log(`[${rel()}s] ${v.label}${i ? ` (run ${i + 1})` : ""} ${t.session}: ${t.valid ? (t.pass ? "PASS" : `FAIL ${t.failure ?? ""}`) : `INVALID ${t.invalidReason}`}`);
    if (t.valid) break;
  }
  return out;
}

const MAIN_LABEL = /^(ack_then_drop|bad_body|last_write_wins) #\d+$/; // the trials A4 counts: 3 modes x 3

function summarize(a4Trials: TrialLog[], all: TrialLog[]) {
  const main = a4Trials.filter((t) => MAIN_LABEL.test(t.label));
  const mainValid = main.filter((t) => t.valid);
  const classRight = mainValid.filter((t) => t.classOk && t.wrongFinal.length === 0 && t.absence.claimsBeforeSixMinutes === 0);
  const fixTrials = all.filter((t) => t.expectedHeal === "healed");
  const fixValid = fixTrials.filter((t) => t.valid);
  const healed = fixValid.filter((t) => t.heal?.state === "healed" && t.heal.rowTied);
  const arrival = healed.map((t) => t.heal!.arrivalSeconds).filter((x): x is number => x !== undefined);
  const early = all.flatMap((t) => t.earlyRing ?? []);
  const sendsLog = all.filter((t) => t.heal?.sends !== undefined).map((t) => ({ mode: t.mode, label: t.label, valid: t.valid, state: t.heal!.state, sends: t.heal!.sends! }));
  const sends = sendsLog.reduce((n, x) => n + x.sends, 0);
  const arrivedSends = sendsLog.filter((x) => x.state === "healed" || x.state === "unchanged").length; // one send per finished heal is the one that arrived
  return {
    attempts: all.length,
    tally: tally(all.map((x) => ({ valid: x.valid }))),
    invalidReasons: all.filter((t) => !t.valid).map((t) => `${t.label}: ${t.invalidReason}`),
    a4: {
      plannedTrials: 9,
      validTrials: mainValid.length,
      withTheExpectedClass: classRight.length,
      confirmedWrong: mainValid.reduce((n, x) => n + x.wrongFinal.length, 0),
      absenceClaimsBeforeSixMinutes: all.reduce((n, x) => n + x.absence.claimsBeforeSixMinutes, 0),
      scansThatHeldAnAbsenceClaimBack: all.reduce((n, x) => n + x.absence.scansHoldingBack, 0),
      finalSecondsAfterD: mainValid.filter((t) => t.detection).map((t) => ({ mode: t.mode, afterDReceipt: t.detection!.secondsAfterDReceipt, afterGapCreated: t.detection!.secondsAfterGapCreated })),
    },
    a5: {
      validFixTrials: fixValid.length,
      healed: healed.length,
      arrivalSecondsAfter202: arrival,
      arrivalMax: arrival.length ? Math.max(...arrival) : null,
      sendsPerHeal: healed.map((x) => x.heal!.sends),
      timeFromDetectionToTiedSeconds: healed.map((x) => x.heal!.timeToTiedAfterDetectionS),
      timeFromRingToTiedSeconds: healed.map((x) => x.heal!.timeToTiedAfterRingS),
      sendsInAllTrials: sends,
      sendsThatArrived: arrivedSends,
      ringRefusedAfterReady: all.reduce((n, x) => n + (x.ringRefusedAfterReady ?? 0), 0),
      earlyRings: early.length,
      earlyRingsNotListed: early.filter((x) => x.state === "not_listed").length,
      earlyRingsThatSentSomething: early.filter((x) => x.sent).length,
      earlyRingStates: Object.fromEntries([...new Set(early.map((x) => x.state))].map((st) => [st, early.filter((x) => x.state === st).length])),
      controlNoFix: all.filter((t) => t.expectedHeal === "unchanged" && t.valid).map((t) => ({ state: t.heal?.state, rowTied: t.heal?.rowTied, books: t.heal?.books })),
      resendWhilePayPalRetries: all.filter((t) => t.rawResend).map((t) => t.rawResend),
    },
  };
}

async function trials() {
  const rounds = Number(flag("rounds") ?? 3);
  const modes = (flag("modes") ?? "ack_then_drop,bad_body,last_write_wins").split(",") as Planted[];
  const tag = flag("tag") ? `${flag("tag")} ` : "";
  const variants: Variant[] = [];
  for (const mode of modes) for (let i = 1; i <= rounds; i++) variants.push({ mode, label: `${tag}${mode} #${i}`, fix: true });
  if (rest.includes("--control")) variants.push({ mode: "ack_then_drop", label: `${tag}ack_then_drop control (no fix)`, fix: false });
  for (let i = 1; i <= Number(flag("raw") ?? 0); i++) variants.push({ mode: "bad_body", label: `${tag}bad_body+raw resend #${i}`, fix: true, rawResendDuringRetries: true });
  const all = (await Promise.all(variants.map((v) => validTrial(v)))).flat();
  const summary = summarize(tag ? [] : all, all);
  console.log(JSON.stringify(summary, null, 1));
  dump("trials", { summary, trials: all });
}

// Merges trial logs: A4 is counted over the nine main trials of one file, A5 over every fix trial in all of them.
function summary() {
  const files = (flag("files") ?? "").split(",").filter(Boolean);
  const a4File = flag("a4");
  const load = (f: string) => (JSON.parse(readFileSync(f, "utf8")) as { trials: TrialLog[] }).trials;
  const all = files.flatMap(load);
  const out = summarize(a4File ? load(a4File) : [], all);
  console.log(JSON.stringify(out, null, 1));
  dump("summary", out);
}

// ------------------------------------------------------------------------------------------------------------------------
// A5: another session's ids
// ------------------------------------------------------------------------------------------------------------------------
async function cross() {
  const [a, b] = await Promise.all([api<{ session: string }>("POST", "/api/shop/session"), api<{ session: string }>("POST", "/api/shop/session")]);
  const { order: oa } = await api<{ order: { captureId: string; orderId: string } }>("POST", "/api/shop/order", a.session, { item: "gift-set" });
  await api("POST", "/api/shop/order", b.session, { item: "gift-set" });
  await until("A paid", 200_000, 5000, async () => rowOf((await scan(a.session)).r, oa.captureId)?.book?.state === "paid");
  const refund = (await api<{ order: { refund: { id: string } } }>("POST", "/api/shop/refund", a.session, { captureId: oa.captureId })).order.refund.id;
  const evs = await until("A's events known", 120_000, 5000, async () => {
    const row = rowOf((await scan(a.session)).r, oa.captureId);
    const c = eventOf(row, "completed")?.eid;
    const r = eventOf(row, "refunded")?.eid;
    return c && r ? { c, r } : undefined;
  });
  const ids = { "A's capture id": oa.captureId, "A's refund id": refund, "A's order id": oa.orderId, "A's payment event id": evs?.c ?? "WH-UNKNOWN-0000000000", "A's refund event id": evs?.r ?? "WH-UNKNOWN-0000000001" };
  const results = [];
  for (const [what, id] of Object.entries(ids)) {
    const res = await fetch(`${BASE}/api/shop/ring`, { method: "POST", headers: { "x-live-token": TOKEN, "x-session": b.session, "content-type": "application/json" }, body: JSON.stringify({ captureId: id }), signal: AbortSignal.timeout(30_000) });
    const text = await res.text();
    results.push({ what, status: res.status, body: text.slice(0, 120) });
  }
  const sa = (await scan(a.session)).r;
  const sb = (await scan(b.session)).r;
  const out = { results, statuses: results.map((r) => r.status), resendsUsedA: sa.resendsUsed, resendsUsedB: sb.resendsUsed, sameBody: new Set(results.map((r) => r.body.replace(/"id":"[^"]*"/, ""))).size === 1 };
  console.log(JSON.stringify(out, null, 1));
  console.log(`A5 cross-session: ${results.filter((r) => r.status === 403).length}/${results.length} refused with 403; resends used: A ${sa.resendsUsed}, B ${sb.resendsUsed}`);
  dump("cross", out);
}

// ------------------------------------------------------------------------------------------------------------------------
// Absence claims on real PayPal events that the shop can never receive (events of the dev app)
// ------------------------------------------------------------------------------------------------------------------------
// The dev app and the demo app share one Sandbox business account and the demo app's token can read the dev app's captures (measured),
// but the events of one app go to that app's webhooks only. So a dev-app payment is heard by the witness (the dev app's witness webhook
// delivers to the same URL), is not in the demo app's list, and never reaches the shop: a real NO_REPORT-shaped state. A payment of
// the Gate 3 probe (a day old, from before the witness existed) is in no store and no list: a real NO_EVENT_FOUND-shaped state.
async function absence() {
  const redis = redisFromEnv();
  if (!redis) throw new Error("no Upstash settings");
  const store = new RedisShopStore(redis, "db:");
  const dev = appClient("dev");
  const { session: sid } = await api<{ session: string }>("POST", "/api/shop/session");
  const card = { number: "4111111111111111", expiry: "2030-12", security_code: "123", name: "Doorbell Test" };
  const made = await dev.request<{ purchase_units: { payments: { captures: { id: string }[] } }[]; id: string }>("create order", "POST", "/v2/checkout/orders", {
    prefer: true,
    body: { intent: "CAPTURE", purchase_units: [{ invoice_id: `S3-ABS-${Date.now()}`, amount: { currency_code: "USD", value: "48.00" } }], payment_source: { card } },
  });
  const heardCap = made.purchase_units[0].payments.captures[0].id;
  const t1 = Date.now();
  const probeCap = "6UL33397U6583961H"; // Gate 3 probe, 2026-10-18: PayPal never listed it and no webhook was called
  const probeRefunded = { capture: "39899159YE2380606", refund: "8JR10618TJ846282M" }; // Gate 3 probe: a refund PayPal also never reported
  const orders = [
    { n: 1, item: "gift-set", amount: "48.00", orderId: made.id, captureId: heardCap, invoiceId: "S3-ABS-1", at: t1 },
    { n: 2, item: "gift-set", amount: "48.00", orderId: "PROBE-ORDER-0001", captureId: probeCap, invoiceId: "S3-ABS-2", at: t1 },
    { n: 3, item: "gift-set", amount: "48.00", orderId: "PROBE-ORDER-0002", captureId: probeRefunded.capture, invoiceId: "S3-ABS-3", at: t1, refund: { id: probeRefunded.refund, invoiceId: "S3-ABS-3-R", at: t1 } },
  ];
  for (const o of orders) await store.putOrder(sid, o);
  console.log(`session ${sid.slice(0, 8)}: dev-app payment ${heardCap} (the witness will hear it, the shop never), two Gate 3 probe payments (nobody has them)`);

  const checks: unknown[] = [];
  const kinds = (r: ScanResult) => orders.map((o) => ({ n: o.n, status: rowOf(r, o.captureId)?.status, ev: ["completed", "refunded"].map((k) => { const e = eventOf(rowOf(r, o.captureId), k as "completed" | "refunded"); return e?.finding ? `${e.kind}:${e.finding.cls}${e.finding.flag ? "+" + e.finding.flag : ""}:${e.finding.waiting ?? "final"}:${e.ring?.state}` : null; }).filter(Boolean) }));
  const at = async (label: string, wantMs: number) => {
    const wait = t1 + wantMs - Date.now();
    if (wait > 0) await sleep(wait);
    const { r } = await scan(sid);
    const ring = await api<{ sent: boolean; ring?: { state: string } }>("POST", "/api/shop/ring", sid, { captureId: heardCap });
    const ring2 = await api<{ sent: boolean; ring?: { state: string } }>("POST", "/api/shop/ring", sid, { captureId: probeCap });
    const entry = { label, afterMs: Date.now() - t1, rows: kinds(r), rings: [ring.sent ? "SENT" : ring.ring?.state, ring2.sent ? "SENT" : ring2.ring?.state], resendsUsed: r.resendsUsed };
    checks.push(entry);
    console.log(`  [${rel()}s] ${label}: ${JSON.stringify(entry.rows)} rings ${JSON.stringify(entry.rings)} resends ${r.resendsUsed}`);
  };
  await at("30 s", 30_000);
  await at("2 min", 120_000);
  await at("5 min", 300_000);
  await at("5 min 50 s", 350_000);
  await at("7 min", 7 * 60_000 + 20_000); // the witness heard the dev payment about 11 s after it was made, so its 6 minutes end after 6 min 11 s
  await at("8 min", 8 * 60_000);
  dump("absence", { session: sid.slice(0, 8), heardCap, checks });
}

// ------------------------------------------------------------------------------------------------------------------------
// R1 through the scan: a quarantined delivery is re-verified by a scan
// ------------------------------------------------------------------------------------------------------------------------
async function reverify() {
  loadRedisEnv();
  const redis = redisFromEnv();
  if (!redis) throw new Error("no Upstash settings");
  const witness = new RedisWitnessStore(redis, { prefix: "db:", budgetPerMinute: 60 });
  // The newest stored delivery with a body, no older than 40 minutes (a stored signature is re-verified fine up to at least that age).
  let newest: AttemptEntry | undefined;
  let cursor: string | number = 0;
  do {
    const [next, keys]: [string, string[]] = await redis.scan(cursor, { match: "db:w:att:*", count: 500 });
    for (const key of keys) {
      const [row] = await redis.lrange<string>(key, 0, 0);
      const e = JSON.parse(String(row)) as AttemptEntry;
      if (e.raw && e.slot === "D" && e.st === "ok" && Date.now() - e.at < 40 * 60_000 && (!newest || e.at > newest.at)) newest = e;
    }
    cursor = next;
  } while (String(cursor) !== "0");
  if (!newest) throw new Error("no stored delivery of the witness D from the last 40 minutes: make a payment first");
  // Make it look as if it had been quarantined: the processed record is removed and the same delivery is pushed to the ring.
  await redis.del(`db:w:att:${newest.tid}`);
  await witness.quarantine({ ...newest, st: "q", why: "unavail" });
  const before = (await witness.listQuarantined(1000)).length;
  console.log(`quarantined delivery ${newest.tid.slice(0, 8)} (${newest.type}); ring size ${before}`);
  const { session: sid } = await api<{ session: string }>("POST", "/api/shop/session");
  const seen: unknown[] = [];
  const resolved = await until("re-verified by a scan", 180_000, 8000, async () => {
    const { r } = await scan(sid);
    const ring = (await witness.listQuarantined(1000)).length;
    const att = await witness.attempts(newest!.tid);
    seen.push({ afterS: rel(), reverify: r.reverify, ring, attempts: att.length, rv: att[0]?.rv });
    console.log(`  [${rel()}s] ring ${ring}, attempts ${att.length}, scan said ${JSON.stringify(r.reverify)}`);
    return att.length > 0 && att[0].st === "ok" && att[0].rv !== undefined && { ring, att: att[0] };
  });
  const out = { tid: newest.tid.slice(0, 8), type: newest.type, ringBefore: before, resolved: !!resolved, ringAfter: resolved?.ring, scans: seen };
  console.log(`R1 via the scan: ${resolved ? "re-verified, back in the attempts with rv set" : "NOT re-verified in 180 s"}`);
  dump("reverify", out);
}

if (command === "a3") await a3();
else if (command === "trials") await trials();
else if (command === "summary") summary();
else if (command === "cross") await cross();
else if (command === "absence") await absence();
else if (command === "reverify") await reverify();
else throw new Error("usage: s3-acceptance.ts a3 | trials [--rounds 3] [--modes a,b] [--control] [--raw N] [--tag t] | summary --files a,b [--a4 a] | cross | absence | reverify  [--out file]");
void ({} as Mode);
