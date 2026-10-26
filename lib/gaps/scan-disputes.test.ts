// The scan with disputes (Track B, variant L): PayPal is a stand-in whose shapes are the ones measured on 2026-10-20
// (docs/measurements/disputes-probe-2026-10-20.json): the dispute is listed 39 to 100 s after the chargeback, the capture goes PENDING about
// 3 minutes after it (no PAYMENT.CAPTURE.PENDING event), and the demo app's three webhooks subscribe to no dispute type.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DISPUTE_CREATED, DISPUTE_EVENT_DELAY_MS } from "./disputes.ts";
import { ABSENCE_WINDOW_MS } from "./classify.ts";
import { ringAgain } from "./ring.ts";
import { scanSession } from "./scan.ts";
import { gapWorld, SHOP_WEBHOOK } from "./test-world.ts";

type World = ReturnType<typeof gapWorld>;
const withDisputes = (w: World, over: { booked?: (captureId: string) => Promise<{ disputeId: string; at: number }[]> } = {}) => w.deps({ disputes: { reads: w.disputeReads, ...over } });
const scan = (w: World, sid: string, over?: Parameters<typeof withDisputes>[1]) => scanSession(withDisputes(w, over), sid, { mode: "good", at: 0 });

// Three healthy paid orders; the first one is the one that will be disputed.
async function shop(w: World) {
  const sid = await w.session();
  const orders = [];
  for (let i = 0; i < 3; i++) orders.push(await w.order(sid, { book: "paid", eventsListed: true }));
  return { sid, orders, target: orders[0].captureId };
}

test("an open dispute on a capture that is still COMPLETED: the row is a GAP, the dispute is NO_REPORT + UNSUBSCRIBED_EVENT_TYPE, and the other rows stay TIED", async () => {
  const w = gapWorld();
  const { sid, orders, target } = await shop(w);
  w.clock.now += 60_000;
  const d = w.dispute(target, { ageMs: 30_000, status: "OPEN" }); // listed 30 s after the chargeback: the CREATED event cannot exist yet
  const r = await scan(w, sid);
  const row = r.rows.find((x) => x.captureId === target)!;
  assert.deepEqual([row.status, row.truth, row.paypalStatus, row.waiting], ["GAP", "paid", "COMPLETED", undefined]);
  assert.equal(row.disputes?.length, 1);
  const v = row.disputes![0];
  assert.deepEqual([v.disputeId, v.status, v.amount, v.paypalStatus, v.finding?.cls, v.finding?.flag, v.finding?.final, v.ring?.state], [d.disputeId, "GAP", "48.00", "OPEN", "NO_REPORT", "UNSUBSCRIBED_EVENT_TYPE", true, "cannot_heal"]);
  assert.deepEqual([v.webhooks, v.sellerResponseDueAt, v.dueDateSource], [{ shop: false, any: false }, null, "not_set_yet"]);
  for (const o of orders.slice(1)) assert.equal(r.rows.find((x) => x.captureId === o.captureId)!.status, "TIED");
  assert.equal(r.rows.find((x) => x.captureId === target)!.events.every((e) => e.finding === null), true, "the payment itself is fine: no payment or refund finding");
  assert.deepEqual(r.summary, { rows: 3, tied: 2, gaps: 1, unverified: 0, byClass: {} }, "the dispute is counted as a gap row and is not an event class");
  assert.deepEqual(r.disputeReads, { asked: 3, unreadable: 0 });
});

test("the capture goes PENDING after the chargeback: the row is a dispute GAP (not 'not modelled'), is never TIED, and no payment gap is invented", async () => {
  const w = gapWorld();
  const { sid, target } = await shop(w);
  w.clock.now += 5 * 60_000;
  w.dispute(target, { ageMs: 4 * 60_000, due: true, status: "WAITING_FOR_SELLER_RESPONSE", pending: true });
  const r = await scan(w, sid);
  const row = r.rows.find((x) => x.captureId === target)!;
  assert.deepEqual([row.status, row.truth, row.paypalStatus, row.waiting, row.book?.state], ["GAP", null, "PENDING", undefined, "paid"]);
  assert.deepEqual(row.events.map((e) => e.finding), [null], "PENDING is explained by the dispute, not read as a payment that the books got wrong");
  assert.deepEqual([row.disputes![0].dueDateSource, row.disputes![0].sellerResponseDueAt], ["sandbox_test", Date.parse("2026-10-31T03:59:59.000Z")]);
  assert.deepEqual(r.summary.byClass, {});
  assert.equal(w.paypal.calls.list + w.paypal.calls.refund, 0, "no event list and no refund read for a payment that is not different");
});

