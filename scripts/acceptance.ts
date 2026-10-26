// Live acceptance measurements for the witness receiver (plan A1, A2) against the deployed URL, real PayPal Sandbox, real Upstash.
// Each subcommand prints numbers and does not decide pass or fail for you.
//   trial <sinceIso>                      A1-1: events PayPal made since then vs deliveries the witness stored
//   forge --wire-log <file>               A1-2: 15 forgeries, identical answers, no state change
//   retry3                                A1-4: one real delivery sent 3 times under one transmission id
//   flood                                 A1-6: 200 well-formed forgeries in under a minute, verify calls made
//   latency [n]                           A1-5: client-side response times for n verified deliveries, plus cold bursts
//   serverlog <since>                     function-side totalMs from the Vercel runtime log, by outcome
//   survival record|check                 A2: stored records before and after a redeploy
// WITNESS_URL overrides https://paypal-doorbell.vercel.app/api/witness.
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { PaypalClient } from "../lib/pay/paypal.ts";
import { redisFromEnv } from "../lib/redis.ts";
import type { AttemptEntry } from "../lib/witness/store.ts";
import { loadEnv, loadRedisEnv } from "./env.ts";

loadEnv();
loadRedisEnv();
const URL_ = process.env.WITNESS_URL ?? "https://paypal-doorbell.vercel.app/api/witness";
const PREFIX = "db:";
const redis = redisFromEnv();
if (!redis) throw new Error("KV_REST_API_URL and KV_REST_API_TOKEN are not set");
const [command, ...rest] = process.argv.slice(2);
const flag = (name: string) => rest[rest.indexOf(`--${name}`) + 1];

interface Delivery {
  headers: Record<string, string>;
  raw: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.ceil((p / 100) * xs.length) - 1)];
const stats = (xs: number[]) => `n=${xs.length} p50=${pct(xs, 50)} p95=${pct(xs, 95)} max=${Math.max(...xs)} ms`;

async function scan(match: string): Promise<string[]> {
  const found: string[] = [];
  let cursor: string | number = 0;
  do {
    const [next, keys]: [string, string[]] = await redis!.scan(cursor, { match, count: 500 });
    found.push(...keys);
    cursor = next;
  } while (String(cursor) !== "0");
  return found;
}

const attKey = (tid: string) => `${PREFIX}w:att:${tid}`;
const parse = (rows: unknown[]) => rows.map((r) => JSON.parse(String(r)) as AttemptEntry);

// Every stored verified delivery with a body, first attempt of each transmission id.
async function stored(): Promise<{ delivery: Delivery; entry: AttemptEntry }[]> {
  const out: { delivery: Delivery; entry: AttemptEntry }[] = [];
  for (const key of await scan(`${PREFIX}w:att:*`)) {
    const [entry] = parse(await redis!.lrange<string>(key, 0, 0));
    if (!entry?.raw) continue;
    out.push({
      entry,
      delivery: {
        raw: entry.raw,
        headers: {
          "content-type": "application/json",
          "paypal-auth-algo": entry.h.algo,
          "paypal-cert-url": entry.h.cert,
          "paypal-transmission-id": entry.tid,
          "paypal-transmission-sig": entry.h.sig,
          "paypal-transmission-time": entry.h.time,
        },
      },
    });
  }
  return out.sort((a, b) => a.entry.at - b.entry.at);
}

// The witness's records without the counters that every request is allowed to touch: what "no state change" means.
async function recordsHash(): Promise<{ hash: string; tids: number; attempts: number; ring: number }> {
  const h = createHash("sha256");
  let attempts = 0;
  const keys = (await scan(`${PREFIX}w:att:*`)).sort();
  for (const k of keys) {
    const rows = await redis!.lrange<string>(k, 0, -1);
    attempts += rows.length;
    h.update(k).update(rows.join("\n"));
  }
  const ring = await redis!.lrange<string>(`${PREFIX}w:q`, 0, -1);
  h.update(ring.join("\n"));
  return { hash: h.digest("hex").slice(0, 16), tids: keys.length, attempts, ring: ring.length };
}

async function rejectedCount(): Promise<number> {
  let total = 0;
  for (const k of await scan(`${PREFIX}w:rej:*`)) total += Number(await redis!.get(k));
  return total;
}

async function post(d: Delivery, over: { headers?: Record<string, string | null>; raw?: string } = {}): Promise<{ status: number; text: string; ms: number }> {
  const headers = new Headers(d.headers);
  for (const [k, v] of Object.entries(over.headers ?? {})) (v === null ? headers.delete(k) : headers.set(k, v));
  const t0 = performance.now();
  const res = await fetch(URL_, { method: "POST", headers, body: over.raw ?? d.raw });
  const text = await res.text();
  return { status: res.status, text, ms: Math.round(performance.now() - t0) };
}

