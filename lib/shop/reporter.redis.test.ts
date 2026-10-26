// Real Upstash, real process death. Not part of `npm test`. Run: REDIS_ENV_FILE=/path/to/.env.vercel npm run test:redis
// A24: a shop process that is killed inside its handler leaves a record that says "arrived, never answered"; an event that never
// reached the shop leaves none. Five of each, every one told apart. Every key lives under db:test:<run>: and is deleted at the end.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { redisFromEnv } from "../redis.ts";
import { deleteByPrefix, TEST_PREFIX } from "../test-redis.ts";
import { CRASH_AFTER_MS, summarizeReport } from "./reporter.ts";
import { RedisShopStore } from "./store.ts";
import { completedEvent, signed } from "./test-helpers.ts";

for (const file of [process.env.PAYPAL_ENV_FILE, process.env.REDIS_ENV_FILE]) if (file) process.loadEnvFile(file);
const redis = redisFromEnv();
if (!redis) throw new Error("missing env: KV_REST_API_URL, KV_REST_API_TOKEN. Load the Upstash .env.vercel first (see header).");
const prefix = `${TEST_PREFIX}${randomUUID().slice(0, 8)}:rep:`;
const store = new RedisShopStore(redis, prefix);
after(async () => console.log(`cleanup: deleted ${await deleteByPrefix(redis, prefix)} keys under ${prefix}`));

function runAndDie(raw: string, headers: Record<string, string>): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", new URL("./crash-child.ts", import.meta.url).pathname, JSON.stringify({ prefix, raw, headers })], { stdio: ["ignore", "ignore", "inherit"] });
    child.on("error", reject);
    child.on("exit", (code, signal) => resolve({ code, signal }));
  });
}

test("A24: 5 processes killed inside the handler leave 'crashed'; 5 events that never arrived leave no record (10/10 told apart)", async () => {
  const arrived: string[] = [];
  const never: string[] = [];
  for (let i = 0; i < 5; i++) {
    const captureId = `CRASHCAPTURE${randomUUID().slice(0, 8).toUpperCase()}`;
    const sid = `crash${i}`.padEnd(32, "0");
    await store.createSession(sid, "good", Date.now());
    await store.putOrder(sid, { n: 1, item: "gift-set", amount: "48.00", orderId: `ORDER${i}`, captureId, invoiceId: `MM-crash-${i}`, at: Date.now() });
    const d = signed(completedEvent(captureId));
    const exit = await runAndDie(d.raw, d.headers);
    assert.equal(exit.signal, "SIGKILL", `child ${i} was killed inside the handler (exit code ${exit.code})`);
    arrived.push(d.eid);
    never.push(signed(completedEvent(captureId)).eid);
  }
  const records = await store.reports([...arrived, ...never]);
  for (const [i, record] of records.entries()) {
    const view = summarizeReport(record, Date.now() + CRASH_AFTER_MS + 1_000);
    if (i < 5) assert.deepEqual(view?.map((a) => a.state), ["crashed"], `killed delivery ${i}`);
    else assert.equal(view, null, `delivery ${i - 5} never arrived`);
  }
  assert.deepEqual(summarizeReport(records[0], Date.now())?.map((a) => a.state), ["in_flight"], "right after it arrived it is still in flight, not yet a crash");
});
