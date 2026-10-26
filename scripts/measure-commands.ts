// A2: how many Upstash commands one delivery costs. Upstash counts an EVAL as 1 plus every redis.call inside it, and INFO on the
// primary shows total_commands_processed (INFO itself is not counted; a replica answers some INFO calls with its own small counters,
// so the call is repeated until the primary answers). Run it when nothing else uses the database.
//   npx tsx scripts/measure-commands.ts            store operations on db:test: keys, then the deployed receiver
import { randomBytes, randomUUID } from "node:crypto";
import { redisFromEnv } from "../lib/redis.ts";
import { deleteByPrefix, TEST_PREFIX } from "../lib/test-redis.ts";
import { buildEntry } from "../lib/witness/receive.ts";
import { checkHeaders, parseEvent } from "../lib/witness/precheck.ts";
import { QUARANTINE_SOFT_CAP, RedisWitnessStore, type AttemptEntry } from "../lib/witness/store.ts";
import { loadEnv, loadRedisEnv } from "./env.ts";

loadEnv();
loadRedisEnv();
const redis = redisFromEnv();
if (!redis) throw new Error("KV_REST_API_URL and KV_REST_API_TOKEN are not set");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function primaryTotal(): Promise<number> {
  for (let i = 0; i < 60; i++) {
    const res = await fetch(process.env.KV_REST_API_URL!, { method: "POST", headers: { Authorization: `Bearer ${process.env.KV_REST_API_TOKEN}` }, body: JSON.stringify(["INFO"]) });
    const text = String(((await res.json()) as { result: string }).result);
    const writes = Number(text.match(/total_writes_processed:(\d+)/)?.[1]);
    if (writes > 0) return Number(text.match(/total_commands_processed:(\d+)/)![1]);
    await sleep(100);
  }
  throw new Error("INFO never reached the primary");
}

async function cost(label: string, run: () => Promise<unknown>): Promise<number> {
  const a = await primaryTotal();
  await run();
  await sleep(300);
  const n = (await primaryTotal()) - a;
  console.log(`${label.padEnd(58)} ${n}`);
  return n;
}

const prefix = `${TEST_PREFIX}cmd-${randomUUID().slice(0, 6)}:`;
const store = new RedisWitnessStore(redis, { prefix, budgetPerMinute: 2, budgetWindowMs: 30_000 });

function entry(tid: string): AttemptEntry {
  const raw = JSON.stringify({ id: `WH-${tid}`, event_type: "PAYMENT.CAPTURE.COMPLETED", resource: { id: "X" } });
  const h = checkHeaders(
    new Headers({ "paypal-transmission-id": tid, "paypal-transmission-time": "2026-10-18T14:31:14Z", "paypal-transmission-sig": randomBytes(256).toString("base64"), "paypal-cert-url": "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-1", "paypal-auth-algo": "SHA256withRSA", "content-type": "application/json" }),
    Date.now(),
  );
  const e = parseEvent(raw);
  if (!h.ok || !e.ok) throw new Error("measure: bad test entry");
  return buildEntry(h.headers, e.parsed, raw, Date.now(), "ok");
}

console.log("commands per store operation (EVAL = 1 + inner calls)");
const c: Record<string, number> = {};
c.reserveFirst = await cost("verify budget: first call in a window", () => store.reserveVerify());
c.reserveNext = await cost("verify budget: next call in the window", () => store.reserveVerify());
c.reserveOver = await cost("verify budget: over the limit", () => store.reserveVerify());
const e1 = entry("11111111-aaaa-4aaa-8aaa-000000000001");
c.commitFirst = await cost("commit verified: first attempt of a transmission id", () => store.commitVerified(e1));
c.commitRetry = await cost("commit verified: a later attempt (retry)", () => store.commitVerified(e1));
c.quarantine = await cost("quarantine push", () => store.quarantine({ ...e1, st: "q", why: "unavail" }));
c.rejectFirst = await cost("count a rejection: first in the hour", () => store.countRejected(Date.now()));
c.rejectNext = await cost("count a rejection: next in the hour", () => store.countRejected(Date.now()));
const [q] = await store.listQuarantined(1);
c.resolve = await cost("re-verify: move a quarantined entry to the attempts", () => store.resolveQuarantined(q.raw, { ...q.entry, st: "ok", rv: Date.now() }));

