import { test } from "node:test";
import assert from "node:assert/strict";
import { createCoalescer } from "./coalesce.ts";

test("requests for one key inside the window share one computation, after it a new one is made, other keys are independent", async () => {
  let t = 1_000;
  let runs = 0;
  const c = createCoalescer<number>({ now: () => t, windowMs: 2000 });
  const make = async () => ++runs;
  const results = await Promise.all([c.run("a", make), c.run("a", make), c.run("b", make)]);
  assert.deepEqual(results, [1, 1, 2]);
  t += 1999;
  assert.equal(await c.run("a", make), 1, "still inside 2 s");
  t += 1;
  assert.equal(await c.run("a", make), 3, "the window is over");
  assert.equal(runs, 3);
});

test("a computation that is still running is shared however long it takes, and the window starts when it has finished", async () => {
  let t = 0;
  let runs = 0;
  const c = createCoalescer<number>({ now: () => t, windowMs: 2000 });
  let finish!: (n: number) => void;
  const slow = () => {
    runs++;
    return new Promise<number>((resolve) => (finish = resolve));
  };
  const first = c.run("a", slow);
  t = 1_500; // inside the window measured from the start
  assert.equal(c.run("a", slow), first);
  t = 2_600; // past it: a window measured from the start would start a second scan here
  assert.equal(c.run("a", slow), first, "a poll during a long scan does not start another");
  t = 3_000;
  finish(7);
  assert.equal(await first, 7);
  assert.equal(runs, 1);
  t = 4_999; // 1,999 ms after it finished
  assert.equal(await c.run("a", slow), 7, "the window is 2 s from the end");
  t = 5_000;
  const next = c.run("a", slow);
  assert.notEqual(next, first, "2 s after it finished, the next poll computes again");
  assert.equal(runs, 2);
  finish(8);
  assert.equal(await next, 8);
});

test("a computation that failed is not kept: the next request tries again", async () => {
  let t = 1_000;
  let runs = 0;
  const c = createCoalescer<number>({ now: () => t });
  const failing = async (): Promise<number> => {
    runs++;
    throw new Error("down");
  };
  await assert.rejects(() => c.run("a", failing), /down/);
  await new Promise((r) => setTimeout(r, 0)); // the removal runs after the rejection settles
  assert.equal(await c.run("a", async () => 7), 7);
  assert.equal(runs, 1);
  assert.equal(c.size(), 1);
});

test("a request that arrives while a computation is failing gets the same failure; the one after it computes again", async () => {
  const c = createCoalescer<number>({});
  let reject!: (e: Error) => void;
  const pending = c.run("a", () => new Promise<number>((_, r) => (reject = r)));
  const waiting = c.run("a", async () => 99);
  reject(new Error("PayPal down"));
  await assert.rejects(pending, /PayPal down/);
  await assert.rejects(waiting, /PayPal down/);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(await c.run("a", async () => 5), 5);
});

test("the table is bounded: the oldest key goes first", async () => {
  const c = createCoalescer<number>({ max: 3 });
  for (const k of ["a", "b", "c", "d", "e"]) await c.run(k, async () => 1);
  assert.equal(c.size(), 3);
});
