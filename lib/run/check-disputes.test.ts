// The live snapshot with a dispute in it, and the rules a snapshot with disputes must obey (check-disputes.ts). PayPal is the gap finder's stand-in.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "../cause/test-helpers.ts";
import type { RecordedReplays } from "../cause/replay.ts";
import { DISPUTE_CREATED } from "../gaps/disputes.ts";
import { gapWorld } from "../gaps/test-world.ts";
import { computeDiffs } from "../shop/diffs.ts";
import { checkSnapshot } from "../ui/check.ts";
import { buildLiveSnapshot } from "./build.ts";
import { checkDisputeScenario, disputeViolations } from "./check-disputes.ts";
import type { RecordedDisputeScenario, RunSnapshot } from "./snapshot.ts";

const BUNDLE = computeDiffs(ROOT);
const RECORDED = JSON.parse(readFileSync(join(ROOT, "fixtures/replay/recorded.json"), "utf8")) as RecordedReplays;
type World = ReturnType<typeof gapWorld>;

async function snapshotOf(w: World, sid: string, mode: "good" | "ack_then_drop" = "good"): Promise<RunSnapshot> {
  const session = (await w.store.getSession(sid))!;
  return buildLiveSnapshot({ scan: w.deps({ disputes: { reads: w.disputeReads } }), bundle: BUNDLE, recordedReplays: RECORDED, log: () => undefined }, sid, { ...session, mode });
}

// The rule of checkSnapshot that "a gap row has a final finding on one of its events" does not know disputes: it is the one violation a dispute-only
// gap row gets from lib/ui/check.ts until that rule is taught about ScanRow.disputes (disputeViolations holds the dispute-aware form of it).
const knownGap = (v: string) => / is a gap without a final finding$/.test(v);

async function disputed(over: { webhooks?: string[]; pending?: boolean; due?: boolean } = {}) {
  const w = gapWorld();
  const sid = await w.session();
  const orders = [await w.order(sid, { book: "paid", eventsListed: true }), await w.order(sid, { book: "paid", eventsListed: true }), await w.order(sid, { book: "paid", eventsListed: true })];
  w.clock.now += 5 * 60_000;
  w.dispute(orders[0].captureId, { ageMs: 4 * 60_000, due: over.due ?? true, status: over.due === false ? "UNDER_REVIEW" : "WAITING_FOR_SELLER_RESPONSE", pending: over.pending ?? true });
  return { w, sid, orders };
}

test("the live snapshot of a session with a dispute: the scan has the dispute on its row, the certificate counts it, no cause is invented, and every dispute rule holds", async () => {
  const { w, sid, orders } = await disputed();
  const snap = await snapshotOf(w, sid);
  const row = snap.scan!.rows.find((r) => r.captureId === orders[0].captureId)!;
  assert.deepEqual([row.status, row.paypalStatus, row.truth, row.disputes?.length], ["GAP", "PENDING", null, 1]);
  assert.equal(snap.certificate!.stamp, "red");
  assert.equal(snap.certificate!.numbers.disputes?.notInBooks, 1);
  assert.deepEqual(snap.causes, [], "a dispute has no code to blame");
  assert.deepEqual(disputeViolations(snap), []);
  assert.deepEqual(checkSnapshot(snap).filter((v) => !knownGap(v)), [], "and nothing else checkSnapshot knows is violated");
  assert.equal(snap.heartbeat?.listedMissedByWitness, 3, "the heartbeat counts the payment events only: the three listed ones the (absent) witness never heard, and nothing for the dispute");
});

test("a dispute in a session whose shop has a planted bug gets no cause either; the rows that do have an event gap keep theirs", async () => {
  const { w, sid } = await disputed();
  const snap = await snapshotOf(w, sid, "ack_then_drop");
  assert.deepEqual(snap.causes, []);
  assert.deepEqual(disputeViolations(snap), []);
});

test("a session that looked for disputes and found none passes the rules, with zeros in the certificate", async () => {
  const w = gapWorld();
  const sid = await w.session();
  await w.order(sid, { book: "paid" });
  const snap = await snapshotOf(w, sid);
  assert.deepEqual(disputeViolations(snap), []);
  assert.equal(snap.certificate!.numbers.disputes?.open, 0);
});

