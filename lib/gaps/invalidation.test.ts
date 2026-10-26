import { test } from "node:test";
import assert from "node:assert/strict";
import { judgeEvent, LOSS_WINDOW_MS, tally } from "./invalidation.ts";

const facts = (over: Partial<Parameters<typeof judgeEvent>[0]>) => ({ what: "refund", sinceMs: 0, dHeard: false, listed: false, sReceived: false, ...over });

test("a trial is valid as soon as the shop has received the event it is about", () => {
  assert.deepEqual(judgeEvent(facts({ sReceived: true, dHeard: true })), { valid: true });
  assert.deepEqual(judgeEvent(facts({ sReceived: true, listed: true, sinceMs: 5_000 })), { valid: true });
  const odd = judgeEvent(facts({ sReceived: true }));
  assert.equal(odd.valid, true);
  assert.match((odd as { note: string }).note, /neither the witness nor PayPal's list/);
});

test("until the loss window ends nothing is decided; after it, an event the shop never received invalidates the trial, with the reason", () => {
  assert.deepEqual(judgeEvent(facts({ sinceMs: LOSS_WINDOW_MS - 1, dHeard: true })), { valid: "pending" });
  const none = judgeEvent(facts({ sinceMs: LOSS_WINDOW_MS }));
  assert.equal(none.valid, false);
  assert.match((none as { reason: string }).reason, /neither the witness nor the shop and is not in PayPal's list/);
  const dOnly = judgeEvent(facts({ sinceMs: LOSS_WINDOW_MS, dHeard: true }));
  assert.match((dOnly as { reason: string }).reason, /the witness heard it\) but the shop never received it/);
  const listedOnly = judgeEvent(facts({ sinceMs: LOSS_WINDOW_MS + 1000, listed: true }));
  assert.match((listedOnly as { reason: string }).reason, /in PayPal's list\) but the shop never received it/);
});

test("more than 30% invalid trials is reported as an unstable environment, exactly 30% is not", () => {
  const trials = (valid: number, invalid: number) => [...Array(valid).fill({ valid: true }), ...Array(invalid).fill({ valid: false })];
  assert.deepEqual(tally(trials(7, 3)), { valid: 7, invalid: 3, invalidRate: 0.3, verdict: "stable" });
  assert.equal(tally(trials(6, 3)).verdict, "environment unstable");
  assert.equal(tally(trials(10, 0)).verdict, "stable");
  assert.equal(tally([]).verdict, "stable");
});
