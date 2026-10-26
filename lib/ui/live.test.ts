// The live lane's client logic: how a failed call is read (a missing route falls back to the recorded run), the snapshot shape check, the
// polling rhythm, the five steps of the lane read from a snapshot, and how a live session's snapshots become the path panel.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { RingState } from "../gaps/classify.ts";
import type { ScanEvent } from "../gaps/scan.ts";
import type { RunSnapshot } from "../run/snapshot.ts";
import { emptyLive, failureNote, failureOf, hasOpenRow, isRunSnapshot, liveChapter, liveHeaders, livePanel, liveRing, liveSteps, networkFailure, noteText, NOT_RUNG, pollDelayMs, remember, rememberFixed, ringReadiness, ringRefusal, snapshotKey, type LiveSeed, type Pending } from "./live.ts";
import { selfHealedSeed } from "./live-seeds.ts";
import { richText } from "./rich.ts";
import { SCENARIOS } from "./source.ts";
import { buildPanel, markOf, PHASES, tokensOf, type Panel, type Phase } from "./story.ts";

const A = SCENARIOS[0].steps; // the dropped refund: incident, fix, ring in progress, end
const live = (i: number) => ({ ...structuredClone(A[i]), mode: "LIVE" as const, recordedAt: null, step: null });

test("a missing snapshot route is 'unavailable', so the lane falls back to the recorded run", () => {
  assert.equal(failureOf(404).kind, "unavailable");
  assert.equal(failureOf(405).kind, "unavailable");
});

test("a spent or closed pool is 'paused'", () => {
  assert.equal(failureOf(429).kind, "paused");
  assert.equal(failureOf(503).kind, "paused");
});

test("a bad token, a dead session and any other error are told apart", () => {
  assert.equal(failureOf(401).kind, "token");
  assert.equal(failureOf(403).kind, "session");
  assert.equal(failureOf(410).kind, "session");
  assert.equal(failureOf(500).kind, "error");
  assert.equal(failureOf(500, "Something went wrong.").message, "Something went wrong.");
  assert.equal(failureOf(502).message, "HTTP 502");
});

test("only a RunSnapshot is accepted as one", () => {
  assert.equal(isRunSnapshot(SCENARIOS[0].steps[0]), true);
  assert.equal(isRunSnapshot(emptyLive("x")), true);
  assert.equal(isRunSnapshot({ error: { message: "no" } }), false);
  assert.equal(isRunSnapshot("<html>404</html>"), false);
  assert.equal(isRunSnapshot(null), false);
  assert.equal(isRunSnapshot({ mode: "LIVE" }), false);
});

test("requests carry the token and the session, and a body only when there is one", () => {
  assert.deepEqual(liveHeaders("t", "s", true), { "x-live-token": "t", "x-session": "s", "content-type": "application/json" });
  assert.deepEqual(liveHeaders("t", "", false), { "x-live-token": "t" });
});

test("polling is fast while a row is moving, steady while PayPal's clock is awaited, and backs off to 5 minutes when nothing is (lib/ui/live-pace.test.ts holds the rest)", () => {
  assert.deepEqual([0, 1, 2, 5].map((n) => pollDelayMs(n, "moving")), [3000, 6000, 12000, 12000]);
  assert.deepEqual([0, 1, 2, 5].map((n) => pollDelayMs(n, "waiting")), [5000, 10000, 20000, 20000]);
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 9].map((n) => pollDelayMs(n, "idle")), [5000, 10000, 20000, 40000, 80000, 160000, 300000, 300000]);
  assert.ok(pollDelayMs(0, "idle") > pollDelayMs(0, "moving"));
});

