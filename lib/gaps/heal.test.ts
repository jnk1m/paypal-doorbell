// A5, in process (the live numbers are scripts/s3-acceptance.ts): who may ring, when, how often, and what counts as healed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { HttpError } from "../web/http.ts";
import { PaypalError } from "../pay/paypal.ts";
import { REFUNDED } from "../shop/events.ts";
import type { AttemptReport } from "../shop/reporter.ts";
import type { BookEntry, HealRecord } from "../shop/types.ts";
import { assessHeal, ARRIVAL_WAIT_MS, MAX_SENDS } from "./heal.ts";
import { ringAgain } from "./ring.ts";
import { scanSession } from "./scan.ts";
import { gapWorld } from "./test-world.ts";

// ---- assessHeal (pure) ----------------------------------------------------------------------------------------------------

const before: BookEntry = { state: "paid", amount: "48.00", eid: "WH-PAID", at: 100 };
const record = (over: Partial<HealRecord> = {}): HealRecord => ({ eid: "WH-R", captureId: "CAPTURE-1", kind: "refunded", state: "sent", seen: ["tid-old"], sends: [1_000], booksBefore: { state: "paid", eid: "WH-PAID", at: 100 }, ...over });
const att = (over: Partial<AttemptReport>): AttemptReport => ({ tid: "tid-new", attempt: "a1", state: "responded", status: 200, receivedAt: 5_000, respondedAt: 5_300, ...over });

test("heal: nothing arrived yet -> still sent; after 60 s with no arrival a retry is due; after three sends it is lost", () => {
  assert.deepEqual(assessHeal(record(), 1_000 + ARRIVAL_WAIT_MS - 1, { attempts: [att({ tid: "tid-old" })], books: before, truth: "refunded" }), { record: record(), retry: false });
  assert.deepEqual(assessHeal(record(), 1_000 + ARRIVAL_WAIT_MS, { attempts: null, books: before, truth: "refunded" }), { record: record(), retry: true });
  const spent = record({ sends: [1_000, 70_000, 140_000] });
  assert.equal(spent.sends.length, MAX_SENDS);
  const r = assessHeal(spent, 140_000 + ARRIVAL_WAIT_MS, { attempts: null, books: before, truth: "refunded" });
  assert.deepEqual([r.record.state, r.retry], ["lost", false]);
});

test("heal: a delivery with a new transmission id is the resend arriving; the old ids are not", () => {
  const old = assessHeal(record(), 6_000, { attempts: [att({ tid: "tid-old", receivedAt: 5_000 })], books: before, truth: "refunded" });
  assert.equal(old.record.state, "sent", "a PayPal retry of the original delivery is not the resend");
  const arrived = assessHeal(record(), 6_000, { attempts: [att({ receivedAt: 5_000, state: "in_flight", status: undefined, respondedAt: undefined })], books: before, truth: "refunded" });
  assert.deepEqual([arrived.record.state, arrived.record.arrivedAt], ["arrived", 5_000]);
});

test("heal: healed only when the books changed AND now agree with PayPal's own answer", () => {
  const after: BookEntry = { state: "refunded", amount: "48.00", eid: "WH-R", at: 5_200 };
  const healed = assessHeal(record(), 20_000, { attempts: [att({})], books: after, truth: "refunded" });
  assert.deepEqual([healed.record.state, healed.record.healedAt, healed.record.answer], ["healed", 20_000, 200]);
  // The resend arrived and was answered, the books did not change: not healed, and after the settle it says so.
  const soon = assessHeal(record(), 5_300 + 9_999, { attempts: [att({})], books: before, truth: "refunded" });
  assert.equal(soon.record.state, "arrived");
  const unchanged = assessHeal(record(), 5_300 + 10_000, { attempts: [att({})], books: before, truth: "refunded" });
  assert.deepEqual([unchanged.record.state, unchanged.record.answer], ["unchanged", 200]);
  // PayPal's answer was not read this time: nothing can be called healed.
  assert.equal(assessHeal(record(), 20_000, { attempts: [att({})], books: after, truth: null }).record.state, "arrived");
  // The books "agree" with PayPal but are exactly what they were when the ring was pressed: not a heal.
  const same = assessHeal(record({ booksBefore: { state: "refunded", eid: "WH-R", at: 5_200 } }), 20_000, { attempts: [att({})], books: after, truth: "refunded" });
  assert.notEqual(same.record.state, "healed");
});

