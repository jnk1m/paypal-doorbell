// The money budget (R13 8, plan 9.14), offline. The gate that joins it to the limiter and the cause step is tested here too.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createBudget, DAILY_BUDGET_USD } from "./budget.ts";
import { diagnose } from "./cause/cause.ts";
import { createLiveGate, spendCapGate } from "./cause/gate.ts";
import { answering, devInput, hanging, idOfText, rateLimited, throwing } from "./cause/test-helpers.ts";
import { buildRequest } from "./cause/prompt.ts";
import { costUsd, worstCaseUsd } from "./core/llm.ts";
import { createLimiter } from "./limits.ts";

const close = (a: number, b: number) => Math.abs(a - b) < 1e-9;

test("the day's cap is $1.50; a reservation that would pass it is refused and keeps nothing", async () => {
  const b = createBudget({ redis: null });
  assert.equal(DAILY_BUDGET_USD, 1.5);
  for (let i = 0; i < 15; i++) assert.ok(await b.reserve(0.1), `reservation ${i + 1}`);
  assert.equal(await b.reserve(0.1), null);
  assert.ok(close(await b.spentUsd(), 1.5));
  assert.equal(await b.reserve(0.0001), null, "even a tiny one: the day is full");
  await assert.rejects(() => b.reserve(0), /positive worst-case/);
  await assert.rejects(() => b.reserve(Number.NaN), /positive worst-case/);
});

test("settling replaces the worst case with the real cost, so cheap calls leave room; settling twice counts once", async () => {
  const b = createBudget({ redis: null });
  const r = (await b.reserve(0.1))!;
  await r.settle(0.01);
  await r.settle(0.01);
  await r.release(); // already finished: no second effect
  assert.ok(close(await b.spentUsd(), 0.01));
  for (let i = 0; i < 300; i++) {
    const x = await b.reserve(0.05);
    if (!x) break;
    await x.settle(0.01);
  }
  assert.ok((await b.spentUsd()) <= 1.5);
  assert.ok((await b.spentUsd()) > 1.45, "at $0.01 a call, about 149 calls fit under the cap");
});

test("release gives the whole reservation back", async () => {
  const b = createBudget({ redis: null, dailyUsd: 0.25 });
  const r = (await b.reserve(0.2))!;
  assert.equal(await b.reserve(0.1), null);
  await r.release();
  assert.ok(close(await b.spentUsd(), 0));
  assert.ok(await b.reserve(0.2));
});

test("an estimate that proved too low is recorded, not hidden: the next reservation sees the overspend", async () => {
  const b = createBudget({ redis: null, dailyUsd: 0.25 });
  const r = (await b.reserve(0.1))!;
  await r.settle(0.3); // really cost more than reserved
  assert.ok(close(await b.spentUsd(), 0.3));
  assert.equal(await b.reserve(0.01), null);
});

test("the budget is per UTC day: it is empty again the next day", async () => {
  let t = Date.parse("2026-10-19T23:00:00Z");
  const b = createBudget({ redis: null, now: () => t, dailyUsd: 0.2 });
  assert.ok(await b.reserve(0.1));
  assert.ok(await b.reserve(0.1));
  assert.equal(await b.reserve(0.1), null);
  t = Date.parse("2026-10-20T00:01:00Z");
  assert.ok(await b.reserve(0.1));
});

test("the worst case of a call grows with its request and covers the real cost of every dev-set call (4.2-4.5k tokens in, ~300 out)", () => {
  const dev = ["C1a", "C3a", "C6b", "Z"].map((id) => worstCaseUsd(buildRequest(devInput(id).input)));
  for (const w of dev) {
    assert.ok(w > costUsd({ inputTokens: 4600, outputTokens: 2000, reasoningTokens: 0 }), `reserve ${w}`);
    assert.ok(w < 0.05, `a typical call reserves cents, not dimes: ${w}`);
  }
  // the ceiling: 40 KB of diff and 60 KB of files at one token per 1.25 bytes
  const ceiling = ((104 * 1024) / 1.25 + 1000) * 2e-6 + 0.02;
  assert.ok(ceiling > 0.15 && ceiling < 0.2, `${ceiling}`);
});

test("A13-8: with the budget used up a live cause makes 0 model calls ('not diagnosed: budget'); calls that cost real money before it were made", async () => {
  const input = devInput("C1a").input;
  const need = worstCaseUsd(buildRequest(input));
  const budget = createBudget({ redis: null, dailyUsd: need * 2.5 }); // room for two reservations at a time
  const gate = createLiveGate({ limiter: createLimiter({ redis: null }), budget, ip: "1.1.1.1" });
  let calls = 0;
  const model = throwing(Object.assign(new Error("t"), { name: "TimeoutError" })); // cost unknown: the reservation stays
  const orig = model.doGenerate.bind(model);
  model.doGenerate = (async (o: never) => (calls++, orig(o))) as never;
  const seen: string[] = [];
  for (let i = 0; i < 4; i++) {
    const r = await diagnose(input, { mode: "live", model: model as never, gate, log: () => undefined });
    seen.push(r.status === "not_diagnosed" ? r.reason : r.status);
  }
  assert.deepEqual(seen, ["timeout", "timeout", "budget", "budget"]);
  assert.equal(calls, 2, "the third and fourth were refused before any model call");
});

