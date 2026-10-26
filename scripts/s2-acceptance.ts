// Live acceptance runs for the demo shop (plan A11, A24 live side) against the deployed site, real PayPal Sandbox (demo app), real Upstash.
// Each subcommand prints the numbers and writes a JSON log; it does not decide pass or fail for you.
//   modes [--rounds 3] [--only <mode>] [--out file]   A11: every planted mode x rounds, one fresh session each (all in parallel), plus a "good" control
//   pairs [--out file]                  A11: three pairs of sessions in different modes, run at the same time, independent
// SHOP_URL overrides https://paypal-doorbell.vercel.app. Needs .env (demo app keys, for the truth check and the resend) and .env.live.
//
// A trial is invalid, and is run again and reported, when the first event it depends on reached neither the witness D nor the shop S:
// the loss happened on PayPal's side (F6), the shop was never given the chance (plan R4). A trial where D heard an event and S did not is a failure.
import { writeFileSync } from "node:fs";
import type { PaypalClient } from "../lib/pay/paypal.ts";
import type { AttemptReport } from "../lib/shop/reporter.ts";
import type { Mode } from "../lib/shop/types.ts";
import type { OrderView, SessionView } from "../lib/shop/view.ts";
import { appClient, liveToken, loadEnv } from "./env.ts";

loadEnv();
const BASE = process.env.SHOP_URL ?? "https://paypal-doorbell.vercel.app";
const TOKEN = liveToken();
const demo: PaypalClient = appClient("demo");
const [command, ...rest] = process.argv.slice(2);
const flag = (name: string) => rest[rest.indexOf(`--${name}`) + 1];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const rel = (at = Date.now()) => Math.round((at - t0) / 100) / 10;