test("a capture that is PENDING with no dispute found is still UNVERIFIED (status_not_modeled): never TIED, never a gap", async () => {
  const w = gapWorld();
  const { sid, target } = await shop(w);
  w.paypal.captures.set(target, "PENDING");
  const r = await scan(w, sid);
  const row = r.rows.find((x) => x.captureId === target)!;
  assert.deepEqual([row.status, row.waiting, row.disputes], ["UNVERIFIED", "status_not_modeled", undefined]);
});

test("a PENDING capture whose dispute list could not be read stays UNVERIFIED too, and the unread list is counted", async () => {
  const w = gapWorld();
  const { sid, target } = await shop(w);
  w.paypal.captures.set(target, "PENDING");
  w.paypal.disputeFailing.add(target);
  const r = await scan(w, sid);
  assert.deepEqual([r.rows.find((x) => x.captureId === target)!.status, r.disputeReads], ["UNVERIFIED", { asked: 3, unreadable: 1 }]);
  assert.equal(r.calls.retries, 1, "the failed read was tried once more");
});

test("a dispute list that cannot be read changes no row (it is counted, not turned into a verdict)", async () => {
  const w = gapWorld();
  const { sid, target } = await shop(w);
  w.paypal.disputeFailing.add(target);
  const r = await scan(w, sid);
  assert.deepEqual(r.rows.map((x) => x.status), ["TIED", "TIED", "TIED"]);
  assert.deepEqual(r.disputeReads, { asked: 3, unreadable: 1 });
  assert.equal(r.rows.some((x) => x.disputes), false);
});

test("the app has no right to the disputes API (403): no retry, the asking stops, every row is unread, and no row changes", async () => {
  const w = gapWorld();
  const { sid } = await shop(w);
  w.paypal.disputesDenied = true;
  const r = await scanSession({ ...withDisputes(w), concurrency: 1 }, sid, { mode: "good", at: 0 });
  assert.deepEqual(r.rows.map((x) => x.status), ["TIED", "TIED", "TIED"]);
  assert.equal(w.paypal.disputeCalls.disputes, 1, "one refusal ends the asking for this scan");
  assert.deepEqual(r.disputeReads, { asked: 1, unreadable: 3 });
  assert.equal(r.calls.retries, 0);
});

test("a dispute list that fails once and then answers is found on the retry", async () => {
  const w = gapWorld();
  const { sid, target } = await shop(w);
  w.dispute(target);
  let n = 0;
  const real = w.disputeReads.disputesOfCapture.bind(w.disputeReads);
  const reads = { ...w.disputeReads, disputesOfCapture: async (id: string, t: number) => (id === target && n++ === 0 ? (w.paypal.disputeFailing.add(id), real(id, t)) : (w.paypal.disputeFailing.delete(id), real(id, t))) };
  const r = await scanSession(w.deps({ disputes: { reads } }), sid, { mode: "good", at: 0 });
  assert.deepEqual([r.rows[0].status, r.calls.retries, r.disputeReads?.unreadable], ["GAP", 1, 0]);
});

test("a dispute read that never answers leaves the payment verdicts alone, stops at the deadline and says so", async () => {
  const w = gapWorld();
  const { sid, target } = await shop(w);
  w.paypal.disputeHang.add(target);
  const r = await scanSession({ ...withDisputes(w), deadlineMs: 300 }, sid, { mode: "good", at: 0 });
  assert.deepEqual(r.rows.map((x) => x.status), ["TIED", "TIED", "TIED"]);
  assert.equal(r.deadlineHit, true);
  assert.equal(r.disputeReads?.unreadable, 1);
});

test("a closed dispute makes no row and no finding", async () => {
  const w = gapWorld();
  const { sid, target } = await shop(w);
  w.dispute(target, { status: "RESOLVED" });
  const r = await scan(w, sid);
  assert.deepEqual([r.rows[0].status, r.rows[0].disputes], ["TIED", undefined]);
  assert.equal(w.paypal.disputeCalls.webhooks, 0, "the subscription is asked for only when there is an open dispute");
});

test("two disputed orders cost one read of the webhooks and no read of the event list while the shop's webhook is unsubscribed", async () => {
  const w = gapWorld();
  const { sid, orders } = await shop(w);
  w.dispute(orders[0].captureId);
  w.dispute(orders[1].captureId, { amount: "20.00" });
  const r = await scan(w, sid);
  assert.deepEqual(r.rows.map((x) => x.status), ["GAP", "GAP", "TIED"]);
  assert.deepEqual(r.rows.map((x) => x.disputes?.[0].amount), ["48.00", "20.00", undefined]);
  assert.deepEqual(w.paypal.disputeCalls, { disputes: 3, webhooks: 1, events: 0 });
  assert.deepEqual(r.summary, { rows: 3, tied: 1, gaps: 2, unverified: 0, byClass: {} });
});