test("the five steps: a session, an order, a bug that has been on, a refund, a scan of the refund", () => {
  const none = { hasSession: false, everPlanted: false };
  assert.deepEqual(liveSteps(emptyLive(""), none), ["current", "todo", "todo", "todo", "todo"]);
  assert.deepEqual(liveSteps(emptyLive("x"), { ...none, hasSession: true }), ["done", "current", "todo", "todo", "todo"]);
  const afterOrder = live(0);
  afterOrder.scan = null;
  afterOrder.session.session.planted = false;
  afterOrder.session.orders.forEach((o) => (o.refundAt = null));
  assert.deepEqual(liveSteps(afterOrder, { hasSession: true, everPlanted: false }), ["done", "done", "current", "todo", "todo"]);
  afterOrder.session.session.planted = true;
  assert.deepEqual(liveSteps(afterOrder, { hasSession: true, everPlanted: false }), ["done", "done", "done", "current", "todo"]);
  const refunded = live(0);
  refunded.scan = null;
  assert.deepEqual(liveSteps(refunded, { hasSession: true, everPlanted: true }), ["done", "done", "done", "done", "current"]);
  assert.deepEqual(liveSteps(live(0), { hasSession: true, everPlanted: true }), ["done", "done", "done", "done", "done"]);
  // the bug can be off again (that is the fix) and step 3 stays done
  assert.deepEqual(liveSteps(live(1), { hasSession: true, everPlanted: true }), ["done", "done", "done", "done", "done"]);
});

test("the lane remembers the last snapshot that carried a cause, because the cause goes when the bug is turned off", () => {
  const diagnosed = live(0);
  assert.equal(remember(null, diagnosed), diagnosed);
  assert.equal(remember(diagnosed, live(1)), diagnosed, "the fixed snapshot has no cause: the diagnosis stays");
  assert.equal(remember(null, live(1)), null);
  // a cause that is not proven (the setting bug always ends so) is a diagnosis as well: it is kept, and the fix after it is a chapter
  const unproven = live(0);
  unproven.causes = unproven.causes.map((c) => ({ captureId: c.captureId, mode: c.mode, cause: { promptVersion: "x", requestHash: "h", status: "not_proven" as const, reason: "model_abstained" as const, text: "Cause not proven." as const }, replay: null, confirmation: null }));
  assert.equal(remember(null, unproven), unproven);
  assert.equal(remember(unproven, live(1)), unproven);
  const fixed = live(1);
  assert.equal(rememberFixed(null, unproven, fixed), fixed);
  assert.equal(livePanel(fixed, unproven, fixed).panel.available[5], true);
  // a switch from one bug straight to another: the old gaps are diagnosed again under the new mode and come back without a proposed cause.
  // That answer is about a mode that did not make them, so it never replaces the diagnosis made under the mode that did
  const switched = live(0);
  switched.session.session.mode = diagnosed.session.session.mode === "bad_body" ? "wrong_webhook_id_setting" : "bad_body";
  switched.causes = unproven.causes;
  assert.equal(remember(diagnosed, switched), diagnosed);
  const sameMode = live(0);
  sameMode.causes = unproven.causes;
  assert.equal(remember(unproven, sameMode), sameMode, "under the same mode the newer answer is kept");
});

test("a live snapshot becomes the same panel as a recorded one, and says it is live", () => {
  const diag = live(0);
  const { panel } = livePanel(diag, diag, null);
  assert.equal(panel.mode, "live");
  assert.equal(panel.subject!.n, 2);
  assert.equal(panel.stations[2].layers.find((l) => l.code)!.code!.lines.length, 2);
  assert.equal(panel.available[3], true);
  assert.equal(panel.available[5], false, "the bug is still on: no fix yet");
  assert.equal(liveChapter(panel, diag), 2);
  // the bug is off: the diagnosis is kept, the fix is a chapter of its own
  const fixed = live(1);
  const after = livePanel(fixed, diag, fixed).panel;
  assert.equal(after.available[5], true);
  assert.equal(after.fixedFile, "handlers/good.ts");
  assert.equal(liveChapter(after, fixed), 5);
  // before any scan there is nothing to trace
  const empty = livePanel(emptyLive("x"), null, null).panel;
  assert.equal(empty.subject, null);
  assert.equal(liveChapter(empty, emptyLive("x")), 1);
  assert.ok(empty.stations.every((s) => s.marks["1"] === "ghost"));
});

