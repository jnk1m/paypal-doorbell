// R13 (A-part), offline. The Redis run is limits.redis.test.ts. Redis here is a stand-in that counts every command the limiter sends it,
// which is how "a blocked request costs no Redis command" is measured.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Redis } from "@upstash/redis";
import { BURST, clientKey, createLimiter, RULES, type LimitKind } from "./limits.ts";

// Implements the one Lua script the limiter uses (every counter: INCR, PEXPIRE on its first hit; stop at the first one over, PTTL on it)
// and counts eval() calls and the commands inside them.
function countingRedis(now: () => number) {
  const store = new Map<string, { n: number; expiresAt: number }>();
  const stats = { evals: 0, commands: 0 };
  const redis = {
    eval: async (_script: string, keys: string[], args: (string | number)[]) => {
      stats.evals++;
      stats.commands++; // EVAL
      for (const [i, key] of keys.entries()) {
        stats.commands++; // INCR
        let e = store.get(key);
        if (!e || e.expiresAt <= now()) {
          e = { n: 0, expiresAt: now() + Number(args[2 * i]) };
          store.set(key, e);
          stats.commands++; // PEXPIRE
        }
        e.n++;
        if (e.n > Number(args[2 * i + 1])) {
          stats.commands++; // PTTL
          return [i + 1, e.n, e.expiresAt - now()];
        }
      }
      return [0, 0, 0];
    },
  };
  return { redis: redis as unknown as Redis, stats };
}

const memory = (now = () => Date.now()) => createLimiter({ redis: null, now });

test("hourly window per scope: the 11th session creation from one IP is blocked with a wait time, another IP is not", async () => {
  let t = 1_000_000;
  const { checkLimit } = memory(() => t);
  for (let i = 1; i <= 10; i++) {
    t += 10_000; // a person, not a script: the burst bucket refills
    assert.equal((await checkLimit("session", { ip: "1.1.1.1" })).ok, true, `session ${i}`);
  }
  t += 10_000;
  const blocked = await checkLimit("session", { ip: "1.1.1.1" });
  assert.deepEqual([blocked.ok, blocked.blockedBy], [false, "ip"]);
  assert.ok(blocked.retryAfterSec! > 3000 && blocked.retryAfterSec! <= 3600, `retryAfterSec ${blocked.retryAfterSec}`);
  assert.match(blocked.reason!, /^Limit reached for this hour\. Try again in \d+ min\.$/);
  assert.equal((await checkLimit("session", { ip: "2.2.2.2" })).ok, true);
});

test("the window ends: calls pass again after an hour", async () => {
  let t = 1_000_000;
  const { checkLimit } = memory(() => t);
  const step = async () => ((t += 10_000), (await checkLimit("refund", { ip: "1.1.1.1" })).ok);
  for (let i = 0; i < 10; i++) assert.equal(await step(), true);
  assert.equal(await step(), false);
  t += 3600 * 1000;
  assert.equal(await step(), true);
});

test("the global pool is shared by everybody and a session has its own count under it", async () => {
  let t = 1_000_000;
  const { checkLimit } = memory(() => t);
  const scan = async (ip: string, session: string) => ((t += 8_000), (await checkLimit("scan", { ip, session })));
  const perSession = RULES.scan[0].max;
  for (let i = 0; i < perSession; i++) assert.equal((await scan("1.1.1.1", "s1")).ok, true, `s1 scan ${i + 1}`);
  const s1 = await scan("1.1.1.1", "s1");
  assert.deepEqual([s1.ok, s1.blockedBy], [false, "session"]);
  assert.equal((await scan("1.1.1.1", "s2")).ok, true, "another session of the same IP has its own count");
});

test("the abuser is stopped by their own counter before they spend the shared pool", async () => {
  let t = 1_000_000;
  const { redis } = countingRedis(() => t);
  const { checkLimit } = createLimiter({ redis, now: () => t, prefix: "db:test:x:" });
  const [perSession, pool] = [RULES.scan[0].max, RULES.scan[1].max];
  // The session's counter fills and then blocks, so the global pool only ever saw `perSession` of the abuser's requests.
  for (let i = 0; i < perSession + 20; i++) {
    t += 8_000;
    await checkLimit("scan", { ip: "1.1.1.1", session: "s1" });
  }
  let other = 0;
  for (let i = 0; i < 40; i++) {
    t += 8_000;
    if ((await checkLimit("scan", { ip: `9.9.9.${i}`, session: `o${i}` })).ok) other++;
  }
  assert.equal(other, 40, `40 other visitors still fit: ${perSession} + 40 <= ${pool}`);
  assert.ok((perSession + 20) * 8 + 40 * 8 < 3600, "all of it inside one hour window");
});