test("heal: the books put right by PayPal's own retry are a heal too, without claiming a resent delivery", () => {
  const after: BookEntry = { state: "refunded", amount: "48.00", eid: "WH-R", at: 3_000 };
  const r = assessHeal(record(), 4_000, { attempts: [att({ tid: "tid-old" })], books: after, truth: "refunded" });
  assert.deepEqual([r.record.state, r.record.arrivedAt], ["healed", undefined]);
});

// ---- ringing (the whole path, against the in-memory store and a stand-in PayPal) ----------------------------------------

// A refunded order whose refund the shop acknowledged and dropped, long enough ago, with its event in PayPal's list.
async function droppedRefund(w: ReturnType<typeof gapWorld>, over: { listed?: boolean; answeredAgo?: number } = {}) {
  const sid = await w.session("ack_then_drop");
  const o = await w.order(sid, { refund: true, book: "paid", eventsListed: over.listed ?? true });
  await w.heard({ eid: o.refundEid, tid: "tid-first", type: REFUNDED, resourceId: o.refundId, at: o.refundAt + 12_000 });
  await w.deliver({ eid: o.refundEid, tid: "tid-first", type: REFUNDED, resourceId: o.refundId, status: 200, at: o.refundAt + 12_000 });
  w.clock.now = o.refundAt + 12_000 + (over.answeredAgo ?? 30_000);
  return { sid, ...o };
}
const session = { mode: "ack_then_drop" as const, at: 0 };

test("A5: ringing a gap whose event is in the list sends one resend to the shop's webhook only, and records it", async () => {
  const w = gapWorld();
  const { sid, captureId, refundEid } = await droppedRefund(w);
  const out = await ringAgain(w.deps(), sid, session, captureId);
  assert.equal(out.sent, true);
  assert.deepEqual(w.paypal.resends, [{ eid: refundEid, webhookId: "SHOPWEBHOOK0000001" }]);
  const { resends, records } = await w.store.heals(sid);
  assert.equal(resends, 1);
  assert.deepEqual([records[refundEid].state, records[refundEid].seen, records[refundEid].booksBefore?.state], ["sent", ["tid-first"], "paid"]);
  const again = await ringAgain(w.deps(), sid, session, captureId);
  assert.deepEqual(again, { sent: false, ring: { state: "in_progress", label: "Resent, waiting for it to arrive" } });
  assert.equal(w.paypal.resends.length, 1, "a second click while it is in flight sends nothing");
});

test("A5: a gap whose event is not in PayPal's list cannot be healed: 'cannot auto-heal', 0 resends (100%)", async () => {
  const w = gapWorld();
  const cases: string[] = [];
  for (let i = 0; i < 5; i++) {
    const { sid, captureId } = await droppedRefund(w, { listed: false });
    const out = await ringAgain(w.deps(), sid, session, captureId);
    assert.equal(out.sent, false);
    cases.push(out.sent ? "sent" : `${out.ring.state}: ${out.ring.label}`);
  }
  assert.deepEqual(new Set(cases), new Set(["not_listed: Cannot auto-heal: the event is not in PayPal's list (it shows up 80 to 163 s late)"]));
  assert.equal(w.paypal.resends.length, 0);
  // No event anywhere, 6 minutes on: also cannot auto-heal.
  const sid = await w.session();
  const lost = await w.order(sid, { book: null });
  w.clock.now = lost.at + 7 * 60_000;
  const out = await ringAgain(w.deps(), sid, session, lost.captureId);
  assert.deepEqual(out, { sent: false, ring: { state: "cannot_heal", label: "Cannot auto-heal: no event found anywhere" } });
  assert.equal(w.paypal.resends.length, 0);
});