async function api<T>(method: "GET" | "POST", path: string, sid?: string, body?: unknown): Promise<T> {
  const res = await fetch(BASE + path, {
    method,
    headers: { "x-live-token": TOKEN, ...(sid ? { "x-session": sid } : {}), ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(40_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> HTTP ${res.status} ${text.slice(0, 120)}`);
  return JSON.parse(text) as T;
}

const state = (sid: string) => api<SessionView>("GET", "/api/shop/state", sid);
async function until<T>(sid: string, pick: (o: OrderView, v: SessionView) => T | undefined | false, timeoutMs: number, everyMs = 4000): Promise<T | undefined> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await state(sid);
    const hit = pick(v.orders[0], v);
    if (hit) return hit;
    if (Date.now() > end) return undefined;
    await sleep(everyMs);
  }
}

let shopWebhookId: string | undefined;
async function resendTo(eid: string): Promise<number> {
  shopWebhookId ??= (await demo.request<{ webhooks: { id: string; url: string }[] }>("list webhooks", "GET", "/v1/notifications/webhooks")).webhooks.find((w) => w.url.endsWith("/api/shop/webhook"))?.id;
  if (!shopWebhookId) throw new Error("no shop webhook on the demo app");
  // Until the event is listed (38-54 s after it happened, measured) a resend answers 404; try again.
  for (let i = 0; i < 40; i++) {
    try {
      await demo.request("resend event", "POST", `/v1/notifications/webhooks-events/${eid}/resend`, { body: { webhook_ids: [shopWebhookId] } });
      return i;
    } catch (e) {
      if (!(e instanceof Error) || !/HTTP 404/.test(e.message)) throw e;
      await sleep(8000);
    }
  }
  throw new Error(`resend of ${eid} never accepted`);
}

const truthOf = async (captureId: string) => (await demo.request<{ status: string }>("get capture", "GET", `/v2/payments/captures/${captureId}`)).status;
const answered = (a: AttemptReport[] | null) => (a ?? []).filter((x) => x.state === "responded");

interface Trial {
  mode: Mode;
  control: boolean;
  session: string;
  valid: boolean;
  invalidWhy?: string;
  pass: boolean;
  expected: string;
  observed: Record<string, unknown>;
  seconds: number;
}

async function trial(mode: Mode, opts: { control?: boolean; rendezvous?: () => Promise<void>; watchRetries?: boolean } = {}): Promise<Trial> {
  const started = Date.now();
  const { session: sid } = await api<{ session: string }>("POST", "/api/shop/session");
  const { order } = await api<{ order: { captureId: string } }>("POST", "/api/shop/order", sid, { item: "gift-set" });
  const observed: Record<string, unknown> = { orderAt: rel() };
  const done = (partial: Pick<Trial, "valid" | "pass" | "expected"> & { invalidWhy?: string }): Trial => ({ mode, control: !!opts.control, session: sid.slice(0, 8), observed, seconds: Math.round((Date.now() - started) / 1000), ...partial });

  // 1. The payment reaches the shop and is booked (the handler is still the working one).
  const paid = await until(sid, (o) => o.book?.state === "paid" && o, 180_000);
  if (!paid) {
    const v = await state(sid);
    const ev = v.orders[0].events[0];
    observed.completed = { heardByD: !!ev?.heard, receivedByS: ev?.received ?? null };
    const lost = !ev?.heard && !ev?.received;
    return done({ valid: !lost, invalidWhy: lost ? "the payment event reached neither D nor S in 180 s (PayPal-side loss)" : undefined, pass: false, expected: "payment booked as paid", });
  }
  observed.paidAt = rel();

  // 2. The bug is deployed and the order is refunded.
  await opts.rendezvous?.();
  await api("POST", "/api/shop/mode", sid, { mode });
  await api("POST", "/api/shop/refund", sid, { captureId: order.captureId });
  observed.refundAt = rel();

  // 3. What the shop does with the refund.
  const refunded = await until(sid, (o) => answered(o.events.find((e) => e.kind === "refunded")?.received ?? null).length > 0 && o, 180_000);
  if (!refunded) {
    const ev = (await state(sid)).orders[0].events.find((e) => e.kind === "refunded");
    observed.refunded = { heardByD: !!ev?.heard, receivedByS: ev?.received ?? null };
    const lost = !ev?.heard && !ev?.received;
    return done({ valid: !lost, invalidWhy: lost ? "the refund event reached neither D nor S in 180 s (PayPal-side loss)" : undefined, pass: false, expected: "refund event answered by the shop" });
  }
  const first = answered(refunded.events.find((e) => e.kind === "refunded")!.received)[0];
  observed.refundAnsweredAt = rel(first.respondedAt);
  observed.refundFirstStatus = first.status;

  if (mode === "ack_then_drop") {
    await sleep(15_000);
    const o = (await state(sid)).orders[0];
    const truth = await truthOf(order.captureId);
    Object.assign(observed, { books: o.book?.state, truth, answers: answered(o.events.find((e) => e.kind === "refunded")!.received).map((a) => a.status) });
    return done({ valid: true, pass: first.status === 200 && o.book?.state === "paid" && truth === "REFUNDED", expected: "refund answered 200, books still paid, PayPal says REFUNDED" });
  }

  if (mode === "bad_body") {
    const wanted = opts.watchRetries ? 3 : 1;
    const o = await until(sid, (x) => answered(x.events.find((e) => e.kind === "refunded")!.received).length >= wanted && x, 240_000, 4000);
    const attempts = answered((o ?? (await state(sid)).orders[0]).events.find((e) => e.kind === "refunded")!.received);
    const truth = await truthOf(order.captureId);
    Object.assign(observed, { books: (o ?? (await state(sid)).orders[0]).book?.state, truth, answers: attempts.map((a) => a.status), attemptSecondsAfterFirst: attempts.map((a) => Math.round(((a.receivedAt ?? 0) - (attempts[0].receivedAt ?? 0)) / 1000)) });
    return done({ valid: true, pass: attempts.length >= wanted && attempts.every((a) => a.status === 401) && observed.books === "paid" && truth === "REFUNDED", expected: `${wanted} refund attempt(s) answered 401, books still paid, PayPal says REFUNDED` });
  }

  if (mode === "last_write_wins" || (mode === "good" && opts.control)) {
    // In order the refund is booked; then the old "payment completed" event is sent again (PayPal resend), as if it had arrived late.
    const booked = await until(sid, (o) => o.book?.state === "refunded" && o, 60_000);
    observed.refundBooked = !!booked;
    const eid = (await state(sid)).orders[0].events.find((e) => e.kind === "completed")?.eid;
    if (!eid) return done({ valid: true, pass: false, expected: "payment event id known", });
    // PayPal answers a resend 202 and then, in 2 of the first 5 trials (run 1), never delivered it: both were accepted early (the
    // event was 24 s and 48 s old), the three that delivered were accepted after 4-7 refusals. So an accepted resend is not an arrival:
    // wait for the second delivery and, if none comes in 60 s, send the resend again (at most 3 times).
    const resends: { acceptedAt: number; after404s: number }[] = [];
    let again: OrderView | undefined;
    for (let n = 0; n < 3 && !again; n++) {
      const refusals = await resendTo(eid);
      resends.push({ acceptedAt: rel(), after404s: refusals });
      again = await until(sid, (o) => new Set(answered(o.events.find((e) => e.kind === "completed")!.received).map((a) => a.tid)).size >= 2 && o, 60_000);
    }
    observed.resends = resends;
    await sleep(3000);
    const o = (await state(sid)).orders[0];
    const truth = await truthOf(order.captureId);
    Object.assign(observed, { resentEventReceived: !!again, books: o.book?.state, truth });
    const expectedBooks = mode === "good" ? "refunded" : "paid";
    return done({ valid: true, pass: !!booked && !!again && o.book?.state === expectedBooks && truth === "REFUNDED", expected: `refund booked, the old payment event sent again, books end ${expectedBooks}, PayPal says REFUNDED` });
  }

  // good control for the refund path
  const o = await until(sid, (x) => x.book?.state === "refunded" && x, 30_000);
  const truth = await truthOf(order.captureId);
  Object.assign(observed, { books: o?.book?.state, truth, status: first.status });
  return done({ valid: true, pass: first.status === 200 && o?.book?.state === "refunded" && truth === "REFUNDED", expected: "refund answered 200, books refunded" });
}

// Runs a trial again (up to `max` times in all) while it is invalid, and keeps every attempt in the log.
async function validTrial(mode: Mode, opts: Parameters<typeof trial>[1] = {}, max = 3): Promise<Trial[]> {
  const log: Trial[] = [];
  for (let i = 0; i < max; i++) {
    const t = await trial(mode, i === 0 ? opts : { ...opts, rendezvous: undefined });
    log.push(t);
    console.log(`  [${rel()}s] ${mode}${opts.control ? " (control)" : ""} session ${t.session}: ${t.valid ? (t.pass ? "PASS" : "FAIL") : "INVALID"} ${t.invalidWhy ?? ""} ${JSON.stringify(t.observed)}`);
    if (t.valid) break;
  }
  return log;
}

function summarize(label: string, trials: Trial[]): void {
  const counted = trials.filter((t) => t.valid && !t.control);
  const passed = counted.filter((t) => t.pass);
  console.log(`${label}: ${passed.length}/${counted.length} valid trials behaved as expected; invalidated and rerun: ${trials.filter((t) => !t.valid).length}; controls: ${trials.filter((t) => t.valid && t.control).map((t) => (t.pass ? "pass" : "FAIL")).join(", ") || "none"}`);
}

if (command === "modes") {
  const rounds = Number(flag("rounds") ?? 3);
  const only = flag("only");
  const planned = (["ack_then_drop", "bad_body", "last_write_wins"] as const).filter((m) => !only || m === only);
  const jobs = [
    ...planned.flatMap((m) => Array.from({ length: rounds }, () => validTrial(m, { watchRetries: m === "bad_body" }))),
    validTrial("good", { control: true }),
    validTrial("good", { control: true }),
  ];
  const all = (await Promise.all(jobs)).flat();
  for (const m of planned) summarize(m, all.filter((t) => t.mode === m));
  summarize("all planted", all.filter((t) => t.mode !== "good"));
  writeFileSync(flag("out") ?? `s2-modes-${Date.now()}.json`, JSON.stringify(all, null, 2));
} else if (command === "pairs") {
  const pairs: [Mode, Mode][] = [
    ["good", "ack_then_drop"],
    ["bad_body", "last_write_wins"],
    ["ack_then_drop", "bad_body"],
  ];
  const all: Trial[] = [];
  for (const [a, b] of pairs) {
    // Each session pays first; the one that is ready waits (at most 200 s) for the other, then both switch mode and refund at once.
    let release: () => void = () => {};
    const together = new Promise<void>((r) => (release = r));
    let ready = 0;
    const rendezvous = async (): Promise<void> => {
      if (++ready === 2) release();
      await Promise.race([together, sleep(200_000)]);
    };
    console.log(`pair: ${a} + ${b}`);
    const results = await Promise.all([a, b].map((m) => validTrial(m, { control: m === "good", rendezvous }, 1)));
    all.push(...results.flat());
  }
  const valid = all.filter((t) => t.valid);
  console.log(`pairs: ${valid.filter((t) => t.pass).length}/${valid.length} sessions behaved as their own mode says (invalid: ${all.length - valid.length}); modes did not leak across a pair in ${pairs.length - all.filter((t) => t.valid && !t.pass).length}/${pairs.length} pairs`);
  writeFileSync(flag("out") ?? `s2-pairs-${Date.now()}.json`, JSON.stringify(all, null, 2));
} else {
  throw new Error("usage: s2-acceptance.ts modes [--rounds 3] [--out file] | pairs [--out file]");
}