test("IPv6 is counted by /64, an IPv4-mapped address as its IPv4, an empty address as one shared client", () => {
  assert.equal(clientKey("2001:db8:1:2:aaaa:bbbb:cccc:dddd"), clientKey("2001:db8:1:2::1"));
  assert.notEqual(clientKey("2001:db8:1:2::1"), clientKey("2001:db8:1:3::1"));
  assert.equal(clientKey("::ffff:203.0.113.9"), "203.0.113.9");
  assert.equal(clientKey("203.0.113.9"), "203.0.113.9");
  assert.equal(clientKey(" "), "unknown");
  assert.equal(clientKey("2001:DB8::1"), clientKey("2001:db8:0:0::7"));
});

test("burst bucket: 8 at once, then about 10 a minute; polling at 3, 10 and 20 s never meets it", async () => {
  let t = 1_000_000;
  const { checkLimit } = memory(() => t);
  let passed = 0;
  for (let i = 0; i < 100; i++) if ((await checkLimit("refund", { ip: "5.5.5.5" })).ok) passed++;
  assert.equal(passed, BURST.capacity, "a flood at one instant gets the burst and nothing more");
  const blocked = await checkLimit("refund", { ip: "5.5.5.5" });
  assert.deepEqual([blocked.ok, blocked.blockedBy], [false, "burst"]);
  assert.match(blocked.reason!, /Too many requests/);

  // a person polling for five minutes with the plan's backoff: 3 s x5, 10 s x4, then 20 s (19 scans)
  const poll = memory(() => t);
  const gaps = [...Array(5).fill(3_000), ...Array(4).fill(10_000), ...Array(10).fill(20_000)];
  for (const g of gaps) {
    t += g;
    assert.equal((await poll.checkLimit("scan", { ip: "6.6.6.6", session: "p" })).ok, true);
  }
});

test("A13-1: one IP sends 1,000 requests in 60 s -> at most 20 Redis commands (wrapper count), and a normal visitor is not affected", async () => {
  for (const kind of ["scan", "session", "order", "mode", "ring"] as LimitKind[]) {
    let t = 1_000_000;
    const { redis, stats } = countingRedis(() => t);
    const { checkLimit } = createLimiter({ redis, now: () => t, prefix: "db:test:flood:" });
    let ok = 0;
    for (let i = 0; i < 1000; i++) {
      t += 60; // 1,000 requests in 60 s
      if ((await checkLimit(kind, { ip: "7.7.7.7", session: "flood" })).ok) ok++;
    }
    assert.ok(stats.evals <= 20, `${kind}: ${stats.evals} Redis calls for 1,000 requests`);
    assert.ok(ok <= 20, `${kind}: ${ok} passed`);
    // somebody else, from another address, in the same minute
    t += 1000;
    assert.equal((await checkLimit(kind, { ip: "8.8.8.8", session: "calm" })).ok, true, `${kind}: a normal visitor`);
  }
});

test("a blocked request costs no Redis command: once a counter is over, its time left is remembered in memory", async () => {
  let t = 1_000_000;
  const { redis, stats } = countingRedis(() => t);
  const { checkLimit } = createLimiter({ redis, now: () => t, prefix: "db:test:b:" });
  for (let i = 0; i < RULES.refund[0].max; i++) {
    t += 8_000;
    assert.equal((await checkLimit("refund", { ip: `10.0.0.${i}` })).ok, true);
  }
  t += 8_000;
  assert.equal((await checkLimit("refund", { ip: "10.0.1.1" })).ok, false); // Redis says over
  const used = stats.evals;
  for (let i = 0; i < 200; i++) {
    t += 8_000 / 200;
    assert.equal((await checkLimit("refund", { ip: `10.0.2.${i % 250}` })).ok, false);
  }
  assert.equal(stats.evals, used, "200 more blocked requests, 0 more Redis calls");
  t += 3600 * 1000;
  assert.equal((await checkLimit("refund", { ip: "10.0.3.3" })).ok, true, "and the pool recovers within the hour");
});

test("an error from Redis is thrown, not swallowed: the call it guards must not run unchecked", async () => {
  const redis = { eval: async () => { throw new Error("redis down"); } } as unknown as Redis;
  const { checkLimit } = createLimiter({ redis });
  await assert.rejects(() => checkLimit("session", { ip: "1.1.1.1" }), /redis down/);
});