test("a snapshot from before disputes existed passes the rules, and a certificate that has dispute numbers without a scan that looked is refused", async () => {
  const w = gapWorld();
  const sid = await w.session();
  await w.order(sid, { book: "paid" });
  const session = (await w.store.getSession(sid))!;
  const plain = await buildLiveSnapshot({ scan: w.deps(), bundle: BUNDLE, recordedReplays: RECORDED, log: () => undefined }, sid, session);
  assert.deepEqual(disputeViolations(plain), []);
  const forged = structuredClone(plain);
  forged.certificate!.numbers.disputes = { open: 0, notInBooks: 0, unverified: 0, unsubscribed: 0, noWebhook: 0, moneyNotInBooks: "0.00", unreadable: 0 };
  assert.deepEqual(disputeViolations(forged), ["the certificate has dispute numbers but the scan did not look for disputes"]);
});

// ---- each rule, broken on purpose ----
async function broken(mutate: (s: RunSnapshot) => void): Promise<string[]> {
  const { w, sid } = await disputed();
  const snap = await snapshotOf(w, sid);
  const copy = structuredClone(snap);
  mutate(copy);
  return disputeViolations(copy);
}
const dispute = (s: RunSnapshot) => s.scan!.rows.find((r) => r.disputes)!.disputes![0];
const drow = (s: RunSnapshot) => s.scan!.rows.find((r) => r.disputes)!;

test("rule: a dispute is never rung again", async () => {
  assert.ok((await broken((s) => (dispute(s).ring = { state: "ready", label: "Ring again" }))).some((v) => /can be rung again/.test(v)));
});

test("rule: a TIED dispute has no finding and no ring; a GAP one has a final finding and a ring; an unverified one does not carry a final finding", async () => {
  assert.ok((await broken((s) => (dispute(s).status = "TIED"))).some((v) => /is TIED but has a finding or a ring/.test(v)));
  assert.ok((await broken((s) => (dispute(s).finding = null))).some((v) => /is GAP but has no finding or no ring/.test(v)));
  assert.ok((await broken((s) => (dispute(s).finding!.final = false))).some((v) => /gap without a final finding/.test(v)));
  assert.ok((await broken((s) => (dispute(s).status = "UNVERIFIED"))).some((v) => /unverified but carries a final finding/.test(v)));
});

test("rule: the row follows its disputes: a gap dispute makes a GAP row, an unverified one is not TIED, and a gap row is justified by an event or a dispute", async () => {
  assert.ok((await broken((s) => (drow(s).status = "TIED"))).some((v) => /holds a gap dispute but is TIED/.test(v)));
  assert.ok((await broken((s) => (drow(s).status = "UNVERIFIED"))).some((v) => /holds a gap dispute but is UNVERIFIED/.test(v)));
  assert.ok((await broken((s) => (drow(s).disputes = []))).some((v) => /is a gap without a final finding or a gap dispute/.test(v)));
});

test("rule: the flag 'not subscribed' needs the shop's webhook to be seen as not subscribed", async () => {
  assert.ok((await broken((s) => (dispute(s).webhooks = { shop: true, any: true }))).some((v) => /not subscribed, but its subscription is true/.test(v)));
  assert.ok((await broken((s) => (dispute(s).webhooks = { shop: null, any: null }))).some((v) => /subscription is null/.test(v)));
});

test("rule: the due date and where it comes from agree; the id and the amount are what PayPal's are", async () => {
  assert.ok((await broken((s) => (dispute(s).dueDateSource = "not_set_yet"))).some((v) => /due date and where it comes from disagree/.test(v)));
  assert.ok((await broken((s) => (dispute(s).sellerResponseDueAt = null))).some((v) => /due date and where it comes from disagree/.test(v)));
  assert.ok((await broken((s) => (dispute(s).disputeId = "../x"))).some((v) => /not a dispute id/.test(v)));
  assert.ok((await broken((s) => (dispute(s).amount = "48"))).some((v) => /not money/.test(v)));
});

