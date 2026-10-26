// How fast the live lane polls (S6, A13 item 9). The pace follows what the newest snapshot waits for (lib/ui/live.ts paceOf), and "nothing changed" must mean
// that: a snapshot of a quiet session is the same key at every poll, whatever the clock, the countdown of a wait, the heartbeat's "12 s ago" or the witness
// quarantine's re-check on the server say. If the key moved on its own, the back-off would never get past 20 s.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ROOT } from "../cause/test-helpers.ts";
import { gapWorld } from "../gaps/test-world.ts";
import { buildLiveSnapshot } from "../run/build.ts";
import { DISPUTE_SCENARIO } from "../run/recorded.ts";
import type { RunSnapshot } from "../run/snapshot.ts";
import { computeDiffs } from "../shop/diffs.ts";
import { COMPLETED } from "../shop/events.ts";
import { emptyLive, paceOf, snapshotKey } from "./live.ts";
import { disputeSeed } from "./live-seeds.ts";
import { SCENARIOS } from "./source.ts";

const A = SCENARIOS[0].steps; // the dropped refund: incident, fix, ring in progress, end
const live = (i: number): RunSnapshot => ({ ...structuredClone(A[i]), mode: "LIVE", recordedAt: null, step: null });
const openEvents = (s: RunSnapshot) => s.scan!.rows.filter((r) => r.status !== "TIED").flatMap((r) => r.events.filter((e) => e.finding));
const ringAs = (s: RunSnapshot, state: "ready" | "not_listed" | "retries_pending" | "in_progress" | "cannot_heal" | "cap_reached"): RunSnapshot => {
  const out = structuredClone(s);
  for (const e of openEvents(out)) e.ring = { state, label: "x" };
  return out;
};

test("a snapshot with nothing to wait for is idle: no scan, a closed run, a gap that is ready to ring, one that is out of resends, a dispute with no ring", () => {
  assert.equal(paceOf(emptyLive("x")), "idle");
  assert.equal(paceOf(live(3)), "idle", "the end of the run: every row is tied");
  assert.equal(paceOf(ringAs(live(0), "ready")), "idle", "the judge's turn, not PayPal's");
  assert.equal(paceOf(ringAs(live(0), "cap_reached")), "idle");
  assert.equal(paceOf(ringAs(live(0), "cannot_heal")), "idle");
  assert.equal(paceOf(disputeSeed().snap!), "idle");
});

test("a snapshot that waits for PayPal's own clock is waiting: its event list, its own retries, a row too new to call, a dispute not provable yet", () => {
  assert.equal(paceOf(ringAs(live(0), "not_listed")), "waiting");
  assert.equal(paceOf(ringAs(live(0), "retries_pending")), "waiting");
  assert.equal(paceOf(ringAs(live(0), "in_progress")), "waiting");
  const settling = structuredClone(live(0));
  const row = settling.scan!.rows.find((r) => r.status !== "TIED")!;
  row.status = "UNVERIFIED";
  row.waiting = "settling";
  for (const e of row.events) e.finding = null;
  assert.equal(paceOf(ringAs(settling, "ready")), "waiting", "the books are given 10 s: look again soon");
  // a row that stays unverified for good is not a wait
  row.waiting = "status_not_modeled";
  assert.equal(paceOf(ringAs(settling, "ready")), "idle");
  const dispute = structuredClone(disputeSeed().snap!);
  dispute.scan!.rows.find((r) => (r.disputes ?? []).length > 0)!.disputes![0].ring = { state: "wait", label: "Not provable yet", waitMs: 60_000 };
  assert.equal(paceOf(dispute), "waiting");
});

test("a row that is moving (a finding not final, a resend on its way) is the fast pace, and it outranks a wait", () => {
  assert.equal(paceOf(live(2)), "moving");
  const both = ringAs(live(2), "not_listed");
  assert.equal(paceOf(both), "moving");
});

// ---- the key of a snapshot --------------------------------------------------------------------------------------------------------------------------

test("what changes by itself is not a change: the times, a wait's countdown, the heartbeat's age and the witness re-check", () => {
  const a = ringAs(live(0), "retries_pending");
  for (const e of openEvents(a)) e.ring = { state: "retries_pending", label: "x", waitMs: 57_000 };
  a.heartbeat = { lastDeliveryAt: 1_000, listedMissedByWitness: 0, state: "ok", text: "Witness: last delivery 12 s ago · events list shows 0 the witness missed" };
  (a.scan as { reverify: unknown }).reverify = { checked: 0, verified: 0 };
  const b = structuredClone(a);
  b.session.now += 20_000;
  b.scan!.at += 20_000;
  b.scan!.durationMs += 9;
  b.certificate!.scopeAt += 20_000;
  for (const e of openEvents(b)) e.ring = { state: "retries_pending", label: "x", waitMs: 37_000 };
  b.heartbeat = { ...a.heartbeat, lastDeliveryAt: 1_000, text: "Witness: last delivery 32 s ago · events list shows 0 the witness missed" };
  (b.scan as { reverify: unknown }).reverify = { skipped: "ran less than 30 s ago on this instance" };
  assert.equal(snapshotKey(a), snapshotKey(b));
});