test("the moment of the fix is the first snapshot after the bug went off, and Ring again counts from it", () => {
  const diag = live(0);
  assert.equal(rememberFixed(null, diag, diag), null, "the bug is still on");
  const first = live(1);
  assert.equal(rememberFixed(null, diag, first), first);
  assert.equal(rememberFixed(first, diag, live(3)), first, "later snapshots do not move it");
  assert.equal(rememberFixed(null, null, live(1)), null, "no diagnosis, no fix to speak of");
  // with the fix remembered, the shop line of the ring has the real arrival time of the heal record
  const panel = livePanel(live(3), diag, first).panel;
  const shop = panel.stations[2].layers.find((l) => l.on.includes("6"))!;
  // order #2's third resend (the first two were accepted and did not arrive) reached the shop 2.2 s after it was accepted
  assert.match(shop.variants[1].lines[0].rich.map((r) => r.pieces.join("")).join(""), /2\.2 s after the ask/);
});

test("Ring again is read from the heal records, never scripted: sent is waiting, healed is tied, lost is open", () => {
  const diag = live(0);
  assert.equal(liveRing(diag, 2).stage, "idle");
  const mid = live(2); // the 10-20 recording's third step: a resend was accepted for each row and neither has arrived yet
  const r = liveRing(mid, 2);
  assert.equal(r.stage, "running");
  assert.equal(r.rows[2].state, "wait");
  assert.equal(r.rows[3].state, "wait");
  assert.equal(r.rows[2].note, "Resend accepted, waiting for it to arrive.");
  assert.equal(r.phase, "sent");
  assert.equal(liveChapter(livePanel(mid, diag, live(1)).panel, mid), 6);
  // between the third and the fourth step, from the heal records of those two: order #3's resend has arrived and healed it, order #2's is still on its way
  const split = live(3);
  const sent2 = live(2).scan!.rows.find((x) => x.n === 2)!;
  split.scan!.rows.find((x) => x.n === 2)!.events = sent2.events;
  split.scan!.rows.find((x) => x.n === 2)!.status = sent2.status;
  const part = liveRing(split, 2);
  assert.equal(part.stage, "running");
  assert.equal(part.rows[3].state, "tied");
  assert.equal(part.rows[2].state, "wait");
  assert.equal(part.phase, "sent");
  const end = liveRing(live(3), 2);
  assert.equal(end.stage, "done");
  assert.deepEqual(Object.values(end.rows).map((x) => x.state), ["tied", "tied"]);
  const endOf = (id: string) => ({ ...structuredClone(SCENARIOS.find((x) => x.id === id)!.steps[3]), mode: "LIVE" as const, recordedAt: null, step: null });
  // the 10-19 recording of the 401 bug: order #3's two resends were accepted and none arrived
  const lost = liveRing(endOf("resend_not_delivered"), 2);
  assert.equal(lost.rows[3].state, "open");
  assert.match(lost.rows[3].note, /^Resend accepted, not delivered\./);
  // the 10-20 recording of the same bug: both rows tied by a resend that arrived
  const both = liveRing(endOf("signature_rejected"), 2);
  assert.equal(both.stage, "done");
  assert.deepEqual(Object.values(both.rows).map((x) => x.state), ["tied", "tied"]);
});

test("the poll runs fast while a row is still moving: a finding that is not final, or a resend on its way", () => {
  assert.equal(hasOpenRow(live(0)), false);
  assert.equal(hasOpenRow(live(2)), true);
  assert.equal(hasOpenRow(live(3)), false);
});

test("the empty live snapshot has no scan, no certificate and no orders", () => {
  const e = emptyLive("abc");
  assert.equal(e.mode, "LIVE");
  assert.equal(e.recordedAt, null);
  assert.equal(e.scan, null);
  assert.equal(e.certificate, null);
  assert.equal(e.session.orders.length, 0);
});

test("a poll that differs only in its own timestamps counts as unchanged, so an idle lane backs off", () => {
  const a = structuredClone(SCENARIOS[0].steps[0]);
  const b = structuredClone(a);
  if (b.scan) {
    b.scan.at += 3_000;
    b.scan.durationMs += 7;
  }
  b.session.now += 3_000;
  assert.equal(snapshotKey(a), snapshotKey(b));
  const c = structuredClone(a);
  c.causes = [];
  assert.notEqual(snapshotKey(a), snapshotKey(c), "a real change still counts");
});

test("a heal record that says healed is shown as saved only when the row is tied", () => {
  const snap = structuredClone(SCENARIOS[0].steps[0]);
  const row = snap.scan!.rows.find((r) => r.status === "GAP")!;
  const ev = row.events.find((e) => e.finding) ?? row.events[0];
  ev.heal = { state: "healed", sends: 1 };
  row.status = "UNVERIFIED";
  assert.notEqual(liveRing(snap, row.n).phase, "saved");
  row.status = "TIED";
  assert.equal(liveRing(snap, row.n).phase, "saved");
});