test("rule: a cause may not be attached to a row that is a gap only because of a dispute", async () => {
  const bad = await broken((s) => {
    s.causes = [{ captureId: drow(s).captureId, mode: "ack_then_drop", cause: { status: "not_diagnosed", reason: "timeout" } as never, replay: null, confirmation: null }];
  });
  assert.ok(bad.some((v) => /a dispute has no code to blame/.test(v)));
});

test("rule: the certificate's dispute numbers are the rows' numbers, and it says what the scan could not show", async () => {
  assert.ok((await broken((s) => (s.certificate!.numbers.disputes!.notInBooks = 0))).some((v) => /disputes\.notInBooks is 0 but the rows say 1/.test(v)));
  assert.ok((await broken((s) => (s.certificate!.numbers.disputes!.moneyNotInBooks = "47.00"))).some((v) => /moneyNotInBooks is 47\.00 but the rows say 48\.00/.test(v)));
  assert.ok((await broken((s) => (s.certificate!.numbers.disputes!.unsubscribed = 0))).some((v) => /unsubscribed is 0 but the rows say 1/.test(v)));
  assert.ok((await broken((s) => (s.certificate!.limits = s.certificate!.limits.filter((l) => !/no webhook of this app/.test(l))))).some((v) => /does not say that whether PayPal made an event cannot be proven/.test(v)));
  assert.ok((await broken((s) => (s.certificate!.limits = s.certificate!.limits.filter((l) => !/response-due date/.test(l))))).some((v) => /where its due date comes from/.test(v)));
  assert.ok((await broken((s) => (s.certificate!.numbers.disputes = undefined))).some((v) => /no dispute numbers/.test(v)));
  assert.ok((await broken((s) => (s.scan!.disputeReads = { asked: 3, unreadable: 2 }))).some((v) => /disputes\.unreadable is 0 but the rows say 2/.test(v)));
});

test("rule: unread dispute lists are said in the certificate", async () => {
  const w = gapWorld();
  const sid = await w.session();
  const o = await w.order(sid, { book: "paid" });
  w.paypal.disputeFailing.add(o.captureId);
  const snap = await snapshotOf(w, sid);
  assert.deepEqual(disputeViolations(snap), []);
  const hidden = structuredClone(snap);
  hidden.certificate!.limits = [];
  assert.deepEqual(disputeViolations(hidden), ["some dispute lists were not read and the certificate does not say so"]);
});

test("a subscribed shop's unproven dispute passes the rules too (an unverified dispute makes an unverified row)", async () => {
  const w = gapWorld();
  const sid = await w.session();
  const o = await w.order(sid, { book: "paid", eventsListed: true });
  w.paypal.webhooks[0].types.push(DISPUTE_CREATED);
  w.clock.now += 20 * 60_000;
  const d = w.dispute(o.captureId, { ageMs: 5 * 60_000, due: true });
  w.paypal.disputeEvents.push({ eid: "WH-4NY37331K6294023J-5X2155257W973735X", disputeId: d.disputeId, createTime: w.clock.now - 60_000 });
  const snap = await snapshotOf(w, sid);
  assert.equal(snap.scan!.rows[0].status, "UNVERIFIED");
  assert.deepEqual(disputeViolations(snap), []);
  assert.deepEqual(checkSnapshot(snap), []);
});

test("a recorded dispute run: steps are counted and every step obeys the dispute rules", async () => {
  const { w, sid } = await disputed();
  const step = await snapshotOf(w, sid);
  const sc: RecordedDisputeScenario = { id: "dispute_never_heard", title: "t", plantedMode: "none", capturedAt: 1, steps: [{ ...step, mode: "RECORDED RUN", recordedAt: 1, step: { index: 1, of: 1, title: "x" } }], paypalIds: [] };
  assert.deepEqual(checkDisputeScenario(sc), []);
  assert.ok(checkDisputeScenario({ ...sc, steps: [] }).some((v) => /no steps/.test(v)));
  assert.ok(checkDisputeScenario({ ...sc, steps: [{ ...sc.steps[0], step: { index: 2, of: 1, title: "x" } }] }).some((v) => /wrong step counter/.test(v)));
  assert.ok(checkDisputeScenario({ ...sc, steps: [{ ...sc.steps[0], mode: "LIVE" }] }).some((v) => /step 1 is LIVE/.test(v)));
});
