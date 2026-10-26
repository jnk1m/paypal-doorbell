// What one poll of the live lane costs in Redis commands (A13 item 9, plan R13: at most 60 commands per session per 10 minutes), counted without a database.
//
// `countingRedis()` is a stand-in for the Upstash client that keeps data in memory and counts every command the code sends: a method call is 1, and each
// command queued on a pipeline is 1 (the same count as scripts/measure-poll.ts, which does it against the real database). `measurePoll()` seeds a session
// the way the recorded run has it (3 orders, 2 refunds that the shop answered 200 and did not book) through the real RedisShopStore, then does what the
// snapshot route does for one poll with the real code: the scan limit, the session lookup, the scan with PayPal's list, the certificate, the heartbeat, the
// cause from the recording. PayPal is a stand-in that answers from a table; nothing is sent anywhere.
//
// What it cannot tell: what the server counts for an EVAL (the real database counts the commands inside the script too), and what other server instances do
// for all sessions together (the witness quarantine's re-check, one command every 30 s per instance). Those are in docs/measurements/s5-poll-cost.json.
import { randomUUID } from "node:crypto";
import type { Redis } from "@upstash/redis";
import { createLimiter } from "../limits.ts";
import type { ListedEvent, PaypalReads } from "../gaps/reads.ts";
import type { DiffBundle } from "../shop/diffs.ts";
import { COMPLETED, REFUNDED } from "../shop/events.ts";
import { InProcessReporter } from "../shop/reporter.ts";
import { RedisShopStore } from "../shop/store.ts";
import { buildLiveSnapshot } from "./build.ts";

export interface Counts {
  calls: number;
  byName: Record<string, number>;
}

type Queued = { name: string; args: unknown[] };

export function countingRedis(): { redis: Redis; counts: Counts; reset: () => void } {
  const strings = new Map<string, string>();
  const hashes = new Map<string, Map<string, string>>();
  const counts: Counts = { calls: 0, byName: {} };
  const bump = (name: string): void => {
    counts.calls++;
    counts.byName[name] = (counts.byName[name] ?? 0) + 1;
  };

  // The effect of a command, without counting it. Only the commands the poll path and the seeding use; anything else throws, so a new command cannot slip in uncounted.
  const run = (name: string, args: unknown[]): unknown => {
    switch (name) {
      case "hset": {
        const [key, obj] = args as [string, Record<string, unknown>];
        const h = hashes.get(key) ?? new Map<string, string>();
        for (const [f, v] of Object.entries(obj)) h.set(f, String(v));
        hashes.set(key, h);
        return Object.keys(obj).length;
      }
      case "hgetall": {
        const h = hashes.get(args[0] as string);
        return h && h.size > 0 ? [...h].flat() : null; // the flat reply of a client without automatic deserialization (lib/redis.ts)
      }
      case "hget":
        return hashes.get(args[0] as string)?.get(args[1] as string) ?? null;
      case "hincrby": {
        const [key, field, by] = args as [string, string, number];
        const h = hashes.get(key) ?? new Map<string, string>();
        const next = Number(h.get(field) ?? 0) + by;
        h.set(field, String(next));
        hashes.set(key, h);
        return next;
      }
      case "set":
        strings.set(args[0] as string, String(args[1]));
        return "OK";
      case "get":
        return strings.get(args[0] as string) ?? null;
      case "mget":
        return (args as string[]).map((k) => strings.get(k) ?? null);
      case "append": {
        const next = `${strings.get(args[0] as string) ?? ""}${String(args[1])}`;
        strings.set(args[0] as string, next);
        return next.length;
      }
      case "pexpire":
        return 1;
      case "del": {
        let n = 0;
        for (const k of args as string[]) n += Number(strings.delete(k)) + Number(hashes.delete(k));
        return n;
      }
      case "eval": {
        // the limiter's counters (lib/limits.ts HIT): INCR each key, the first one over its max stops the call
        const [script, keys, argv] = args as [string, string[], number[]];
        if (!script.includes("INCR")) throw new Error("countingRedis: the only script it knows is the limiter's");
        for (const [i, key] of keys.entries()) {
          const n = Number(strings.get(key) ?? 0) + 1;
          strings.set(key, String(n));
          if (n > Number(argv[2 * i + 1])) return [i + 1, n, 1000];
        }
        return [0, 0, 0];
      }
      default:
        throw new Error(`countingRedis: the command "${name}" is not supported here`);
    }
  };

  const pipeline = () => {
    const queued: Queued[] = [];
    const chain: Record<string, unknown> = new Proxy(
      {},
      {
        get: (_t, prop) =>
          prop === "exec"
            ? async () =>
                queued.map(({ name, args }) => {
                  bump(`pipeline.${name}`);
                  return run(name, args);
                })
            : (...args: unknown[]) => (queued.push({ name: String(prop), args }), chain),
      },
    );
    return chain;
  };

  const redis = new Proxy(
    {},
    {
      get: (_t, prop) => {
        if (prop === "pipeline") return pipeline;
        if (typeof prop !== "string" || prop === "then") return undefined;
        return async (...args: unknown[]) => (bump(prop), run(prop, args));
      },
    },
  ) as unknown as Redis;
  return { redis, counts, reset: () => ((counts.calls = 0), (counts.byName = {})) };
}