// ---- Ring again: when it may be pressed, what the server's refusal says, what a failed request says -----------------------------------------------

// Every event of an open row that carries a finding, put in a state of PayPal's list and of Ring again.
function ringAs(s: RunSnapshot, listed: boolean, state: RingState): RunSnapshot {
  const out = structuredClone(s);
  for (const row of out.scan!.rows) for (const e of row.events) if (e.finding && row.status !== "TIED") Object.assign(e, { listed, ring: { state: listed ? state : "not_listed", label: "x" } });
  return out;
}
const idsOfOpenRows = (s: RunSnapshot): string[] => s.scan!.rows.filter((r) => r.status !== "TIED").map((r) => r.captureId);

test("Ring again is on only for the rows whose event PayPal lists, and says why for the rest, with the measured delay", () => {
  const listed = ringAs(live(0), true, "ready");
  assert.deepEqual(ringReadiness(listed).ready, idsOfOpenRows(listed));
  assert.equal(ringReadiness(listed).reason, null);

  const waiting = ringAs(live(0), false, "ready");
  const r = ringReadiness(waiting);
  assert.deepEqual(r.ready, [], "not in PayPal's list: nothing can be rung");
  assert.match(r.reason!, /^PayPal has not listed the refund event yet, usually 1 to 3 minutes after the refund \(median about 80 s, up to 163 s measured\)\./);
  assert.match(r.reason!, /Ring again unlocks when it is\.$/);
  assert.ok(!/Order #/.test(r.reason!), "all the open rows wait for the same thing: the sentence is said once, without a row name");

  // one row listed, the other not: the button is on for the first and the reason names the second
  const mixed = ringAs(live(0), true, "ready");
  const second = mixed.scan!.rows.filter((x) => x.status !== "TIED")[1];
  for (const e of second.events) if (e.finding) Object.assign(e, { listed: false, ring: { state: "not_listed", label: "x" } });
  const m = ringReadiness(mixed);
  assert.equal(m.ready.length, 1);
  assert.notEqual(m.ready[0], second.captureId);
  assert.match(m.reason!, new RegExp(`^Order #${second.n}: PayPal has not listed`));

  // nothing left to ring: said plainly
  assert.equal(ringReadiness(live(3)).reason, "Nothing is left to ring.");
  assert.deepEqual(ringReadiness(live(3)).ready, []);
  assert.deepEqual(ringReadiness(emptyLive("x")).ready, []);

  // the other reasons keep their own words
  assert.match(ringReadiness(ringAs(live(0), true, "retries_pending")).reason!, /still retrying on its own/);
  assert.match(ringReadiness(ringAs(live(0), true, "in_progress")).reason!, /resend was just accepted/);
});

test("when the server refuses a ring after all (the page's snapshot is a few seconds behind), its reason is told in words", () => {
  assert.equal(ringRefusal({ sent: true, at: 1, resends: 1 }), null);
  assert.equal(ringRefusal(null), null);
  assert.equal(ringRefusal("<html>"), null);
  assert.equal(ringRefusal({ error: { message: "no" } }), null);
  const notListed = ringRefusal({ sent: false, ring: { state: "not_listed", label: "Cannot auto-heal: the event is not in PayPal's list (it shows up 80 to 163 s late)" } }, "refund")!;
  assert.match(notListed, /^PayPal has not listed the refund event yet, usually 1 to 3 minutes after the refund \(median about 80 s, up to 163 s measured\)\./);
  // PayPal's own refusal of a resend is not "not listed", although the route files it under that state: its label is shown as it is
  assert.equal(ringRefusal({ sent: false, ring: { state: "not_listed", label: "Cannot auto-heal: PayPal refused the resend (HTTP 404)" } }, "refund"), "Cannot auto-heal: PayPal refused the resend (HTTP 404).");
  assert.equal(ringRefusal({ sent: false, ring: { state: "cap_reached", label: "Resend limit reached (5 per session)" } }), "Resend limit reached (5 per session).");
  assert.equal(ringRefusal({ sent: false, ring: { state: "in_progress", label: "Resent, waiting for it to arrive" } }), "A resend was just accepted. Waiting for it to arrive.");
});

test("a refusal's reason is not printed twice when the page already says it beside the button", () => {
  const note = { step: 4, tone: "info" as const, message: NOT_RUNG, reasons: ["PayPal has not listed the refund event yet."] };
  assert.equal(noteText(note, "PayPal has not listed the refund event yet. Ring again unlocks when it is."), NOT_RUNG);
  assert.equal(noteText(note, null), `${NOT_RUNG} PayPal has not listed the refund event yet.`);
  assert.equal(noteText(note, "A resend was just accepted."), `${NOT_RUNG} PayPal has not listed the refund event yet.`);
  assert.equal(noteText({ step: 1, tone: "error", message: "The order request failed. HTTP 500." }, null), "The order request failed. HTTP 500.");
});

test("a failed request is told beside the control that was pressed, with its own message", () => {
  assert.deepEqual(failureNote("order", failureOf(500, "Something went wrong.")), { step: 1, tone: "error", message: "The order request failed. Something went wrong." });
  assert.equal(failureNote("mode", failureOf(500)).message, "The handler change failed. HTTP 500.");
  assert.equal(failureNote("refund", networkFailure()).message, "The refund request failed. The request did not reach the server.");
  assert.deepEqual((["start", "order", "mode", "refund", "ring", "run"] as Pending[]).map((k) => failureNote(k, networkFailure()).step), [0, 1, 2, 3, 4, 4]);
});

// ---- the ring chapter says one thing about whether PayPal lists the event -------------------------------------------------------------------------

const linesOf = (panel: Panel): string[] => panel.stations.flatMap((st) => [...st.layers.flatMap((l) => l.variants.flatMap((v) => v.lines.map((x) => richText(x.rich)))), ...Object.values(st.glance)]);
const RING_STATES: RingState[] = ["ready", "wait", "cannot_heal", "not_listed", "retries_pending", "in_progress", "cap_reached"];

test("no snapshot makes the ring chapter say both 'Does not list' and 'Ready to ask'", () => {
  let n = 0;
  const check = (panel: Panel, what: string) => {
    const lines = linesOf(panel);
    n++;
    assert.ok(!(lines.some((l) => /Does not list/.test(l)) && lines.some((l) => /Ready to ask/.test(l))), `${what}: PayPal and Doorbell disagree`);
    assert.ok(!(lines.some((l) => /Does not list/.test(l)) && lines.includes("Ready")), `${what}: the strip's words disagree`);
  };
  // the recorded runs, every step as the incident
  for (const sc of SCENARIOS) for (const [i, step] of sc.steps.entries()) check(buildPanel({ before: step, fixed: null, after: null, mode: "script" }).panel, `${sc.id} step ${i + 1}`);
  // live: the diagnosis was made in one state of PayPal's list and the newest snapshot is in another, in every pairing
  for (const was of [true, false]) {
    for (const now of [true, false]) {
      for (const state of RING_STATES) {
        const diag = ringAs(live(0), was, "ready");
        const current = ringAs(live(1), now, state);
        check(livePanel(current, diag, current).panel, `live: diagnosed ${was ? "listed" : "not listed"}, now ${now ? "listed" : "not listed"} (${state})`);
      }
    }
  }
  assert.ok(n > 30, `${n} panels checked`);
});

test("a live panel reads PayPal's list from the newest snapshot, not from the diagnosis: the same event, read now", () => {
  const notYet = ringAs(live(0), false, "ready"); // the gap was found before PayPal listed the refund event
  const now = ringAs(live(1), true, "ready"); // and the list has it now
  const t = linesOf(livePanel(now, notYet, now).panel).join("\n");
  assert.match(t, /Still lists the refund event, so it can be sent again/);
  assert.match(t, /Ready to ask PayPal to send it again/);
  assert.ok(!/Does not list/.test(t) && !/Waiting for PayPal to list/.test(t));
  // and the other way round: it was listed at the diagnosis and is not in the newest read
  const gone = ringAs(live(1), false, "ready");
  const goneLive = livePanel(gone, ringAs(live(0), true, "ready"), gone).panel;
  const g = linesOf(goneLive).join("\n");
  assert.match(g, /Does not list the refund event yet, so it cannot be sent again/);
  assert.match(g, /Waiting for PayPal to list the event/);
  assert.ok(!/Ready to ask/.test(g));
  // not listed is a waiting mark and a waiting word on the strip, not a green "Ready"
  assert.equal(goneLive.stations[1].glance["6:idle"], "Waiting");
  assert.equal(goneLive.stations[1].marks["6:idle"], "wait");
  // a recorded story keeps the state it recorded: the first step of the dropped refund has the event listed
  const recorded = buildPanel({ before: A[0], fixed: A[1], after: A[3], mode: "script" }).panel;
  assert.match(linesOf(recorded).join("\n"), /Ready to ask PayPal to send it again/);
});

// ---- a gap that closed with no ring: PayPal's own retry reached the fixed shop ---------------------------------------------------------------------

// What the ring chapter shows in a phase: the lines of the variants that are on in it, and the strip's words for it.
function ringChapter(panel: Panel, phase: Phase): string[] {
  const tokens = tokensOf(6, phase);
  return panel.stations.flatMap((st) => [
    ...st.layers.filter((l) => l.on.includes("6")).flatMap((l) => l.variants.filter((v) => v.on.length === 0 || v.on.some((t) => tokens.includes(t))).flatMap((v) => v.lines.map((x) => richText(x.rich)))),
    st.glance[`6:${phase}`] ?? st.glance["6"] ?? "",
  ]);
}
const ringOf = (seed: LiveSeed) => {
  const { panel } = livePanel(seed.snap!, seed.diag!, seed.fixed!);
  const ring = liveRing(seed.snap!, panel.subject?.n ?? null);
  return { panel, ring, lines: ringChapter(panel, ring.phase) };
};
const liveOf = (sc: (typeof SCENARIOS)[number], i: number): RunSnapshot => ({ ...structuredClone(sc.steps[i]), mode: "LIVE", recordedAt: null, step: null });
// A row TIED in the newest snapshot never has books that "still" say paid, and a chapter with no ring in it never says that anything was healed or sent.
const STALE = /Still says|saved nothing|Ready to ask|Still lists|Does not list|Waiting for PayPal|Last time|\bPaid\b/;
const RING_WORDS = /ealed|Sends the same event again|Asked PayPal|Received it again|Resend/;

test("a row tied by PayPal's own retry (401, 401, then 200) is told as it is: the ring chapter reads the newest snapshot", () => {
  const seed = selfHealedSeed();
  const row = seed.snap!.scan!.rows.find((r) => r.n === 2)!;
  assert.equal(row.status, "TIED");
  assert.equal(row.events.find((e) => e.kind === "refunded")!.s!.map((a) => a.status).join(), "401,401,200");
  assert.ok(seed.snap!.scan!.rows.every((r) => r.events.every((e) => e.heal === null)), "no heal record: nothing was rung");

  const { panel, ring, lines } = ringOf(seed);
  assert.equal(panel.subject!.n, 2);
  assert.equal(liveChapter(panel, seed.snap!), 6, "the panel opens on the chapter that tells it");
  assert.deepEqual([ring.stage, ring.phase, ring.asks], ["done", "saved", 0], "done, the books are right, and no ask was made");

  const text = lines.join("\n");
  assert.match(text, /Its own retry delivered the event after the fix/);
  assert.match(text, /Sent nothing: PayPal's own retry got there first/);
  assert.match(text, /Compared the books with PayPal at \d\d:\d\d:\d\d: they match/);
  assert.match(text, /Answered 200 OK to PayPal's own retry at \d\d:\d\d:\d\d\.\d\d\d/);
  assert.match(text, /Try 3 at \+\d+ s/);
  assert.match(text, /Now says Refunded \$48\.00/);
  assert.doesNotMatch(text, STALE);
  assert.doesNotMatch(text, RING_WORDS);
  // the ledger under it says the same
  assert.deepEqual(panel.ledger.filter((r) => r.n >= 2).map((r) => [r.paypal, r.end.books, r.end.kind]), [["Refunded", "Refunded $48.00", "tied"], ["Refunded", "Refunded $48.00", "tied"]]);
  // every phase says the same, and every mark is an ok one
  for (const phase of PHASES) {
    assert.deepEqual(ringChapter(panel, phase), lines, phase);
    for (const st of panel.stations) assert.equal(markOf(st, 6, phase), "ok", `${st.name} ${phase}`);
  }
});

test("'after the fix' is said only when the lane remembers the fix and it came before the try that closed the row", () => {
  const seed = selfHealedSeed();
  const closeAt = seed.snap!.scan!.rows.find((r) => r.n === 2)!.events.find((e) => e.kind === "refunded")!.s![2].receivedAt!;
  const said = (s: LiveSeed) => ringOf(s).lines.join("\n");
  assert.match(said(seed), /after the fix/);
  assert.doesNotMatch(said({ ...seed, fixed: null }), /after the fix/, "no memory of the fix");
  const late = structuredClone(seed.fixed!);
  late.session.now = closeAt + 1_000;
  assert.doesNotMatch(said({ ...seed, fixed: late }), /after the fix/, "the fix was seen only after the try");
  // what the tries show is still told
  assert.match(said({ ...seed, fixed: null }), /Its own retry delivered the event/);
  assert.match(said({ ...seed, fixed: null }), /Answered 200 OK to PayPal's own retry/);
});

test("a delivery on a new transmission id is not called PayPal's own retry; a row whose tries show nothing is told only that the books match", () => {
  const edit = (change: (refunded: ScanEvent) => void): LiveSeed => {
    const seed = selfHealedSeed();
    for (const row of seed.snap!.scan!.rows) {
      const e = row.events.find((x) => x.kind === "refunded" && x.s && x.s.length === 3);
      if (e) change(e);
    }
    return seed;
  };
  const other = ringOf(edit((e) => (e.s![2].tid = "another-delivery"))).lines.join("\n");
  assert.match(other, /Delivered the event again after the fix, not through Ring again/);
  assert.match(other, /Sent nothing: another delivery got there first/);
  assert.match(other, /Answered 200 OK to a delivery nobody asked for/);
  assert.doesNotMatch(other, /own retry/);
  const changes: [string, (e: ScanEvent) => void][] = [["200 at the first try", (e) => (e.s = [e.s![2]])], ["no report", (e) => (e.s = null)]];
  for (const [what, change] of changes) {
    const t = ringOf(edit(change)).lines.join("\n");
    assert.match(t, /Sent nothing: the books already match PayPal/, what);
    assert.match(t, /Now says Refunded \$48\.00/, what);
    assert.doesNotMatch(t, /retry|Try \d|after the fix|Answered/, what);
    assert.doesNotMatch(t, STALE, what);
    assert.doesNotMatch(t, RING_WORDS, what);
  }
});

test("no snapshot with the followed row TIED has a ring chapter that says the books still say paid or that the shop saved nothing", () => {
  let n = 0;
  const check = (seed: LiveSeed, what: string) => {
    const { panel, ring, lines } = ringOf(seed);
    const row = seed.snap!.scan!.rows.find((r) => r.n === panel.subject?.n);
    if (row?.status !== "TIED") return;
    n++;
    assert.doesNotMatch(lines.join("\n"), /Still says|saved nothing|Ready to ask|Still lists|Does not list|Waiting for PayPal|Last time/, `${what} (${ring.phase})`);
  };
  // the recorded runs, every step of each as the newest snapshot of a live session that was diagnosed at the first step
  for (const sc of SCENARIOS) for (const i of sc.steps.keys()) check({ snap: liveOf(sc, i), diag: liveOf(sc, 0), fixed: liveOf(sc, 1) }, `${sc.id} step ${i + 1}`);
  // PayPal's own retry, with and without the lane's memory of the fix
  const seed = selfHealedSeed();
  check(seed, "own retry");
  check({ ...seed, fixed: null }, "own retry, fix not remembered");
  assert.ok(n >= 6, `${n} tied snapshots checked`);
});

test("the recorded stories do not change: none of them tells a closure", () => {
  for (const sc of SCENARIOS) {
    const panel = buildPanel({ before: sc.steps[0], fixed: sc.steps[1], after: sc.steps[sc.steps.length - 1], mode: "script" }).panel;
    assert.doesNotMatch(linesOf(panel).join("\n"), /Sent nothing|own retry|nobody asked for|Nothing to ring/, sc.id);
  }
});
