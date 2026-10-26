// A3, in process (the live numbers are scripts/s3-acceptance.ts): planted gaps are found, healthy rows are not flagged, a read that failed is
// never TIED, the scan has a deadline, and its concurrency is 5.
import { test } from "node:test";
import assert from "node:assert/strict";
import { COMPLETED, REFUNDED } from "../shop/events.ts";
import { scanSession } from "./scan.ts";
import { gapWorld } from "./test-world.ts";

const SETTLED = 60_000; // long after an answer, so nothing is "settling" and no absence window is open

// 12 refunded rows whose refund the shop acknowledged and dropped (planted gaps) and 12 healthy ones.
async function plantedSession(w: ReturnType<typeof gapWorld>) {
  const sid = await w.session("ack_then_drop");
  const gaps: string[] = [];
  const healthy: string[] = [];
  for (let i = 0; i < 24; i++) {
    const gap = i < 12;
    const refund = gap || i < 18; // 12 gaps, 6 healthy refunded, 6 healthy paid
    const o = await w.order(sid, { refund, book: gap ? "paid" : refund ? "refunded" : "paid", eventsListed: true });
    if (gap) {
      await w.heard({ eid: o.refundEid, tid: `tid-${i}`, type: REFUNDED, resourceId: o.refundId, at: w.clock.now + 12_000 });
      await w.deliver({ eid: o.refundEid, tid: `tid-${i}`, type: REFUNDED, resourceId: o.refundId, status: 200, at: w.clock.now + 12_000 });
    }
    (gap ? gaps : healthy).push(o.captureId);
  }
  w.clock.now += SETTLED;
  return { sid, gaps, healthy };
}

test("A3: 12 planted gaps are all found as ACKED_BUT_NOT_APPLIED, 12 healthy rows are all TIED, none of them is flagged", async () => {
  const w = gapWorld();
  const { sid, gaps, healthy } = await plantedSession(w);
  const result = await scanSession(w.deps(), sid, { mode: "ack_then_drop", at: 0 });
  assert.equal(result.rows.length, 24);
  assert.deepEqual(result.summary, { rows: 24, tied: 12, gaps: 12, unverified: 0, byClass: { ACKED_BUT_NOT_APPLIED: 12 } });
  for (const id of gaps) assert.equal(result.rows.find((r) => r.captureId === id)!.status, "GAP", id);
  for (const id of healthy) assert.equal(result.rows.find((r) => r.captureId === id)!.status, "TIED", id);
  assert.deepEqual(result.calls, { captures: 24, refunds: 12, retries: 0 }, "a capture per row, a refund read only for the rows that differ");
  assert.equal(result.listing.asked, true);
  assert.ok(w.paypal.maxInFlight <= 5);
});

test("a session where everything agrees costs one read per row and never asks for the event list", async () => {
  const w = gapWorld();
  const sid = await w.session();
  for (let i = 0; i < 4; i++) await w.order(sid, { refund: i % 2 === 0, book: i % 2 === 0 ? "refunded" : "paid" });
  const result = await scanSession(w.deps(), sid, { mode: "good", at: 0 });
  assert.deepEqual([result.summary.tied, result.summary.gaps, result.summary.unverified], [4, 0, 0]);
  assert.deepEqual(result.listing, { asked: false, read: false, events: 0 });
  assert.equal(w.paypal.calls.list + w.paypal.calls.subscription + w.paypal.calls.refund, 0);
});

test("A3: five failed re-queries leave five rows UNVERIFIED and not one of them TIED; the other rows are unaffected", async () => {
  const w = gapWorld();
  const { sid, gaps, healthy } = await plantedSession(w);
  const hit = [...healthy.slice(0, 3), ...gaps.slice(0, 2)];
  for (const id of hit) w.paypal.failing.add(id);
  const result = await scanSession(w.deps(), sid, { mode: "ack_then_drop", at: 0 });
  for (const id of hit) {
    const row = result.rows.find((r) => r.captureId === id)!;
    assert.equal(row.status, "UNVERIFIED", id);
    assert.equal(row.waiting, "requery_failed");
    assert.equal(row.truth, null);
    assert.equal(row.events.every((e) => e.finding === null), true, "no verdict without an answer from PayPal");
  }
  assert.equal(result.rows.filter((r) => hit.includes(r.captureId) && r.status === "TIED").length, 0);
  assert.deepEqual(result.summary, { rows: 24, tied: 9, gaps: 10, unverified: 5, byClass: { ACKED_BUT_NOT_APPLIED: 10 } });
  assert.equal(result.calls.retries, 5, "each failed read was tried once more");
  assert.equal(w.paypal.calls.capture, 24 + 5);
});