test("a row that is a payment gap AND disputed stays a GAP with both: the event finding is kept and the dispute is attached", async () => {
  const w = gapWorld();
  const sid = await w.session("ack_then_drop");
  const a = await w.order(sid, { refund: true, book: "paid", eventsListed: true });
  w.clock.now += 60_000;
  await w.deliver({ eid: a.refundEid, tid: "t1", type: "PAYMENT.CAPTURE.REFUNDED", resourceId: a.refundId, status: 200, at: a.refundAt + 5000 });
  w.clock.now += 60_000;
  w.dispute(a.captureId);
  const r = await scan(w, sid);
  const row = r.rows[0];
  assert.deepEqual([row.status, row.events.find((e) => e.finding)?.finding?.cls, row.disputes?.length], ["GAP", "ACKED_BUT_NOT_APPLIED", 1]);
  assert.deepEqual(r.summary.byClass, { ACKED_BUT_NOT_APPLIED: 1 });
});

test("the shop's webhook subscribes: the event list is read; an event listed for under 6 minutes makes the row UNVERIFIED (absence_window), over 6 minutes a NO_REPORT gap", async () => {
  const w = gapWorld();
  const { sid, target } = await shop(w);
  w.paypal.webhooks[0].types.push(DISPUTE_CREATED);
  w.clock.now += 20 * 60_000;
  const d = w.dispute(target, { ageMs: 5 * 60_000, due: true });
  w.paypal.disputeEvents.push({ eid: "WH-4NY37331K6294023J-5X2155257W973735X", disputeId: d.disputeId, createTime: w.clock.now - 2 * 60_000 });
  const early = await scan(w, sid);
  const rowEarly = early.rows.find((x) => x.captureId === target)!;
  assert.deepEqual([rowEarly.status, rowEarly.waiting, rowEarly.disputes![0].finding?.waiting, rowEarly.disputes![0].eid], ["UNVERIFIED", "absence_window", "absence_window", "WH-4NY37331K6294023J-5X2155257W973735X"]);
  assert.equal(w.paypal.disputeCalls.events, 1);
  w.clock.now += ABSENCE_WINDOW_MS;
  const late = await scan(w, sid);
  const rowLate = late.rows.find((x) => x.captureId === target)!;
  assert.deepEqual([rowLate.status, rowLate.waiting, rowLate.disputes![0].finding?.cls, rowLate.disputes![0].finding?.flag, rowLate.disputes![0].ring?.state], ["GAP", undefined, "NO_REPORT", undefined, "cannot_heal"]);
});

test("the shop's webhook subscribes and the shop's reporter answered 200 to the event while the books got nothing: ACKED_BUT_NOT_APPLIED", async () => {
  const w = gapWorld();
  const { sid, target } = await shop(w);
  w.paypal.webhooks[0].types.push(DISPUTE_CREATED);
  w.clock.now += 20 * 60_000;
  const d = w.dispute(target, { ageMs: 15 * 60_000, due: true });
  const eid = "WH-4NY37331K6294023J-5X2155257W973735X";
  w.paypal.disputeEvents.push({ eid, disputeId: d.disputeId, createTime: w.clock.now - 10 * 60_000 });
  await w.store.appendReport(eid, JSON.stringify({ k: "rx", tid: "t1", a: "a1", at: w.clock.now - 9 * 60_000 }));
  await w.store.appendReport(eid, JSON.stringify({ k: "rs", tid: "t1", a: "a1", at: w.clock.now - 9 * 60_000 + 200, st: 200 }));
  const r = await scan(w, sid);
  const v = r.rows.find((x) => x.captureId === target)!.disputes![0];
  assert.deepEqual([v.finding?.cls, v.finding?.final, v.status], ["ACKED_BUT_NOT_APPLIED", true, "GAP"]);
});

test("the shop's webhook subscribes and no event is listed: the clock starts when the event can first exist (200 s after the dispute), then NO_EVENT_FOUND; an unreadable list is UNVERIFIED", async () => {
  const w = gapWorld();
  const { sid, target } = await shop(w);
  w.paypal.webhooks[0].types.push("*");
  w.clock.now += 20 * 60_000;
  w.dispute(target, { ageMs: ABSENCE_WINDOW_MS + 30_000 });
  const early = (await scan(w, sid)).rows.find((x) => x.captureId === target)!;
  assert.deepEqual([early.status, early.waiting], ["UNVERIFIED", "absence_window"]);
  w.clock.now += DISPUTE_EVENT_DELAY_MS;
  const late = (await scan(w, sid)).rows.find((x) => x.captureId === target)!;
  assert.deepEqual([late.status, late.disputes![0].finding?.cls, late.disputes![0].ring?.state], ["GAP", "NO_EVENT_FOUND", "cannot_heal"]);
  w.paypal.disputeEventsFail = true;
  const blind = (await scan(w, sid)).rows.find((x) => x.captureId === target)!;
  assert.deepEqual([blind.status, blind.waiting], ["UNVERIFIED", "listing_unavailable"]);
});

