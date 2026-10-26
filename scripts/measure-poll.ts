// A13 item 9 (plan R13): how many Upstash commands does a session cost in 10 minutes of the page's polling? Measured on the real database
// with a throwaway session under db:test: keys (deleted at the end): the snapshot route's work for one poll (the scan limit, the session
// lookup, the scan with PayPal's list, the certificate, the heartbeat, the cause from the recording) with a PayPal that is a stand-in
// (nothing is sent to PayPal). Two counts per poll: the calls the code makes (wrapper: an EVAL is 1) and what the server counts (an EVAL is
// 1 plus every redis.call inside it; INFO on the primary, as scripts/measure-commands.ts does). Run it when nothing else uses the database.
//   npx tsx scripts/measure-poll.ts [--out docs/measurements/s5-poll-cost.json]
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createLimiter } from "../lib/limits.ts";
import type { ListedEvent, PaypalReads } from "../lib/gaps/reads.ts";
import { redisFromEnv } from "../lib/redis.ts";
import { buildLiveSnapshot } from "../lib/run/build.ts";
import { computeDiffs } from "../lib/shop/diffs.ts";
import { COMPLETED, REFUNDED } from "../lib/shop/events.ts";
import { InProcessReporter } from "../lib/shop/reporter.ts";
import { RedisShopStore } from "../lib/shop/store.ts";
import { deleteByPrefix, TEST_PREFIX } from "../lib/test-redis.ts";
import { loadEnv, loadRedisEnv } from "./env.ts";

loadEnv();
loadRedisEnv();
const real = redisFromEnv();
if (!real) throw new Error("KV_REST_API_URL and KV_REST_API_TOKEN are not set");
const redis = real;
const ROOT = join(import.meta.dirname, "..");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function primaryTotal(): Promise<number> {
  for (let i = 0; i < 60; i++) {
    const res = await fetch(process.env.KV_REST_API_URL!, { method: "POST", headers: { Authorization: `Bearer ${process.env.KV_REST_API_TOKEN}` }, body: JSON.stringify(["INFO"]) });
    const text = String(((await res.json()) as { result: string }).result);
    if (Number(text.match(/total_writes_processed:(\d+)/)?.[1]) > 0) return Number(text.match(/total_commands_processed:(\d+)/)![1]);
    await sleep(100);
  }
  throw new Error("INFO never reached the primary");
}

// Counts every command the code sends: a method call is 1, the commands queued on a pipeline are 1 each.
const wrapper = { calls: 0, byName: {} as Record<string, number> };
const bump = (name: string, n = 1) => {
  wrapper.calls += n;
  wrapper.byName[name] = (wrapper.byName[name] ?? 0) + n;
};
const counted = new Proxy(redis, {
  get(target, prop, receiver) {
    const value = Reflect.get(target, prop, receiver);
    if (typeof value !== "function" || typeof prop !== "string") return value;
    if (prop === "pipeline") {
      return (...args: unknown[]) => {
        const p = (value as (...a: unknown[]) => unknown).apply(target, args) as object;
        return new Proxy(p, {
          get(pt, pp, pr) {
            const f = Reflect.get(pt, pp, pr);
            if (typeof f !== "function" || typeof pp !== "string" || pp === "exec") return typeof f === "function" ? f.bind(pt) : f;
            return (...a: unknown[]) => (bump(`pipeline.${pp}`), (f as (...x: unknown[]) => unknown).apply(pt, a), pr);
          },
        });
      };
    }
    return (...args: unknown[]) => (bump(prop), (value as (...a: unknown[]) => unknown).apply(target, args));
  },
});

const prefix = `${TEST_PREFIX}poll-${randomUUID().slice(0, 6)}:`;
const store = new RedisShopStore(counted, prefix);
const limiter = createLimiter({ redis: counted, prefix });
const longAgo = Date.now() - 20 * 60_000; // everything in the measurement session happened 20 minutes ago: nothing is "settling" and no absence window is open
const reporter = new InProcessReporter(store, () => longAgo + 70_000);