test("a read that fails once and then answers is used (one retry per read); a row whose list was never read is not a verdict", async () => {
  const w = gapWorld();
  const sid = await w.session();
  const a = await w.order(sid, { book: "paid" });
  w.paypal.failFirst.add(a.captureId);
  const result = await scanSession(w.deps(), sid, { mode: "good", at: 0 });
  assert.equal(result.rows[0].status, "TIED");
  assert.equal(result.calls.retries, 1);
});

test("the scan answers by its deadline: a read that never returns leaves its row UNVERIFIED and the others stand", async () => {
  const w = gapWorld();
  const sid = await w.session();
  const hang = await w.order(sid, { book: "paid" });
  const fine = await w.order(sid, { book: "paid" });
  w.paypal.hang.add(hang.captureId);
  const t0 = Date.now();
  const result = await scanSession(w.deps({ now: Date.now, deadlineMs: 400 }), sid, { mode: "good", at: 0 });
  assert.ok(Date.now() - t0 < 900, `the scan took ${Date.now() - t0} ms`);
  assert.equal(result.deadlineHit, true);
  assert.equal(result.rows.find((r) => r.captureId === hang.captureId)!.status, "UNVERIFIED");
  assert.equal(result.rows.find((r) => r.captureId === fine.captureId)!.status, "TIED");
});

test("concurrency is 5: 24 re-queries that each take a moment never run more than five at once", async () => {
  const w = gapWorld({ delayMs: 20 });
  const sid = await w.session();
  for (let i = 0; i < 24; i++) await w.order(sid, { book: "paid" });
  const result = await scanSession(w.deps({ now: Date.now }), sid, { mode: "good", at: 0 });
  assert.equal(result.summary.tied, 24);
  assert.equal(w.paypal.maxInFlight, 5);
});

test("a state PayPal reports that the shop does not book (partly refunded) is UNVERIFIED, not a gap and not TIED", async () => {
  const w = gapWorld();
  const sid = await w.session();
  const a = await w.order(sid, { book: "paid" });
  w.paypal.captures.set(a.captureId, "PARTIALLY_REFUNDED");
  const result = await scanSession(w.deps(), sid, { mode: "good", at: 0 });
  assert.deepEqual([result.rows[0].status, result.rows[0].waiting, result.rows[0].paypalStatus], ["UNVERIFIED", "status_not_modeled", "PARTIALLY_REFUNDED"]);
});

test("a payment the books do not have, with no event anywhere: UNVERIFIED inside 6 minutes, NO_EVENT_FOUND after, and never when the list could not be read", async () => {
  const w = gapWorld();
  const sid = await w.session();
  const a = await w.order(sid, { book: null });
  const at = (ms: number) => ((w.clock.now = a.at + ms), scanSession(w.deps(), sid, { mode: "good", at: 0 }));
  const early = await at(5 * 60_000);
  assert.deepEqual([early.rows[0].status, early.rows[0].events[0].finding?.cls, early.rows[0].events[0].finding?.waiting], ["UNVERIFIED", "UNVERIFIED", "absence_window"]);
  const late = await at(6 * 60_000);
  assert.deepEqual([late.rows[0].status, late.rows[0].events[0].finding?.cls, late.rows[0].events[0].ring?.state], ["GAP", "NO_EVENT_FOUND", "cannot_heal"]);
  w.paypal.listFails = true;
  const blind = await at(60 * 60_000);
  assert.deepEqual([blind.rows[0].status, blind.rows[0].waiting, blind.listing.read], ["UNVERIFIED", "listing_unavailable", false]);
});

test("an event PayPal listed that the shop never reported: NO_REPORT only after 6 minutes, and at once when the shop's webhook lacks the type", async () => {
  const w = gapWorld();
  const sid = await w.session();
  const a = await w.order(sid, { refund: true, book: "paid", eventsListed: true });
  await w.heard({ eid: a.refundEid, tid: "tid-d", type: REFUNDED, resourceId: a.refundId, at: a.refundAt + 12_000 });
  const scan = async (ms: number) => ((w.clock.now = a.refundAt + ms), scanSession(w.deps(), sid, { mode: "good", at: 0 }));
  const early = await scan(2 * 60_000);
  assert.deepEqual([early.rows[0].events[1].finding?.cls, early.rows[0].events[1].ring?.state], ["UNVERIFIED", "wait"]);
  const late = await scan(8 * 60_000);
  const f = late.rows[0].events[1].finding!;
  assert.deepEqual([f.cls, f.flag, f.final, late.rows[0].events[1].ring?.state], ["NO_REPORT", undefined, true, "ready"]);
  w.paypal.subscribed = [COMPLETED]; // the shop's webhook does not subscribe to REFUNDED
  const unsub = await scan(30_000);
  assert.deepEqual([unsub.rows[0].events[1].finding?.cls, unsub.rows[0].events[1].finding?.flag, unsub.rows[0].events[1].finding?.final], ["NO_REPORT", "UNSUBSCRIBED_EVENT_TYPE", true]);
});