test("calls that were answered settle to their real cost, so a busy day does not run out early", async () => {
  const input = devInput("C1a").input;
  const budget = createBudget({ redis: null, dailyUsd: worstCaseUsd(buildRequest(input)) * 1.6 }); // room for one worst-case reservation plus the real cost of the earlier calls
  const gate = createLiveGate({ limiter: createLimiter({ redis: null }), budget, ip: "2.2.2.2" });
  const model = answering({ category: "RAW_BODY_ALTERED", file: "src/app.js", lineIds: [idOfText(input, "app.use(paypalWebhook);")], hunkId: "" });
  for (let i = 0; i < 6; i++) {
    const r = await diagnose(input, { mode: "live", model: model as never, gate, log: () => undefined });
    assert.equal(r.status, "proposed", `call ${i + 1}: ${r.status === "not_diagnosed" ? r.reason : ""}`);
  }
  assert.ok((await budget.spentUsd()) < 0.02, `spent ${await budget.spentUsd()}: 6 mock calls of 1000 in / 50 out`);
});

test("failures that were not billed give the reservation back, so they cannot lock the day (A13-7)", async () => {
  const input = devInput("C1a").input;
  const budget = createBudget({ redis: null, dailyUsd: 0.3 });
  const gate = createLiveGate({ limiter: createLimiter({ redis: null }), budget, ip: "3.3.3.3" });
  const http = (statusCode: number) => throwing(Object.assign(new Error("x"), { name: "AI_APICallError", statusCode }));
  // 40 failures in one go (the burst bucket would stop a person; the gate's limiter is built fresh per call here)
  for (let i = 0; i < 40; i++) {
    const g = createLiveGate({ limiter: createLimiter({ redis: null }), budget, ip: `10.0.0.${i}` });
    const model = [http(429), http(401), http(503), rateLimited()][i % 4];
    const r = await diagnose(input, { mode: "live", model: model as never, gate: g, log: () => undefined });
    assert.equal(r.status, "not_diagnosed");
  }
  assert.ok(close(await budget.spentUsd(), 0), `spent ${await budget.spentUsd()} after 40 refused-by-provider calls`);
  assert.ok(gate, "the shared gate still grants: the day is not locked");
  const ok = await gate.acquire({ worstCaseUsd: 0.1 });
  assert.equal(ok.ok, true);

  // timeouts may have been billed: they keep their reservation and DO use up the day
  const slow = createBudget({ redis: null, dailyUsd: 0.1 });
  const g2 = createLiveGate({ limiter: createLimiter({ redis: null }), budget: slow, ip: "4.4.4.4" });
  const need = worstCaseUsd(buildRequest(input));
  assert.ok(need < 0.05);
  const outcomes: string[] = [];
  for (let i = 0; i < 4; i++) {
    const r = await diagnose(input, { mode: "live", model: hanging() as never, timeoutMs: 20, gate: g2, log: () => undefined });
    outcomes.push(r.status === "not_diagnosed" ? r.reason : r.status);
  }
  assert.deepEqual(outcomes, ["timeout", "timeout", "budget", "budget"]);
});

test("the gate asks the hourly limit for live model calls first: the 7th call in an hour is refused as rate_limited", async () => {
  let t = 1_000_000;
  const limiter = createLimiter({ redis: null, now: () => t });
  const budget = createBudget({ redis: null });
  const gate = createLiveGate({ limiter, budget, ip: "5.5.5.5" });
  const results: string[] = [];
  for (let i = 0; i < 8; i++) {
    t += 10_000;
    const g = await gate.acquire({ worstCaseUsd: 0.01 });
    results.push(g.ok ? "ok" : g.reason);
  }
  assert.deepEqual(results, ["ok", "ok", "ok", "ok", "ok", "ok", "rate_limited", "rate_limited"]);
});

test("spendCapGate (harness, recorder): refuses a call whose worst case would pass the cap it was given", async () => {
  const gate = spendCapGate(0.05);
  const a = await gate.acquire({ worstCaseUsd: 0.03 });
  assert.equal(a.ok, true);
  assert.equal((await gate.acquire({ worstCaseUsd: 0.03 })).ok, false);
  if (a.ok) await a.settle({ billed: "yes", usage: { inputTokens: 1000, outputTokens: 100, reasoningTokens: 0 } });
  assert.equal((await gate.acquire({ worstCaseUsd: 0.03 })).ok, true, "settling to the real cost made room");
  assert.ok((await gate.spentUsd()) > 0.03);
});
