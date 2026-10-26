// Real Upstash. Not part of `npm test`. Run: REDIS_ENV_FILE=/path/to/.env.vercel npm run test:redis
// Needs KV_REST_API_URL and KV_REST_API_TOKEN, loaded from REDIS_ENV_FILE (and PAYPAL_ENV_FILE, if set) or already exported.
// Every key lives under db:test:<run>: and is deleted at the end.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Redis } from "@upstash/redis";
import { createBudget } from "./budget.ts";
import { createLimiter, RULES, type LimitKind, type Rule } from "./limits.ts";
import { redisFromEnv } from "./redis.ts";
import { deleteByPrefix, TEST_PREFIX } from "./test-redis.ts";

for (const file of [process.env.PAYPAL_ENV_FILE, process.env.REDIS_ENV_FILE]) if (file) process.loadEnvFile(file);
const redis = redisFromEnv();
if (!redis) throw new Error("missing env: KV_REST_API_URL, KV_REST_API_TOKEN. Load the Upstash .env.vercel first (see header).");

const root = `${TEST_PREFIX}${randomUUID().slice(0, 8)}:`;
after(async () => console.log(`cleanup: deleted ${await deleteByPrefix(redis, root)} keys under ${root}`));

// Counts every eval() the limiter sends (the wrapper count of A13-1).
function counted(r: Redis) {
  const stats = { evals: 0 };
  const proxy = new Proxy(r, {
    get(target, prop, receiver) {
      if (prop === "eval") return (...args: Parameters<Redis["eval"]>) => (stats.evals++, target.eval(...args));
      return Reflect.get(target, prop, receiver);
    },
  });
  return { redis: proxy as Redis, stats };
}

const small = (kind: LimitKind, rules: Rule[]) => ({ ...RULES, [kind]: rules });

test("a per-IP window: calls 1-3 pass, the 4th is blocked with a wait time, another IP is not; the counter carries the window as its expiry", async () => {
  const prefix = `${root}a:`;
  const { checkLimit } = createLimiter({ redis, prefix, rules: small("session", [{ scope: "ip", max: 3, windowSec: 90 }]) });
  for (let i = 1; i <= 3; i++) assert.equal((await checkLimit("session", { ip: "9.9.9.9" })).ok, true, `call ${i}`);
  const blocked = await checkLimit("session", { ip: "9.9.9.9" });
  assert.deepEqual([blocked.ok, blocked.blockedBy], [false, "ip"]);
  assert.ok(blocked.retryAfterSec! > 80 && blocked.retryAfterSec! <= 90, `retryAfterSec ${blocked.retryAfterSec}`);
  assert.equal((await checkLimit("session", { ip: "8.8.8.8" })).ok, true);
  const ttl = await redis.pttl(`${prefix}rl:session:ip:9.9.9.9`);
  assert.ok(ttl > 80_000 && ttl <= 90_000, `pttl ${ttl}`);
});

test("20 concurrent visitors against a global pool of 10: exactly 10 pass (the script is atomic)", async () => {
  const { checkLimit } = createLimiter({ redis, prefix: `${root}b:`, rules: small("refund", [{ scope: "global", max: 10, windowSec: 60 }]) });
  const results = await Promise.all(Array.from({ length: 20 }, (_, i) => checkLimit("refund", { ip: `6.6.6.${i}` })));
  assert.equal(results.filter((r) => r.ok).length, 10);
});

test("a visitor who exhausts their session counter does not spend the shared one", async () => {
  const prefix = `${root}c:`;
  const { checkLimit } = createLimiter({ redis, prefix, rules: small("scan", [{ scope: "session", max: 2, windowSec: 60 }, { scope: "global", max: 100, windowSec: 60 }]) });
  for (let i = 0; i < 6; i++) await checkLimit("scan", { ip: "5.5.5.5", session: "s" });
  assert.equal(Number(await redis.get(`${prefix}rl:scan:global:all`)), 2, "the 2 that passed; the one that found the session over stopped before the global counter, the rest never reached Redis");
});

test("A13-1 on the real database: 1,000 requests from one IP in a burst -> at most 20 eval calls, none for the blocked ones", async () => {
  const c = counted(redis);
  const { checkLimit } = createLimiter({ redis: c.redis, prefix: `${root}d:` });
  let ok = 0;
  for (let i = 0; i < 1000; i++) if ((await checkLimit("scan", { ip: "4.4.4.4", session: "flood" })).ok) ok++;
  assert.ok(c.stats.evals <= 20, `${c.stats.evals} Redis calls`);
  assert.equal(ok, 8, "the burst bucket lets 8 through at one instant");
  assert.equal((await checkLimit("scan", { ip: "3.3.3.3", session: "calm" })).ok, true, "a normal visitor is not affected");
});

test("the money budget on the real database: reserve, settle, and refuse past the cap; the day key expires", async () => {
  const b = createBudget({ redis, prefix: `${root}e:`, dailyUsd: 0.25 });
  const r1 = await b.reserve(0.1);
  const r2 = await b.reserve(0.1);
  assert.ok(r1 && r2);
  assert.equal(await b.reserve(0.1), null, "$0.30 would pass the $0.25 cap");
  await r1.settle(0.01);
  assert.ok(Math.abs((await b.spentUsd()) - 0.11) < 1e-6, `${await b.spentUsd()}`);
  assert.ok(await b.reserve(0.1), "settling made room");
  const keys = await redis.keys(`${root}e:bud$:*`);
  assert.equal(keys.length, 1);
  assert.ok((await redis.pttl(keys[0])) > 0, "the day key has an expiry");
});
