// Tests every WitnessStore must pass: the memory store (npm test) and the Redis store (npm run test:redis) both run them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildEntry } from "./receive.ts";
import { checkHeaders, parseEvent } from "./precheck.ts";
import { ATTEMPT_CAP, QUARANTINE_KEEP, QUARANTINE_SOFT_CAP, type AttemptEntry, type WitnessStore } from "./store.ts";
import { fixture, requestOf, tidOf, type Delivery } from "./test-helpers.ts";

export interface StoreFactory {
  (opts: { budgetPerMinute: number; budgetWindowMs?: number }): Promise<{ store: WitnessStore; done: () => Promise<void> }>;
}

export function entryOf(d: Delivery, st: AttemptEntry["st"] = "ok", at = Date.now()): AttemptEntry {
  const h = checkHeaders(requestOf(d).headers, at);
  const e = parseEvent(d.raw);
  assert.ok(h.ok && e.ok);
  return buildEntry(h.headers, e.parsed, d.raw, at, st, st === "q" ? "unavail" : undefined);
}

export function storeContract(make: StoreFactory) {
  const withStore = async (opts: { budgetPerMinute: number; budgetWindowMs?: number }, run: (s: WitnessStore) => Promise<void>) => {
    const { store, done } = await make(opts);
    try {
      await run(store);
    } finally {
      await done();
    }
  };
  const [first, second] = fixture.singles;

  test("store: the first verified attempt of a transmission id is processed, repeats are kept but not processed", async () => {
    await withStore({ budgetPerMinute: 60 }, async (store) => {
      const attempts = fixture.retry.map((d) => entryOf(d));
      const results = [];
      for (const e of attempts) results.push(await store.commitVerified(e));
      assert.deepEqual(results.map((r) => r.processed), [true, false, false]);
      assert.deepEqual(results.map((r) => r.attempts), [1, 2, 3]);
      const stored = await store.attempts(tidOf(fixture.retry[0]));
      assert.equal(stored.length, 3);
      assert.deepEqual(stored[0], attempts[0]);
      assert.deepEqual((await store.commitVerified(entryOf(second))).processed, true, "another transmission id is processed on its own");
    });
  });

  test("store: attempts of one id are capped; the first is processed once and never again after trimming", async () => {
    await withStore({ budgetPerMinute: 60 }, async (store) => {
      const processed = [];
      for (let i = 0; i < ATTEMPT_CAP + 5; i++) processed.push((await store.commitVerified(entryOf(first))).processed);
      assert.equal(processed.filter(Boolean).length, 1);
      assert.equal((await store.attempts(tidOf(first))).length, ATTEMPT_CAP);
    });
  });

  test("store: the verify budget lets N through per window, then says how long is left; a new window starts afresh", async () => {
    // The window is long enough for seven round trips to Upstash (about 220 ms each from a laptop): five calls and the two that ask how long is left.
    await withStore({ budgetPerMinute: 3, budgetWindowMs: 3000 }, async (store) => {
      const answers = [];
      for (let i = 0; i < 5; i++) answers.push(await store.reserveVerify());
      assert.deepEqual(answers.map((a) => a.allowed), [true, true, true, false, false]);
      assert.ok(answers[3].msLeft! > 0 && answers[3].msLeft! <= 3000, `msLeft ${answers[3].msLeft}`);
      await new Promise((r) => setTimeout(r, 3300));
      assert.equal((await store.reserveVerify()).allowed, true);
    });
  });

  test("store: a quarantined entry is listed with its stored form, and resolving it moves it to the attempts exactly once", async () => {
    await withStore({ budgetPerMinute: 60 }, async (store) => {
      await store.quarantine(entryOf(first, "q"));
      await store.quarantine(entryOf(second, "q"));
      const listed = await store.listQuarantined(10);
      assert.equal(listed.length, 2);
      assert.equal(listed[0].entry.tid, tidOf(first));
      assert.equal(listed[0].entry.st, "q");
      const verified: AttemptEntry = { ...listed[0].entry, st: "ok", rv: Date.now() };
      delete verified.why;
      const [a, b] = await Promise.all([store.resolveQuarantined(listed[0].raw, verified), store.resolveQuarantined(listed[0].raw, verified)]);
      assert.deepEqual([a, b].filter((r) => r === "gone").length, 1, "one of two concurrent resolutions loses");
      assert.equal((await store.attempts(tidOf(first))).length, 1);
      assert.equal((await store.listQuarantined(10)).length, 1);
      assert.equal(await store.dropQuarantined(listed[1].raw), true);
      assert.equal(await store.dropQuarantined(listed[1].raw), false);
      assert.equal((await store.listQuarantined(10)).length, 0);
    });
  });

  test("store: the quarantine ring is bounded", async () => {
    await withStore({ budgetPerMinute: 60 }, async (store) => {
      const total = QUARANTINE_SOFT_CAP + 10;
      for (let from = 0; from < total; from += 100) {
        // Groups of 100 at a time keep a network-backed store quick.
        const group = Array.from({ length: Math.min(100, total - from) }, (_, i) => from + i);
        await Promise.all(group.map((n) => store.quarantine({ ...entryOf(first, "q"), at: n })));
      }
      const left = await store.listQuarantined(10_000);
      assert.ok(left.length >= QUARANTINE_KEEP && left.length <= QUARANTINE_SOFT_CAP, `ring holds ${left.length}`);
    });
  });
}