// Fill the ring past its soft cap in groups, then measure the push that trims it.
for (let i = 0; i < QUARANTINE_SOFT_CAP; i += 100) await Promise.all(Array.from({ length: 100 }, () => store.quarantine({ ...e1, st: "q", why: "budget" })));
c.quarantineTrim = await cost("quarantine push that trims the ring (past 600)", () => store.quarantine({ ...e1, st: "q", why: "budget" }));
console.log(`cleanup: deleted ${await deleteByPrefix(redis, prefix)} test keys`);

console.log("\ncommands per delivery, composed from the above");
const range = (lo: number, hi: number) => (lo === hi ? `${lo}` : `${lo}-${hi}`);
const rows: [string, number, number][] = [
  ["verified, first attempt", c.reserveNext + c.commitFirst, c.reserveFirst + c.commitFirst],
  ["verified, retry of an id already stored", c.reserveNext + c.commitRetry, c.reserveFirst + c.commitRetry],
  ["refused by PayPal's verify (FAILURE)", c.reserveNext + c.rejectNext, c.reserveFirst + c.rejectFirst],
  ["quarantined, verify call failed", c.reserveNext + c.quarantine, c.reserveFirst + c.quarantineTrim],
  ["quarantined, budget just spent", c.reserveOver + c.quarantine, c.reserveOver + c.quarantineTrim],
  ["quarantined, budget known spent (cached on the instance)", c.quarantine, c.quarantineTrim],
  ["refused by the pre-check (not a delivery)", 0, 0],
];
for (const [name, lo, hi] of rows) console.log(`${name.padEnd(58)} ${range(lo, hi)}`);
console.log(`worst case over all rows: ${Math.max(...rows.map((r) => r[2]))}`);

// The same numbers end to end: a stored real delivery sent to the deployed receiver. Its key is deleted first so the first send is a
// first attempt; the tampered copy is refused by PayPal's verify; the pre-check refusal never reaches Redis.
const URL_ = process.env.WITNESS_URL ?? "https://paypal-doorbell.vercel.app/api/witness";
let cursor: string | number = 0;
let sample: AttemptEntry | undefined;
do {
  const [next, keys]: [string, string[]] = await redis.scan(cursor, { match: "db:w:att:*", count: 500 });
  for (const key of keys) {
    const [row] = await redis.lrange<string>(key, 0, 0);
    const e = JSON.parse(String(row)) as AttemptEntry;
    if (e.raw && (!sample || e.at > sample.at)) sample = e;
  }
  cursor = next;
} while (String(cursor) !== "0");
if (!sample?.raw) throw new Error("no stored delivery to replay");
const headers = { "content-type": "application/json", "paypal-auth-algo": sample.h.algo, "paypal-cert-url": sample.h.cert, "paypal-transmission-id": sample.tid, "paypal-transmission-sig": sample.h.sig, "paypal-transmission-time": sample.h.time };
const send = (over: Record<string, string> = {}, drop: string[] = []) => {
  const h = new Headers({ ...headers, ...over });
  for (const d of drop) h.delete(d);
  return fetch(URL_, { method: "POST", headers: h, body: sample!.raw }).then((r) => r.status);
};
const tampered = sample.h.sig.slice(0, 30) + (sample.h.sig[30] === "A" ? "B" : "A") + sample.h.sig.slice(31);

console.log(`\ndeployed receiver, 3 runs each (nothing else should be using the database)`);
const runs: Record<string, number[]> = { "verified, first attempt (key deleted first)": [], "verified, retry of a stored id": [], "refused by PayPal's verify (tampered signature)": [], "refused by the pre-check (no signature header)": [] };
for (let i = 0; i < 3; i++) {
  await redis.del(`db:w:att:${sample.tid}`);
  await sleep(2000);
  runs["verified, first attempt (key deleted first)"].push(await cost("  first attempt", () => send()));
  runs["verified, retry of a stored id"].push(await cost("  retry", () => send()));
  runs["refused by PayPal's verify (tampered signature)"].push(await cost("  tampered signature", () => send({ "paypal-transmission-sig": tampered })));
  runs["refused by the pre-check (no signature header)"].push(await cost("  no signature header", () => send({}, ["paypal-transmission-sig"])));
  await sleep(i === 0 ? 62_000 : 1000); // the first pass ends before the 60 s budget window does; wait so a later pass starts a new window
}
console.log("\ncommands per delivery as seen on the deployed receiver (min-max over 3 runs)");
for (const [name, v] of Object.entries(runs)) console.log(`${name.padEnd(58)} ${range(Math.min(...v), Math.max(...v))}`);