test("a webhook subscribed to every event is listed by PayPal as the single type \"*\": it is not UNSUBSCRIBED_EVENT_TYPE", async () => {
  const w = gapWorld();
  const sid = await w.session();
  const a = await w.order(sid, { refund: true, book: "paid", eventsListed: true });
  await w.heard({ eid: a.refundEid, tid: "tid-d", type: REFUNDED, resourceId: a.refundId, at: a.refundAt + 12_000 });
  w.clock.now = a.refundAt + 8 * 60_000;
  w.paypal.subscribed = ["*"];
  const all = await scanSession(w.deps(), sid, { mode: "good", at: 0 });
  const f = all.rows[0].events[1].finding!;
  assert.deepEqual([f.cls, f.flag], ["NO_REPORT", undefined], "the miss is still a miss, but the type is heard");
  w.paypal.subscribed = [COMPLETED]; // a wildcard is the only form PayPal accepts (PAYMENT.CAPTURE.* is a VALIDATION_ERROR)
  const some = await scanSession(w.deps(), sid, { mode: "good", at: 0 });
  assert.equal(some.rows[0].events[1].finding?.flag, "UNSUBSCRIBED_EVENT_TYPE");
});

test("HANDLER_REJECTING and OUT_OF_ORDER come out of a scan as they do out of the classifier, and a list entry gives the event its id", async () => {
  const w = gapWorld();
  const sid = await w.session("bad_body");
  const a = await w.order(sid, { refund: true, book: "paid", eventsListed: true });
  await w.deliver({ eid: a.refundEid, tid: "tid-1", type: REFUNDED, resourceId: a.refundId, status: 401, at: a.refundAt + 12_000 });
  w.clock.now = a.refundAt + 20_000;
  const rejecting = await scanSession(w.deps(), sid, { mode: "bad_body", at: 0 });
  assert.deepEqual([rejecting.rows[0].events[1].finding?.cls, rejecting.rows[0].events[1].finding?.final, rejecting.rows[0].events[1].ring?.state], ["HANDLER_REJECTING", true, "retries_pending"]);

  const b = await w.order(sid, { refund: true, eventsListed: true });
  await w.book(sid, b.captureId, { state: "refunded", amount: "48.00", eid: b.refundEid, at: b.refundAt + 12_300 });
  await w.deliver({ eid: b.refundEid, tid: "tid-2", type: REFUNDED, resourceId: b.refundId, status: 200, at: b.refundAt + 12_000 });
  await w.book(sid, b.captureId, { state: "paid", amount: "48.00", eid: b.paidEid, at: b.refundAt + 15_000 }); // the late "paid" overwrote it
  w.clock.now = b.refundAt + 60_000;
  const late = await scanSession(w.deps(), sid, { mode: "good", at: 0 }, { only: b.captureId });
  const f = late.rows[0].events[1].finding!;
  assert.deepEqual([f.cls, f.flag], ["ACKED_BUT_NOT_APPLIED", "OUT_OF_ORDER"]);
});

test("the witness quarantine is re-verified by every scan; a re-verify that fails or hangs does not fail the scan", async () => {
  const w = gapWorld();
  const sid = await w.session();
  await w.order(sid, { book: "paid" });
  let calls = 0;
  const ok = await scanSession(w.deps({ reverify: async () => (calls++, { checked: 1, verified: 1 }) }), sid, { mode: "good", at: 0 });
  assert.equal(calls, 1);
  assert.deepEqual(ok.reverify, { checked: 1, verified: 1 });
  const failed = await scanSession(w.deps({ reverify: async () => Promise.reject(new Error("verify down")) }), sid, { mode: "good", at: 0 });
  assert.equal(failed.summary.tied, 1);
  assert.deepEqual(failed.reverify, { error: "re-verify failed" });
  const t0 = Date.now();
  const hung = await scanSession(w.deps({ now: Date.now, deadlineMs: 300, reverify: () => new Promise(() => undefined) }), sid, { mode: "good", at: 0 });
  assert.ok(Date.now() - t0 < 800);
  assert.equal(hung.summary.tied, 1);
  assert.deepEqual(hung.reverify, { error: "re-verify did not finish before the deadline" });
});

test("scanning one capture reads only that one", async () => {
  const w = gapWorld();
  const sid = await w.session();
  const [a] = [await w.order(sid, { book: "paid" }), await w.order(sid, { book: "paid" })];
  const result = await scanSession(w.deps(), sid, { mode: "good", at: 0 }, { only: a.captureId });
  assert.equal(result.rows.length, 1);
  assert.equal(w.paypal.calls.capture, 1);
});
