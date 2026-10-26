// A24, hosted path: the reporter tells "arrived and then crashed" from "never arrived", and makes no HTTP call of its own.
// The real process death is lib/shop/reporter.redis.test.ts; here a handler that never answers stands in for a function that was killed.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import https from "node:https";
import { readFileSync } from "node:fs";
import { CRASH_AFTER_MS, InProcessReporter, summarizeReport } from "./reporter.ts";
import { MemoryShopStore } from "./store.ts";
import { completedEvent, requestOf, shopWorld } from "./test-helpers.ts";
import { handleShopDelivery } from "./webhook.ts";

const settle = () => new Promise((r) => setTimeout(r, 5));

test("A24: five deliveries that arrive and never get an answer are 'crashed' and five that never arrive are 'no record': always told apart", async () => {
  const w = shopWorld();
  const hung: string[] = [];
  const never: string[] = [];
  w.paypal.state.mode = "ok";
  const realVerify = w.deps.verify;
  w.deps.verify = () => new Promise(() => {}); // the handler waits on PayPal for ever: the function would be killed at maxDuration
  for (let i = 0; i < 5; i++) {
    const { captureId } = await w.session("good");
    const d = w.paypal.sign(completedEvent(captureId));
    void handleShopDelivery(requestOf(d), w.deps); // never settles
    hung.push(d.eid);
    never.push(w.paypal.sign(completedEvent(captureId)).eid); // signed but never sent
  }
  await settle();
  const records = await w.store.reports([...hung, ...never]);

  const now = Date.now();
  for (const [i, record] of records.entries()) {
    const view = summarizeReport(record, now + CRASH_AFTER_MS + 1_000);
    if (i < 5) assert.deepEqual(view?.map((a) => a.state), ["crashed"], `event ${i} arrived and was never answered`);
    else assert.equal(view, null, `event ${i - 5} never arrived`);
  }
  // Soon after it arrives it is still being handled, not yet a crash.
  assert.deepEqual(summarizeReport(records[0], Date.now())?.map((a) => a.state), ["in_flight"]);
  w.deps.verify = realVerify;
});

test("A24: a retry of a crashed delivery is a second attempt; the first stays crashed and the second is answered", async () => {
  const w = shopWorld();
  const { sid, captureId } = await w.session("good");
  const d = w.paypal.sign(completedEvent(captureId));
  const realVerify = w.deps.verify;
  w.deps.verify = () => new Promise(() => {});
  void handleShopDelivery(requestOf(d), w.deps);
  await settle();
  w.deps.verify = realVerify;
  w.advance(34_000); // PayPal's second attempt, about 34 s later, with the same transmission id
  assert.equal((await handleShopDelivery(requestOf(d), w.deps)).status, 200);
  const [record] = await w.store.reports([d.eid]);
  const attempts = summarizeReport(record, Date.now() + 40_000)!;
  assert.deepEqual(attempts.map((a) => [a.tid, a.state, a.status]), [[d.tid, "crashed", undefined], [d.tid, "responded", 200]]);
  assert.equal((await w.store.getBook(sid, captureId))?.state, "paid");
});

test("A24: the reporter makes no HTTP request: nothing goes through fetch, http or https, and the module imports neither", async () => {
  const calls: string[] = [];
  const realFetch = globalThis.fetch;
  const realHttp = http.request;
  const realHttps = https.request;
  globalThis.fetch = ((input: unknown) => {
    calls.push(`fetch ${String(input)}`);
    throw new Error("unexpected fetch");
  }) as typeof fetch;
  http.request = ((...a: unknown[]) => {
    calls.push(`http.request ${String(a[0])}`);
    throw new Error("unexpected http.request");
  }) as typeof http.request;
  https.request = ((...a: unknown[]) => {
    calls.push(`https.request ${String(a[0])}`);
    throw new Error("unexpected https.request");
  }) as typeof https.request;
  try {
    const reporter = new InProcessReporter(new MemoryShopStore());
    for (let i = 0; i < 5; i++) {
      const attempt = await reporter.received(`tid-${i}`, `WH-${i}`);
      await reporter.responded(`tid-${i}`, 200, attempt);
    }
  } finally {
    globalThis.fetch = realFetch;
    http.request = realHttp;
    https.request = realHttps;
  }
  assert.deepEqual(calls, []);
  const source = readFileSync(new URL("./reporter.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source.replace(/\/\/.*$/gm, ""), /\bfetch\b|node:https?|XMLHttpRequest|WebSocket/);
});

test("summarizeReport: lines that do not parse are skipped, a responded line without its received line still counts, order follows arrival", () => {
  const record = ["not json", JSON.stringify({ k: "rs", tid: "t1", a: "x", at: 20, st: 500 }), JSON.stringify({ k: "rx", tid: "t2", a: "y", at: 5 }), JSON.stringify({ k: "rs", tid: "t2", a: "y", at: 6, st: 200 }), ""].join("\n");
  const rows = summarizeReport(record, 100)!;
  assert.deepEqual(rows.map((r) => [r.tid, r.state, r.status]), [["t2", "responded", 200], ["t1", "responded", 500]]);
  assert.equal(summarizeReport(null, 100), null);
});