test("A5: another session's order, and anything that is not an order of this session, is a 403 and sends nothing, reads nothing", async () => {
  const w = gapWorld();
  const mine = await droppedRefund(w);
  const theirs = await droppedRefund(w);
  const calls = () => JSON.stringify(w.paypal.calls);
  const reads = calls();
  for (const id of [theirs.captureId, theirs.refundId, theirs.refundEid, theirs.paidEid, "CAPTURE-DOES-NOT-EXIST"]) {
    await assert.rejects(ringAgain(w.deps(), mine.sid, session, id), (e: unknown) => e instanceof HttpError && e.status === 403 && e.message === "Forbidden.", id);
  }
  assert.equal(w.paypal.resends.length, 0);
  assert.equal(calls(), reads, "no PayPal read was made for a forbidden request");
  assert.equal((await w.store.heals(mine.sid)).resends, 0);
  assert.equal((await w.store.heals(theirs.sid)).resends, 0);
});

test("A5: at most 5 resends per session; the sixth is refused and PayPal is not asked", async () => {
  const w = gapWorld();
  const sid = await w.session("ack_then_drop");
  const made = [];
  for (let i = 0; i < 6; i++) {
    const o = await w.order(sid, { refund: true, book: "paid", eventsListed: true });
    await w.heard({ eid: o.refundEid, tid: `tid-${i}`, type: REFUNDED, resourceId: o.refundId, at: o.refundAt + 12_000 });
    await w.deliver({ eid: o.refundEid, tid: `tid-${i}`, type: REFUNDED, resourceId: o.refundId, status: 200, at: o.refundAt + 12_000 });
    made.push(o);
  }
  w.clock.now += 60_000;
  const results = [];
  for (const o of made) results.push(await ringAgain(w.deps(), sid, session, o.captureId));
  assert.deepEqual(results.map((r) => r.sent), [true, true, true, true, true, false]);
  assert.deepEqual(results[5], { sent: false, ring: { state: "cap_reached", label: "Resend limit reached (5 per session)" } });
  assert.equal(w.paypal.resends.length, 5);
});

test("A5: while PayPal's own retries are pending the button is disabled and the ring sends nothing; once they are over it is ready", async () => {
  const w = gapWorld();
  const sid = await w.session("bad_body");
  const o = await w.order(sid, { refund: true, book: "paid", eventsListed: true });
  await w.deliver({ eid: o.refundEid, tid: "tid-1", type: REFUNDED, resourceId: o.refundId, status: 401, at: o.refundAt + 12_000 });
  w.clock.now = o.refundAt + 12_000 + 40_000;
  const pending = await ringAgain(w.deps(), sid, { mode: "bad_body", at: 0 }, o.captureId);
  assert.equal(pending.sent, false);
  assert.equal(!pending.sent && pending.ring.state, "retries_pending");
  assert.equal(w.paypal.resends.length, 0);
  await w.deliver({ eid: o.refundEid, tid: "tid-1", type: REFUNDED, resourceId: o.refundId, status: 401, at: o.refundAt + 12_000 + 34_000 });
  await w.deliver({ eid: o.refundEid, tid: "tid-1", type: REFUNDED, resourceId: o.refundId, status: 401, at: o.refundAt + 12_000 + 160_000 });
  w.clock.now = o.refundAt + 12_000 + 170_000;
  assert.equal((await ringAgain(w.deps(), sid, { mode: "bad_body", at: 0 }, o.captureId)).sent, true, "three attempts made: PayPal is done");
});

test("A5: a resend PayPal refuses (404, not ready) costs nothing: no heal record, no count used, the answer says why", async () => {
  const w = gapWorld();
  const { sid, captureId } = await droppedRefund(w);
  w.paypal.resendError = new PaypalError("resend event", 404, "dbg", { name: "RESOURCE_NOT_FOUND" });
  const out = await ringAgain(w.deps(), sid, session, captureId);
  assert.deepEqual(out, { sent: false, ring: { state: "not_listed", label: "Cannot auto-heal: PayPal refused the resend (HTTP 404)" } });
  assert.deepEqual(await w.store.heals(sid), { resends: 0, records: {} });
  w.paypal.resendError = undefined;
  assert.equal((await ringAgain(w.deps(), sid, session, captureId)).sent, true, "the lock was released too");
});

