// Prints what the witness has stored in Redis: one row per transmission id, the quarantine ring and the rejection counters.
// Reads only. Bodies, signatures and headers are not printed.
//   npx tsx scripts/witness-state.ts [prefix]        (default prefix: db:)
import { redisFromEnv } from "../lib/redis.ts";
import type { AttemptEntry } from "../lib/witness/store.ts";
import { loadEnv, loadRedisEnv } from "./env.ts";

loadEnv();
loadRedisEnv();
const redis = redisFromEnv();
if (!redis) throw new Error("KV_REST_API_URL and KV_REST_API_TOKEN are not set");
const prefix = process.argv[2] ?? "db:";

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

const attKeys = await scan(`${prefix}w:att:*`);
const rows: { tid: string; attempts: number; type: string; event: string; firstAt: string; lastAt: string; ttlH: string }[] = [];
for (const key of attKeys) {
  const list = (await redis.lrange<string>(key, 0, -1)).map((r) => JSON.parse(String(r)) as AttemptEntry);
  const ttl = await redis.pttl(key);
  rows.push({
    tid: key.slice(`${prefix}w:att:`.length),
    attempts: list.length,
    type: list[0].type,
    event: list[0].eid,
    firstAt: new Date(list[0].at).toISOString(),
    lastAt: new Date(list.at(-1)!.at).toISOString(),
    ttlH: (ttl / 3_600_000).toFixed(1),
  });
}
rows.sort((a, b) => a.firstAt.localeCompare(b.firstAt));
console.table(rows);
const ring = (await redis.lrange<string>(`${prefix}w:q`, 0, -1)).map((r) => JSON.parse(String(r)) as AttemptEntry);
console.log(`verified transmission ids: ${rows.length}   attempts: ${rows.reduce((s, r) => s + r.attempts, 0)}`);
console.log(`quarantine ring: ${ring.length} (${ring.filter((e) => e.why === "budget").length} budget, ${ring.filter((e) => e.why === "unavail").length} unavailable)`);
for (const key of await scan(`${prefix}w:rej:*`)) console.log(`rejected by PayPal's verify, ${key.slice(`${prefix}w:rej:`.length)}: ${await redis.get(key)}`);
const budget = await redis.get(`${prefix}w:bud`);
console.log(`verify budget counter: ${budget ?? "none (no window open)"}`);