test("what the screen shows is still a change: a ring state, the heartbeat's state, a count, a row", () => {
  const a = ringAs(live(0), "not_listed");
  a.heartbeat = { lastDeliveryAt: 1_000, listedMissedByWitness: 0, state: "ok", text: "Witness: last delivery 12 s ago · events list shows 0 the witness missed" };
  const changed = (edit: (s: RunSnapshot) => void): string => {
    const b = structuredClone(a);
    edit(b);
    return snapshotKey(b);
  };
  assert.notEqual(snapshotKey(a), changed((s) => { for (const e of openEvents(s)) e.ring = { state: "ready", label: "Ring again" }; }), "the event got listed");
  assert.notEqual(snapshotKey(a), changed((s) => { s.heartbeat!.state = "silent"; }), "the witness went quiet");
  assert.notEqual(snapshotKey(a), changed((s) => { s.heartbeat!.listedMissedByWitness = 1; }), "the list shows an event the witness missed");
  assert.notEqual(snapshotKey(a), changed((s) => { s.scan!.rows[0].status = "UNVERIFIED"; }), "a row changed");
  assert.notEqual(snapshotKey(a), changed((s) => { s.session.orders.pop(); }), "an order is gone");
});

test("two real polls of a quiet session, 20 s apart, on a server whose re-check runs every other time, are the same key", async () => {
  const w = gapWorld({});
  const sid = await w.session("ack_then_drop");
  const rows = [];
  for (let i = 0; i < 2; i++) rows.push(await w.order(sid, { refund: true, book: "paid", eventsListed: true }));
  w.clock.now += 7 * 60_000; // past the books' 45 s and the 6 minutes of an absence claim: what is left to change is only what changes by itself
  for (const [i, row] of rows.entries()) {
    await w.heard({ eid: row.paidEid, tid: `quiet-p${i}`, type: COMPLETED, resourceId: row.captureId, at: w.clock.now - 10_000 }); // a delivery 10 s ago: the heartbeat counts its age in seconds
    await w.deliver({ eid: row.paidEid, tid: `quiet-p${i}`, type: COMPLETED, resourceId: row.captureId, status: 200, at: w.clock.now - 10_000 });
  }
  const bundle = computeDiffs(ROOT);
  let calls = 0;
  const poll = async (): Promise<RunSnapshot> => buildLiveSnapshot({ scan: { ...w.deps(), reverify: async () => (calls++ % 2 === 0 ? { checked: 0, verified: 0 } : { skipped: "ran less than 30 s ago on this instance" }) }, bundle, recordedReplays: {}, log: () => undefined }, sid, (await w.store.getSession(sid))!);
  const first = await poll();
  w.clock.now += 20_000;
  const second = await poll();
  assert.notDeepEqual(first.scan!.reverify, second.scan!.reverify, "the server said something different the second time");
  assert.notEqual(first.heartbeat?.text, second.heartbeat?.text, "and the heartbeat counted 20 s more");
  assert.notEqual(first.scan!.at, second.scan!.at);
  assert.equal(snapshotKey(first), snapshotKey(second));
});

test("a finding that counts its own wait down (an absence claim waits 6 minutes) is the same key from one poll to the next", async () => {
  const w = gapWorld({});
  const sid = await w.session("ack_then_drop");
  await w.order(sid, { refund: true, book: "paid", eventsListed: true });
  w.clock.now += 60_000; // inside the absence window: the refund event is not reported yet
  const bundle = computeDiffs(ROOT);
  const poll = async (): Promise<RunSnapshot> => buildLiveSnapshot({ scan: w.deps(), bundle, recordedReplays: {}, log: () => undefined }, sid, (await w.store.getSession(sid))!);
  const first = await poll();
  w.clock.now += 20_000;
  const second = await poll();
  const whys = (s: RunSnapshot) => s.scan!.rows.flatMap((r) => r.events.map((e) => e.finding?.why ?? ""));
  assert.notDeepEqual(whys(first), whys(second), "the sentence counted 20 s down");
  assert.equal(snapshotKey(first), snapshotKey(second));
});

test("the recorded dispute run is idle at its last step too: nothing is awaited once the ring has said it has nothing to send", () => {
  assert.equal(paceOf({ ...structuredClone(DISPUTE_SCENARIO.steps[3]), mode: "LIVE", recordedAt: null, step: null }), "idle");
});
