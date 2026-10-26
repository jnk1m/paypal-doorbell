// A13 item 9 (plan R13): a session costs at most 60 Redis commands in 10 minutes. One poll of the live lane is 7 commands (1 limiter EVAL, 4 HGETALL, 2 MGET:
// docs/measurements/s5-poll-cost.json, the same count on the real database), so 60 holds only for 8 polls. The lane keeps an idle session inside that with its
// back-off (lib/ui/live.ts pollDelayMs); an active one cannot, and docs/measurements/s6-a13-redis-2026-10-21.json says by how much.
//
// This pins both numbers: what one poll sends (it may go down, and cannot go up without this test failing) and how many polls an idle lane makes in 10 minutes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ROOT } from "../cause/test-helpers.ts";
import { computeDiffs } from "../shop/diffs.ts";
import { pollDelayMs } from "../ui/live.ts";
import { countingRedis, measurePoll } from "./poll-cost.ts";

// What one poll may send, by command. The snapshot route's work: the scan limit (1 EVAL for the session and the pool together), the session, the orders, the
// books and the heals (HGETALL each), and the heard/received and the report lookups (MGET each).
const PER_POLL = { eval: 1, hgetall: 4, mget: 2 } as const;
const PER_POLL_TOTAL = 7;
const IDLE_POLLS = (minutes: number): number => {
  let t = 0;
  let unchanged = 0;
  let polls = 1; // the first poll is at once
  for (t += pollDelayMs(unchanged, "idle"); t <= minutes * 60_000; t += pollDelayMs(unchanged, "idle")) {
    polls++;
    unchanged++;
  }
  return polls;
};

test("the counting stand-in counts like the database does: a call is 1, each command queued on a pipeline is 1, a command it does not know throws", async () => {
  const { redis, counts, reset } = countingRedis();
  await redis.hset("h", { a: "1", b: "2" });
  await redis.hgetall("h");
  await redis.mget("x", "y", "z");
  await redis.pipeline().hset("p", { a: "1" }).pexpire("p", 1000).exec();
  assert.deepEqual(counts, { calls: 5, byName: { hset: 1, hgetall: 1, mget: 1, "pipeline.hset": 1, "pipeline.pexpire": 1 } });
  reset();
  assert.deepEqual(counts, { calls: 0, byName: {} });
  await assert.rejects(() => (redis as unknown as { zadd: () => Promise<unknown> }).zadd(), /zadd" is not supported/);
});

test("one poll of the snapshot route sends no more than 7 commands: 1 EVAL, 4 HGETALL, 2 MGET", async () => {
  const cost = await measurePoll(computeDiffs(ROOT), 5);
  for (const name of Object.keys(cost.byName)) assert.ok(name in PER_POLL, `a command this test does not know is sent by a poll: ${name} (${cost.byName[name]} per poll)`);
  for (const [name, n] of Object.entries(PER_POLL)) assert.ok((cost.byName[name] ?? 0) <= n, `${name}: ${cost.byName[name]} per poll, at most ${n}`);
  assert.ok(cost.commandsPerPoll <= PER_POLL_TOTAL, `${cost.commandsPerPoll} commands per poll, at most ${PER_POLL_TOTAL}`);
  assert.equal(cost.commandsPerPoll, PER_POLL_TOTAL, "it is 7 today: if it went down, lower the numbers here and in docs/measurements/s6-a13-redis-2026-10-21.json");
});

test("a poll does not cost more with more orders: the reads are by hash and by key list, not one command per order", async () => {
  const bundle = computeDiffs(ROOT);
  const one = await measurePoll(bundle, 3, 2);
  const many = await measurePoll(bundle, 3, 8);
  assert.deepEqual(many.byName, one.byName);
  assert.equal(many.commandsPerPoll, PER_POLL_TOTAL);
});

test("an idle lane makes 7 polls in 10 minutes, so 49 commands: inside the 60 of the plan", () => {
  assert.equal(IDLE_POLLS(10), 7);
  assert.ok(IDLE_POLLS(10) * PER_POLL_TOTAL <= 60, `${IDLE_POLLS(10) * PER_POLL_TOTAL} commands`);
  // and it keeps going slowly, not at the old 20 s (180 polls an hour): after 5 minutes, one poll in 5 minutes
  assert.equal(IDLE_POLLS(60), 17, "7 in the first 10 minutes, then one every 5 minutes");
});