const tamperSig = (sig: string, at: number) => sig.slice(0, at) + (sig[at] === "A" ? "B" : "A") + sig.slice(at + 1);
const forged = (base: Delivery): Delivery => ({
  raw: base.raw,
  headers: {
    ...base.headers,
    "paypal-transmission-id": `${randomBytes(4).toString("hex")}-${randomBytes(2).toString("hex")}-4000-8000-${randomBytes(6).toString("hex")}`,
    "paypal-transmission-sig": randomBytes(256).toString("base64"),
  },
});

// The Vercel CLI returns at most 50 log lines per query, so a window is read in 20 s slices (a slice never holds more than ~25 deliveries).
function runVercelLogs(since: string): { id: string; message?: string; responseStatusCode?: number; timestamp: number }[] {
  const minutes = Number(since.replace(/m$/, ""));
  const end = Date.now();
  const rows = new Map<string, { id: string; message?: string; responseStatusCode?: number; timestamp: number }>();
  for (let from = end - minutes * 60_000; from < end; from += 20_000) {
    const out = execFileSync("vercel", ["-Q", `${process.env.HOME}/.vercel-personal`, "logs", "--since", new Date(from).toISOString(), "--until", new Date(from + 20_000).toISOString(), "--json", "--no-follow", "--no-branch", "--source", "serverless", "--limit", "100"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    for (const l of out.split("\n")) if (l.startsWith("{")) rows.set((JSON.parse(l) as { id: string }).id, JSON.parse(l));
  }
  return [...rows.values()];
}

function witnessLines(since: string): { outcome: string; tid?: string; totalMs?: number; verifyMs?: number; attempts?: number; timestamp: number }[] {
  return runVercelLogs(since)
    .filter((l) => l.message?.includes('"route":"witness"'))
    .map((l) => ({ ...JSON.parse(l.message!), timestamp: l.timestamp }));
}

if (command === "trial") {
  const since = rest[0];
  if (!since) throw new Error("usage: acceptance.ts trial <ISO start time, e.g. 2026-10-19T02:31:00Z>");
  const client = PaypalClient.fromEnv();
  const SUBSCRIBED = /^(PAYMENT\.CAPTURE\.|PAYMENT\.AUTHORIZATION\.|CHECKOUT\.ORDER\.)/;
  const listed = new Map<string, { type: string; created: string }>();
  let path: string | undefined = `/v1/notifications/webhooks-events?page_size=100&start_time=${encodeURIComponent(since.replace(/\.\d+Z$/, "Z"))}`;
  while (path) {
    const page: { events?: { id: string; event_type: string; create_time: string }[]; links?: { rel: string; href: string }[] } = await client.request("list events", "GET", path);
    for (const e of page.events ?? []) if (SUBSCRIBED.test(e.event_type)) listed.set(e.id, { type: e.event_type, created: e.create_time });
    const next = page.links?.find((l) => l.rel === "next")?.href;
    path = next ? new URL(next).pathname + new URL(next).search : undefined; // the host is always the client's fixed Sandbox host
  }
  const have = new Map<string, AttemptEntry>();
  for (const { entry } of await stored()) have.set(entry.eid, entry);
  const missing = [...listed].filter(([id]) => !have.has(id));
  const delays = [...listed].flatMap(([id, e]) => (have.has(id) ? [(have.get(id)!.at - Date.parse(e.created)) / 1000] : []));
  console.log(`PayPal listed ${listed.size} subscribed events since ${since}`);
  console.log(`witness stored (verified) ${listed.size - missing.length} of them`);
  console.log(`missing ${missing.length}: ${missing.map(([id, e]) => `${e.type}@${e.created}`).join(", ") || "none"}`);
  const ring = await redis.lrange<string>(`${PREFIX}w:q`, 0, -1);
  console.log(`quarantine ring ${ring.length}; PayPal-verify rejections counted so far ${await rejectedCount()}`);
  console.log(`delivery delay after event creation, s: ${delays.length ? `min ${Math.min(...delays).toFixed(0)} median ${pct(delays, 50).toFixed(0)} max ${Math.max(...delays).toFixed(0)}` : "n/a"}`);
} else if (command === "forge") {
  const wire: { slot: string; headers: Record<string, string>; raw: string }[] = JSON.parse(readFileSync(flag("wire-log"), "utf8"));
  const real = (await stored()).slice(-6).map((s) => s.delivery);
  if (real.length < 5) throw new Error(`need at least 5 stored deliveries, found ${real.length}`);
  const other = wire.filter((e) => !/^2015/.test(JSON.parse(e.raw).create_time)).slice(0, 2).map((e) => ({ raw: e.raw, headers: { "content-type": "application/json", "paypal-auth-algo": e.headers["paypal-auth-algo"], "paypal-cert-url": e.headers["paypal-cert-url"], "paypal-transmission-id": e.headers["paypal-transmission-id"], "paypal-transmission-sig": e.headers["paypal-transmission-sig"], "paypal-transmission-time": e.headers["paypal-transmission-time"] } }));
  const cases: { kind: string; d: Delivery; over?: Parameters<typeof post>[1] }[] = [
    ...real.slice(0, 5).map((d, i) => ({ kind: "signature", d, over: { headers: { "paypal-transmission-sig": tamperSig(d.headers["paypal-transmission-sig"], 20 + i * 11) } } })),
    ...real.slice(0, 5).map((d) => ({ kind: "body", d, over: { raw: d.raw.replace(/"value":"(\d+)\./, '"value":"9$1.') } })),
    { kind: "missing", d: real[0], over: { headers: { "paypal-transmission-id": null } } },
    { kind: "missing", d: real[1], over: { headers: { "paypal-transmission-sig": null } } },
    { kind: "missing", d: real[2], over: { headers: { "paypal-cert-url": null } } },
    ...other.map((d) => ({ kind: "other-webhook", d })),
  ];
  const before = await recordsHash();
  const rejBefore = await rejectedCount();
  const results: { kind: string; status: number; text: string }[] = [];
  for (const c of cases) {
    const r = await post(c.d, c.over);
    results.push({ kind: c.kind, status: r.status, text: r.text });
    await sleep(250);
  }
  const after = await recordsHash();
  console.log(`forgeries sent: ${results.length}  (${["signature", "body", "missing", "other-webhook"].map((k) => `${k} ${results.filter((r) => r.kind === k).length}`).join(", ")})`);
  console.log(`status codes: ${JSON.stringify(results.reduce<Record<number, number>>((m, r) => ((m[r.status] = (m[r.status] ?? 0) + 1), m), {}))}`);
  console.log(`distinct response bodies: ${new Set(results.map((r) => r.text)).size}  (${JSON.stringify([...new Set(results.map((r) => r.text))][0])})`);
  console.log(`records before ${JSON.stringify(before)}`);
  console.log(`records after  ${JSON.stringify(after)}`);
  console.log(`state change: ${before.hash === after.hash ? "none" : "CHANGED"}; verify rejections counted +${(await rejectedCount()) - rejBefore} (only counter)`);
} else if (command === "retry3") {
  const pick = (await stored()).at(-1)!;
  const tid = pick.entry.tid;
  await redis.del(attKey(tid)); // start from "never seen" so the first of the three is the first attempt
  const t0 = Date.now() - 2000;
  const answers = [];
  for (let i = 0; i < 3; i++) {
    answers.push((await post(pick.delivery)).status);
    await sleep(500);
  }
  const attempts = parse(await redis.lrange<string>(attKey(tid), 0, -1));
  console.log(`same transmission id sent 3 times: statuses ${answers.join(",")}; attempts stored ${attempts.length}; keys for this id: ${(await scan(attKey(tid))).length}`);
  await sleep(6000);
  const lines = witnessLines("5m").filter((l) => l.tid === tid && l.timestamp >= t0);
  console.log(`function log for this id: ${lines.map((l) => l.outcome).reverse().join(", ")}`);
} else if (command === "flood") {
  const base = (await stored()).at(-1)!.delivery;
  for (let i = 0; i < 90; i++) {
    if ((await redis.pttl(`${PREFIX}w:bud`)) < 0) break; // wait until no budget window is open, so the 200 start a fresh one
    await sleep(1000);
  }
  const ringBefore = (await redis.lrange<string>(`${PREFIX}w:q`, 0, -1)).length;
  const results: number[] = [];
  const t0 = performance.now();
  const queue = Array.from({ length: 200 }, () => forged(base));
  await Promise.all(
    Array.from({ length: 10 }, async () => {
      for (let d = queue.pop(); d; d = queue.pop()) results.push((await post(d)).status);
    }),
  );
  const seconds = (performance.now() - t0) / 1000;
  const ring = parse(await redis.lrange<string>(`${PREFIX}w:q`, 0, -1));
  const count = (s: number) => results.filter((x) => x === s).length;
  console.log(`200 well-formed forgeries sent in ${seconds.toFixed(1)} s: ${count(401)} answered 401 (verify said FAILURE), ${count(200)} answered 200 (quarantined), other ${results.length - count(401) - count(200)}`);
  console.log(`ring grew by ${ring.length - ringBefore}: ${ring.filter((e) => e.why === "budget").length} budget, ${ring.filter((e) => e.why === "unavail").length} verify-unavailable`);
  console.log(`verify calls made = ${count(401)} (401s) + ${ring.filter((e) => e.why === "unavail").length} (unavailable) ; budget counter now ${await redis.get(`${PREFIX}w:bud`)}`);
} else if (command === "latency") {
  const n = Number(rest[0] ?? 60);
  const pool = (await stored()).slice(-8).map((s) => s.delivery);
  const warm: number[] = [];
  const base: number[] = [];
  for (let i = 0; i < 10; i++) {
    const t0 = performance.now();
    await fetch(URL_, { method: "GET" }).then((r) => r.arrayBuffer());
    base.push(Math.round(performance.now() - t0));
    await sleep(200);
  }
  for (let i = 0; i < n; i++) {
    const r = await post(pool[i % pool.length]);
    if (r.status !== 200) throw new Error(`latency run: unexpected status ${r.status}`);
    warm.push(r.ms);
    await sleep(700);
  }
  console.log(`verified deliveries, one at a time: ${stats(warm)}`);
  console.log(`GET (405, no function work) baseline from this machine: ${stats(base)}`);
  await sleep(62_000); // let the verify budget window of the one-at-a-time run end, so the 36 burst requests all reach PayPal
  const burst: number[] = [];
  for (let round = 0; round < 3; round++) {
    const rs = await Promise.all(Array.from({ length: 12 }, (_, i) => post(pool[i % pool.length])));
    burst.push(...rs.map((r) => r.ms));
    await sleep(2500);
  }
  console.log(`3 bursts of 12 at once (new instances start cold): ${stats(burst)}`);
  console.log(`all ${warm.length + burst.length}: ${stats([...warm, ...burst])}`);
} else if (command === "cold") {
  // Run right after a deploy or a long idle: the first request has to start the function.
  const pool = (await stored()).slice(-6).map((s) => s.delivery);
  const times: number[] = [];
  for (const d of pool) {
    times.push((await post(d)).ms);
    await sleep(500);
  }
  console.log(`first request ${times[0]} ms, then ${times.slice(1).join(", ")} ms`);
} else if (command === "serverlog") {
  const lines = witnessLines(rest[0] ?? "30m");
  const by = new Map<string, number[]>();
  for (const l of lines) if (l.totalMs !== undefined) (by.get(l.outcome) ?? by.set(l.outcome, []).get(l.outcome)!).push(l.totalMs);
  for (const [k, v] of by) console.log(`${k.padEnd(24)} totalMs ${stats(v)}`);
  const all = [...by.values()].flat();
  console.log(`${"all with totalMs".padEnd(24)} totalMs ${all.length ? stats(all) : "n/a"}`);
  const verify = lines.flatMap((l) => (l.verifyMs !== undefined ? [l.verifyMs] : []));
  console.log(`${"verify call".padEnd(24)} verifyMs ${verify.length ? stats(verify) : "n/a"}`);
} else if (command === "survival") {
  const file = flag("file") ?? "survival.json";
  if (rest[0] === "record") {
    const five = (await stored()).slice(0, 5);
    const snap = await Promise.all(five.map(async ({ entry }) => ({ tid: entry.tid, hash: createHash("sha256").update((await redis.lrange<string>(attKey(entry.tid), 0, -1)).join("\n")).digest("hex") })));
    writeFileSync(file, JSON.stringify(snap, null, 2));
    console.log(`recorded ${snap.length} records to ${file}`);
  } else {
    const snap: { tid: string; hash: string }[] = JSON.parse(readFileSync(file, "utf8"));
    let ok = 0;
    for (const s of snap) {
      const rows = await redis.lrange<string>(attKey(s.tid), 0, -1);
      if (createHash("sha256").update(rows.join("\n")).digest("hex") === s.hash) ok++;
    }
    console.log(`records unchanged after the redeploy: ${ok}/${snap.length}`);
    // The new deployment must also see them: the same delivery sent again is a repeat, one more attempt under the same key, not a new record.
    const byTid = new Map((await stored()).map((s) => [s.entry.tid, s.delivery]));
    let seen = 0;
    for (const s of snap) {
      const before = (await redis.lrange<string>(attKey(s.tid), 0, -1)).length;
      const res = await post(byTid.get(s.tid)!);
      const after = (await redis.lrange<string>(attKey(s.tid), 0, -1)).length;
      if (res.status === 200 && after === before + 1 && (await scan(attKey(s.tid))).length === 1) seen++;
    }
    console.log(`new deployment recognises the stored id (attempt appended to the existing record): ${seen}/${snap.length}`);
  }
} else {
  throw new Error("usage: acceptance.ts trial|forge|retry3|flood|latency|serverlog|survival");
}