export interface PollCost {
  polls: number;
  commandsPerPoll: number;
  byName: Record<string, number>; // per poll, by command (pipelined commands as "pipeline.<name>")
}

// `orderCount` orders: the first is healthy, the others were refunded and the shop answered 200 and did not book them (gaps).
export async function measurePoll(bundle: DiffBundle, polls = 20, orderCount = 3): Promise<PollCost> {
  const { redis, counts, reset } = countingRedis();
  const prefix = `poll-${randomUUID().slice(0, 6)}:`;
  const store = new RedisShopStore(redis, prefix);
  const limiter = createLimiter({ redis, prefix });
  const longAgo = Date.now() - 20 * 60_000; // everything happened 20 minutes ago: nothing is "settling" and no absence window is open
  const reporter = new InProcessReporter(store, () => longAgo + 70_000);

  const sid = randomUUID().replaceAll("-", "");
  const orders = Array.from({ length: orderCount }, (_, i) => (i === 0 ? { item: "house-250", amount: "14.00", refund: false } : { item: "gift-set", amount: "48.00", refund: true })).map((o, i) => ({ ...o, n: i + 1, captureId: `POLLCAP${i}${randomUUID().slice(0, 8).toUpperCase()}`, refundId: `POLLREF${i}${randomUUID().slice(0, 8).toUpperCase()}`, paidEid: `WH-POLLPAID${i}-${randomUUID().slice(0, 8)}`, refundEid: `WH-POLLREFUND${i}-${randomUUID().slice(0, 8)}` }));
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

  // One poll as the snapshot route does it (app/api/shop/snapshot/route.ts): the limit, the session, the snapshot.
  let visitor = 0;
  const poll = async (): Promise<void> => {
    const limit = await limiter.checkLimit("scan", { ip: `198.51.100.${(visitor++ % 200) + 1}`, session: sid }); // a new address each time: the burst bucket is memory only
    if (!limit.ok) throw new Error(`the limiter said no during the measurement: ${limit.reason}`);
    const session = await store.getSession(sid);
    if (!session) throw new Error("the throwaway session is gone");
    const snap = await buildLiveSnapshot({ scan: { store, reads, shopWebhookId: "POLLWEBHOOK000001" }, bundle, recordedReplays: {}, log: () => undefined }, sid, session);
    if (snap.scan!.summary.gaps !== orderCount - 1) throw new Error(`the measurement session should have ${orderCount - 1} gaps, it has ${snap.scan!.summary.gaps}`);
  };

  await poll(); // the first one loads the recording from disk once
  reset();
  for (let i = 0; i < polls; i++) await poll();
  return { polls, commandsPerPoll: counts.calls / polls, byName: Object.fromEntries(Object.entries(counts.byName).map(([k, v]) => [k, v / polls])) };
}