test("the pool limit on real resends (beforeSend) is asked only when a resend is about to go to PayPal: not for presses refused earlier, once for a resend", async () => {
  const w = gapWorld();
  const { sid, captureId } = await droppedRefund(w);
  let asked = 0;
  const count = async () => void asked++;
  // refused before any send: the person's own session is at its cap of 5, or nothing is ready
  const tied = await w.order(sid, { book: "paid" });
  assert.equal((await ringAgain(w.deps(), sid, session, tied.captureId, { beforeSend: count })).sent, false, "a row that is tied has nothing to resend");
  assert.equal(asked, 0, "a press on a tied row is not counted against the resend pool");
  assert.equal((await ringAgain(w.deps(), sid, session, captureId, { beforeSend: count })).sent, true);
  assert.equal(asked, 1, "a real resend is counted once");
  assert.equal((await ringAgain(w.deps(), sid, session, captureId, { beforeSend: count })).sent, false, "a second press while the resend is in flight");
  assert.equal(asked, 1, "and is not counted again");
});

test("when the pool says no, nothing is sent and the session's count and lock are given back", async () => {
  const w = gapWorld();
  const { sid, captureId } = await droppedRefund(w);
  const stop = async () => {
    throw new HttpError(429, "Limit reached for this hour. Try again in 40 min.", {}, 2400);
  };
  await assert.rejects(ringAgain(w.deps(), sid, session, captureId, { beforeSend: stop }), (e: unknown) => e instanceof HttpError && e.status === 429);
  assert.equal(w.paypal.resends.length, 0, "PayPal was not asked");
  assert.deepEqual(await w.store.heals(sid), { resends: 0, records: {} });
  assert.equal((await ringAgain(w.deps(), sid, session, captureId)).sent, true, "the lock was released: the next press can send");
});

test("a press that the session's own five resends refuse is not counted against the pool", async () => {
  const w = gapWorld();
  const sid = await w.session("ack_then_drop");
  const made = [];
  for (let i = 0; i < 6; i++) {
    const o = await w.order(sid, { refund: true, book: "paid", eventsListed: true });
    await w.heard({ eid: o.refundEid, tid: `tid-${i}`, type: REFUNDED, resourceId: o.refundId, at: o.refundAt + 12_000 });
    await w.deliver({ eid: o.refundEid, tid: `tid-${i}`, type: REFUNDED, resourceId: o.refundId, status: 200, at: o.refundAt + 12_000 });
    made.push(o);
  }
  w.clock.now += 60_000;
  let asked = 0;
  for (const o of made) await ringAgain(w.deps(), sid, session, o.captureId, { beforeSend: async () => void asked++ });
  assert.equal(asked, 5, "6 presses, 5 resends: the sixth was refused by the session cap before the pool was asked");
});

test("A5: the scan follows a resend: arrival is timed, the books are read again, and TIED comes only after they changed", async () => {
  const w = gapWorld();
  const { sid, captureId, refundId, refundEid } = await droppedRefund(w);
  assert.equal((await ringAgain(w.deps(), sid, session, captureId)).sent, true);
  const sentAt = w.clock.now;

  w.clock.now = sentAt + 5_000;
  let scan = await scanSession(w.deps(), sid, session);
  assert.deepEqual([scan.rows[0].status, scan.rows[0].events[1].heal?.state, scan.rows[0].events[1].ring?.state], ["GAP", "sent", "in_progress"]);

  // The resent delivery arrives 12 s after the 202 and is answered 200 -- but the shop still drops it: the books do not change.
  await w.deliver({ eid: refundEid, tid: "tid-resend", type: REFUNDED, resourceId: refundId, status: 200, at: sentAt + 12_000 });
  w.clock.now = sentAt + 30_000;
  scan = await scanSession(w.deps(), sid, session);
  const ev = scan.rows[0].events[1];
  assert.deepEqual([scan.rows[0].status, ev.heal?.state, ev.heal?.arrivalSeconds, ev.heal?.answer], ["GAP", "unchanged", 12, 200]);
  assert.equal(ev.ring?.state, "ready", "it can be rung again once the fix is out");

  // The fix is deployed; the next resend lands and the books change.
  assert.equal((await ringAgain(w.deps(), sid, session, captureId)).sent, true);
  const second = w.clock.now;
  await w.deliver({ eid: refundEid, tid: "tid-resend-2", type: REFUNDED, resourceId: refundId, status: 200, at: second + 9_000 });
  await w.book(sid, captureId, { state: "refunded", amount: "48.00", eid: refundEid, at: second + 9_100 });
  w.clock.now = second + 20_000;
  scan = await scanSession(w.deps(), sid, session);
  assert.deepEqual([scan.rows[0].status, scan.rows[0].events[1].heal?.state, scan.rows[0].events[1].heal?.arrivalSeconds], ["TIED", "healed", 9]);
});