test("the list of webhooks cannot be read: no 'unsubscribed' is claimed; the event list decides, and the view says the subscription is unknown", async () => {
  const w = gapWorld();
  const { sid, target } = await shop(w);
  w.clock.now += 20 * 60_000;
  const d = w.dispute(target, { ageMs: 15 * 60_000 });
  w.paypal.webhooksFail = true;
  w.paypal.disputeEvents.push({ eid: "WH-4NY37331K6294023J-5X2155257W973735X", disputeId: d.disputeId, createTime: w.clock.now - 10 * 60_000 });
  const v = (await scan(w, sid)).rows.find((x) => x.captureId === target)!.disputes![0];
  assert.deepEqual([v.webhooks, v.finding?.cls, v.finding?.flag], [{ shop: null, any: null }, "NO_REPORT", undefined]);
});

test("a dispute the shop booked is TIED: the row stays as the payment says, and nothing is claimed", async () => {
  const w = gapWorld();
  const { sid, target } = await shop(w);
  const d = w.dispute(target, { ageMs: 10 * 60_000 });
  const r = await scan(w, sid, { booked: async (id) => (id === target ? [{ disputeId: d.disputeId, at: w.clock.now }] : []) });
  const row = r.rows.find((x) => x.captureId === target)!;
  assert.deepEqual([row.status, row.disputes![0].status, row.disputes![0].finding, row.disputes![0].ring], ["TIED", "TIED", null, null]);
  assert.equal(r.summary.gaps, 0);
});

test("a scan without dispute reads is exactly the scan it was: no dispute call, no dispute field, no disputeReads", async () => {
  const w = gapWorld();
  const { sid, target } = await shop(w);
  w.dispute(target);
  const r = await scanSession(w.deps(), sid, { mode: "good", at: 0 });
  assert.deepEqual(w.paypal.disputeCalls, { disputes: 0, webhooks: 0, events: 0 });
  assert.equal("disputeReads" in r, false);
  assert.equal(r.rows.some((x) => "disputes" in x), false);
  assert.deepEqual(r.summary, { rows: 3, tied: 3, gaps: 0, unverified: 0, byClass: {} });
});

test("the dispute pool is as wide as the capture pool and does not slow it: both finish inside one deadline", async () => {
  const w = gapWorld({ delayMs: 20 });
  const sid = await w.session();
  for (let i = 0; i < 6; i++) await w.order(sid, { book: "paid" });
  const r = await scan(w, sid);
  assert.deepEqual([r.deadlineHit, r.calls.captures, r.disputeReads], [false, 6, { asked: 6, unreadable: 0 }]);
  assert.ok(w.paypal.maxInFlight <= 10, `${w.paypal.maxInFlight} in flight`);
});

test("Ring again on a disputed order sends nothing and says why; the shop has no dispute book to heal", async () => {
  const w = gapWorld();
  const { sid, target } = await shop(w);
  w.clock.now += 60_000;
  w.dispute(target, { ageMs: 30_000 });
  const out = await ringAgain(withDisputes(w), sid, { mode: "good", at: 0 }, target);
  assert.equal(out.sent, false);
  if (out.sent) return;
  assert.equal(out.ring.state, "cannot_heal");
  assert.match(out.ring.label, /^Nothing to resend: no webhook of this app subscribes to dispute events/);
  assert.deepEqual(w.paypal.resends, [], "nothing was sent to PayPal");
  assert.equal((await w.store.heals(sid)).resends, 0, "and no resend was counted against the session");
});

test("Ring again on a disputed order whose dispute is not provable yet says to wait, with the time left", async () => {
  const w = gapWorld();
  const { sid, target } = await shop(w);
  w.paypal.webhooks[0].types.push(DISPUTE_CREATED);
  w.clock.now += 20 * 60_000;
  const d = w.dispute(target, { ageMs: 5 * 60_000 });
  w.paypal.disputeEvents.push({ eid: "WH-4NY37331K6294023J-5X2155257W973735X", disputeId: d.disputeId, createTime: w.clock.now - 60_000 });
  const out = await ringAgain(withDisputes(w), sid, { mode: "good", at: 0 }, target);
  assert.deepEqual(out.sent ? null : [out.ring.state, out.ring.waitMs], ["wait", ABSENCE_WINDOW_MS - 60_000]);
});

test("Ring again on a healthy order is unchanged: the books match", async () => {
  const w = gapWorld();
  const { sid, orders } = await shop(w);
  const out = await ringAgain(withDisputes(w), sid, { mode: "good", at: 0 }, orders[1].captureId);
  assert.deepEqual(out, { sent: false, ring: { state: "wait", label: "Nothing to resend: the books match PayPal" } });
  assert.equal(SHOP_WEBHOOK.length > 0, true);
});