// A session with a healthy order and two refunds that the shop acknowledged and dropped (two gaps), as in the recorded run.
const sid = randomUUID().replaceAll("-", "");
const orders = [
  { item: "house-250", amount: "14.00", refund: false },
  { item: "gift-set", amount: "48.00", refund: true },
  { item: "gift-set", amount: "48.00", refund: true },
].map((o, i) => ({ ...o, n: i + 1, captureId: `POLLCAP${i}${randomUUID().slice(0, 8).toUpperCase()}`, refundId: `POLLREF${i}${randomUUID().slice(0, 8).toUpperCase()}`, paidEid: `WH-POLLPAID${i}-${randomUUID().slice(0, 8)}`, refundEid: `WH-POLLREFUND${i}-${randomUUID().slice(0, 8)}` }));
await store.createSession(sid, "ack_then_drop", longAgo);
for (const o of orders) {
  await store.putOrder(sid, { n: o.n, item: o.item, amount: o.amount, orderId: `ORDER${o.n}`, captureId: o.captureId, invoiceId: `MM-poll-${o.n}`, at: longAgo, ...(o.refund ? { refund: { id: o.refundId, invoiceId: `MM-poll-${o.n}-R`, at: longAgo + 60_000 } } : {}) });
  await store.setBook(sid, o.captureId, { state: "paid", amount: o.amount, eid: o.paidEid, at: longAgo + 5_000 });
  await store.noteHeard({ resourceId: o.captureId, type: COMPLETED }, { eid: o.paidEid, tid: `tid-p${o.n}`, at: longAgo + 4_000, slot: "D" });
  await store.noteReceived({ resourceId: o.captureId, type: COMPLETED }, o.paidEid);
  if (o.refund) {
    const a = await reporter.received(`tid-r${o.n}`, o.refundEid);
    await reporter.responded(`tid-r${o.n}`, 200, a);
    await store.noteHeard({ resourceId: o.refundId, type: REFUNDED }, { eid: o.refundEid, tid: `tid-r${o.n}`, at: longAgo + 70_000, slot: "D" });
    await store.noteReceived({ resourceId: o.refundId, type: REFUNDED }, o.refundEid);
  }
}

const listed: ListedEvent[] = orders.flatMap((o) => [
  { eid: o.paidEid, type: COMPLETED, createTime: longAgo + 3_000, resourceId: o.captureId, captureId: o.captureId },
  ...(o.refund ? [{ eid: o.refundEid, type: REFUNDED, createTime: longAgo + 61_000, resourceId: o.refundId, captureId: o.captureId }] : []),
]);
const truth = new Map(orders.map((o) => [o.captureId, o.refund ? "REFUNDED" : "COMPLETED"]));
const reads: PaypalReads = {
  capture: async (id) => ({ status: truth.get(id) ?? "COMPLETED" }),
  refund: async () => ({ status: "COMPLETED" }),
  listedEvents: async () => listed,
  subscribedTypes: async () => [COMPLETED, REFUNDED],
  resend: async () => {
    throw new Error("the measurement never resends");
  },
};

// One poll as the snapshot route does it: the limit, the session, the snapshot (scan with the list, certificate, heartbeat, recorded cause).
let visitor = 0;
async function poll(): Promise<void> {
  const who = { ip: `198.51.100.${(visitor++ % 200) + 1}`, session: sid }; // a different address each time: the per-address burst bucket is memory only and would stop 20 polls in a row
  const limit = await limiter.checkLimit("scan", who);
  if (!limit.ok) throw new Error(`the limiter said no during the measurement: ${limit.reason}`);
  const session = await store.getSession(sid);
  if (!session) throw new Error("the throwaway session is gone");
  const snap = await buildLiveSnapshot({ scan: { store, reads, shopWebhookId: "POLLWEBHOOK000001" }, bundle: computeDiffs(ROOT), recordedReplays: {}, log: () => undefined }, sid, session);
  if (snap.scan!.summary.gaps !== 2) throw new Error(`the measurement session should have 2 gaps, it has ${snap.scan!.summary.gaps}`);
}

// The page's cadence (plan 9.7): 3 s, then 10 s, then 20 s, until 5 minutes after the last action.
const pollsAfterOneAction = 16;

try {
  const result: Record<string, unknown> = { at: new Date().toISOString() };
  await poll(); // warm up: loads the recording once
  const runs = 20;
  wrapper.calls = 0;
  wrapper.byName = {};
  const before = await primaryTotal();
  for (let i = 0; i < runs; i++) await poll();
  await sleep(500);
  const server = (await primaryTotal()) - before;
  const wrapperPerPoll = wrapper.calls / runs;
  const serverPerPoll = server / runs;
  result.perPoll = { polls: runs, wrapperCommands: wrapperPerPoll, wrapperByName: Object.fromEntries(Object.entries(wrapper.byName).map(([k, v]) => [k, v / runs])), serverCommands: Number(serverPerPoll.toFixed(2)) };
  result.tenMinutes = {
    note: "one action at the start, then the page's cadence (3 s, 10 s, then every 20 s until 5 minutes after the action): 16 polls; none after that",
    polls: pollsAfterOneAction,
    wrapperCommands: Math.round(pollsAfterOneAction * wrapperPerPoll),
    serverCommands: Math.round(pollsAfterOneAction * serverPerPoll),
    plan: 60,
    pollsThatFitInThePlansSixty: { wrapper: Math.floor(60 / wrapperPerPoll), server: Math.floor(60 / serverPerPoll) },
  };
  console.log(JSON.stringify(result, null, 1));
  const out = process.argv.includes("--out") ? process.argv[process.argv.indexOf("--out") + 1] : join(ROOT, "docs/measurements/s5-poll-cost.json");
  writeFileSync(out, `${JSON.stringify(result, null, 1)}\n`);
  console.log(`wrote ${out}`);
} finally {
  console.log(`cleanup: deleted ${await deleteByPrefix(redis, prefix)} keys`);
}