test("the timeline fields: listedAt is PayPal's create_time of a listed event (absent when it is not listed); heal.sentAt has the time of each resend and heal.arrivedAt the first resent delivery", async () => {
  const w = gapWorld();
  const { sid, captureId, refundId, refundEid, paidEid, at } = await droppedRefund(w);
  let scan = await scanSession(w.deps(), sid, session);
  let [paid, refund] = scan.rows[0].events;
  assert.equal(paid.listedAt, at + 5_000, "PayPal's own time for the payment event, from its list");
  assert.equal(refund.listedAt, at + 6_000, "and for the refund event");
  assert.equal(paid.eid, paidEid);
  assert.equal(refund.heal, null, "no resend yet: no heal fields");

  assert.equal((await ringAgain(w.deps(), sid, session, captureId)).sent, true);
  const sent = w.clock.now;
  w.clock.now = sent + 4_000;
  scan = await scanSession(w.deps(), sid, session);
  [paid, refund] = scan.rows[0].events;
  assert.deepEqual(refund.heal?.sentAt, [sent], "the 202 was at this time");
  assert.equal(refund.heal?.sends, 1);
  assert.equal(refund.heal?.arrivedAt, undefined, "nothing arrived yet: the field is absent, not a guess");

  await w.deliver({ eid: refundEid, tid: "tid-resend", type: REFUNDED, resourceId: refundId, status: 200, at: sent + 7_000 });
  w.clock.now = sent + 20_000;
  scan = await scanSession(w.deps(), sid, session);
  refund = scan.rows[0].events[1];
  assert.deepEqual([refund.heal?.sentAt, refund.heal?.arrivedAt, refund.heal?.arrivalSeconds], [[sent], sent + 7_000, 7]);

  // An event that PayPal's list does not (yet) show has no listedAt.
  const w2 = gapWorld();
  const unlisted = await droppedRefund(w2, { listed: false });
  const s2 = await scanSession(w2.deps(), unlisted.sid, session);
  for (const e of s2.rows[0].events) assert.deepEqual([e.listed, e.listedAt], [false, undefined]);
});

test("A5: a resend that was accepted and never arrives is sent again after 60 s, twice at most, and then reported lost", async () => {
  const w = gapWorld();
  const { sid, captureId } = await droppedRefund(w);
  assert.equal((await ringAgain(w.deps(), sid, session, captureId)).sent, true);
  const states: string[] = [];
  for (let i = 0; i < 6; i++) {
    w.clock.now += 61_000;
    const scan = await scanSession(w.deps(), sid, session);
    states.push(`${scan.rows[0].events[1].heal?.state}/${scan.rows[0].events[1].heal?.sends}`);
  }
  assert.deepEqual(states, ["sent/2", "sent/3", "lost/3", "lost/3", "lost/3", "lost/3"]);
  assert.equal(w.paypal.resends.length, 3, "the first resend and two retries");
  assert.equal((await w.store.heals(sid)).resends, 3);
});

test("A5: a retry is not sent when the event has dropped out of the list", async () => {
  const w = gapWorld();
  const { sid, captureId } = await droppedRefund(w);
  await ringAgain(w.deps(), sid, session, captureId);
  w.paypal.listed.length = 0;
  w.clock.now += 61_000;
  const scan = await scanSession(w.deps(), sid, session);
  assert.equal(scan.rows[0].events[1].heal?.state, "lost");
  assert.equal(w.paypal.resends.length, 1);
});