test("the numbers: live model 6/h global, scans 300/h per session and 600/h global (re-measured, see below), sessions 10/h per IP and 60/h global, refunds 10/h, replays 3/h per session and 20/h global", () => {
  assert.deepEqual(RULES.model, [{ scope: "global", max: 6, windowSec: 3600 }]);
  assert.deepEqual(RULES.scan.map((r) => [r.scope, r.max]), [["session", 300], ["global", 600]]);
  assert.deepEqual(RULES.session.map((r) => [r.scope, r.max]), [["ip", 10], ["global", 60]]);
  assert.deepEqual(RULES.refund.map((r) => [r.scope, r.max]), [["global", 10]]);
  assert.deepEqual(RULES.order.map((r) => [r.scope, r.max]), [["ip", 20], ["session", 6], ["global", 12]]);
  assert.deepEqual(RULES.replay.map((r) => [r.scope, r.max]), [["session", 3], ["global", 20]]);
  assert.deepEqual(RULES.mode.map((r) => [r.scope, r.max]), [["session", 60], ["global", 300]]);
  assert.deepEqual(RULES.ring.map((r) => [r.scope, r.max]), [["session", 30], ["global", 200]]);
});

// ---- the scan limit measured against the page's polling (S4: 20 an hour was too tight for 19 polls in 5 minutes) ----------------------
// The cadence of the page (plan 9.7): after the page loads or the visitor acts, a poll 3 s later, the next one 10 s after that, then one
// every 20 s; it stops 5 minutes after the last action.
function pollTimes(actionsAt: number[], endAt: number): number[] {
  const polls: number[] = [];
  actionsAt.forEach((a, i) => {
    const until = Math.min(actionsAt[i + 1] ?? Infinity, a + 300_000, endAt);
    let t = a + 3_000;
    for (let step = 0; t < until; step++) {
      polls.push(t);
      t += step === 0 ? 10_000 : 20_000;
    }
  });
  return polls;
}

async function pollThrough(times: number[], ip = "6.6.6.6", session = "p"): Promise<{ ok: number; blocked: { at: number; by: string | undefined }[] }> {
  let t = 0;
  const { checkLimit } = memory(() => t);
  let ok = 0;
  const blocked: { at: number; by: string | undefined }[] = [];
  for (const at of times) {
    t = at;
    const r = await checkLimit("scan", { ip, session });
    if (r.ok) ok++;
    else blocked.push({ at, by: r.blockedBy });
  }
  return { ok, blocked };
}

test("scan limit vs the page's polling: 16 polls after one action; a visit of 10 actions makes 61; acting every minute for an hour makes 240; none of it is blocked", async () => {
  const first5 = pollTimes([0], 3_600_000);
  const visit = pollTimes(Array.from({ length: 10 }, (_, i) => i * 90_000), 3_600_000); // 10 actions, 90 s apart, then 5 quiet minutes
  const nonStop = pollTimes(Array.from({ length: 60 }, (_, i) => i * 60_000), 3_600_000); // an action every minute for an hour
  assert.equal(first5.length, 16, "3 s, 10 s, then 20 s for the rest of 5 minutes");
  assert.equal(visit.length, VISIT_POLLS, "61 polls in a visit of 10 actions and 5 quiet minutes at the end");
  assert.equal(nonStop.length, 240, "4 polls a minute for an hour");

  for (const [name, times] of [["first 5 minutes", first5], ["a visit", visit], ["non-stop for an hour", nonStop]] as const) {
    const r = await pollThrough(times);
    assert.deepEqual(r.blocked, [], `${name}: ${times.length} polls, none blocked`);
    assert.equal(r.ok, times.length);
  }
  assert.ok(nonStop.length * 1.2 <= RULES.scan[0].max, `the session's ${RULES.scan[0].max} an hour covers the non-stop worst case (${nonStop.length}) with 20% to spare`);
  assert.ok(visit.length * 9 <= RULES.scan[1].max, "the pool of 600 an hour holds 9 visits");
});

test("scan limit: a poll loop that ignores the cadence (every 5 s, the old rough screen) is stopped, by the burst bucket, within minutes; one every 3 s within a minute", async () => {
  const every = (ms: number, n: number) => Array.from({ length: n }, (_, i) => (i + 1) * ms);
  const five = await pollThrough(every(5_000, 720)); // an hour at 12 a minute
  assert.equal(five.blocked[0]?.by, "burst");
  assert.ok(five.blocked[0].at <= 6 * 60_000, `first blocked after ${five.blocked[0].at / 1000} s`);
  const three = await pollThrough(every(3_000, 1200));
  assert.equal(three.blocked[0]?.by, "burst");
  assert.ok(three.blocked[0].at <= 60_000);
});

const VISIT_POLLS = 61; // measured by pollTimes above
