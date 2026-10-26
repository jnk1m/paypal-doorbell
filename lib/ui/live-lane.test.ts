// The live lane as a judge sees it, rendered from synthetic snapshots (the lane's `seed`: it probes, polls and sends nothing): the control that was pressed
// says what it waits for and the others are off, a failure or a refusal is told beside its control, Ring again is on only when the snapshot says a row can be
// rung and says why when it is off, the proposed fix shows under the gaps with the words of the recorded story, and the ring chapter does not contradict itself.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { RingState } from "../gaps/classify.ts";
import type { RunSnapshot } from "../run/snapshot.ts";
import { CATALOG } from "../shop/catalog.ts";
import { ALL_MODES } from "../shop/types.ts";
import { certificateOf, rowsInsideListLag } from "../cert/cert.ts";
import { closureOf } from "../gaps/closure.ts";
import { checkSnapshot } from "./check.ts";
import { LIVE_PENDING } from "./copy.ts";
import { NOT_DIAGNOSED_TEXT } from "../cause/categories.ts";
import { failureNote, failureOf, liveRing, NOT_RUNG, ringRefusal, type LiveSeed, type PendingAction } from "./live.ts";
import { notProvenSeed, selfHealedSeed } from "./live-seeds.ts";
import { NOT_DIAGNOSED_PHRASE, NOT_PROVEN_PHRASE } from "./phrases.ts";
import { readable, renderLiveSeeded } from "./render-helpers.ts";
import { richText } from "./rich.ts";
import { SCENARIOS, recordedStories } from "./source.ts";
import { closedByItself } from "./story.ts";

const stories = recordedStories();
const A = SCENARIOS[0].steps; // the dropped refund: incident (with a proven fix), fix, ring in progress, end
const live = (i: number): RunSnapshot => ({ ...structuredClone(A[i]), mode: "LIVE", recordedAt: null, step: null });
const squash = (s: string): string => s.replace(/\s+/g, "");

// Every event of an open row that carries a finding, in a state of PayPal's list and of Ring again.
function ringAs(s: RunSnapshot, listed: boolean, state: RingState = "ready"): RunSnapshot {
  const out = structuredClone(s);
  for (const row of out.scan!.rows) for (const e of row.events) if (e.finding && row.status !== "TIED") Object.assign(e, { listed, ring: { state: listed ? state : "not_listed", label: "x" } });
  return out;
}

// The bug is still on, the gaps are found, PayPal lists the refund events (or not).
const found = (listed: boolean, o: LiveSeed = {}): LiveSeed => ({ sid: "abcdef12-0000", snap: ringAs(live(0), listed), diag: live(0), fixed: null, everPlanted: true, ...o });
// The working handler is on and the lane has the diagnosis and the moment of the fix.
const fixedLane = (listed: boolean, o: LiveSeed = {}): LiveSeed => ({ sid: "abcdef12-0000", snap: ringAs(live(1), listed), diag: live(0), fixed: live(1), everPlanted: true, ...o });

const pend = (p: PendingAction | null, o: LiveSeed = fixedLane(true)): string => renderLiveSeeded(stories, { ...o, pending: p });
const steps = (html: string): string => html.slice(html.indexOf('class="narr steps-col"'), html.indexOf("<aside"));
const section = (html: string, n: number): string => html.match(new RegExp(`<section class="lstep[^"]*" aria-labelledby="s${n}-h"[\\s\\S]*?</section>`))![0];
// the action buttons of the lane (not the glossary's)
const buttons = (html: string): { tag: string; text: string }[] => [...steps(html).matchAll(/(<button type="(?:button|submit)" class="btn(?:-quiet)?"[^>]*>)([^<]*)<\/button>/g)].map((m) => ({ tag: m[1], text: m[2] }));
const radios = (html: string): string[] => [...steps(html).matchAll(/<input type="radio"[^>]*>/g)].map((m) => m[0]);
const is = (tag: string, attr: string): boolean => tag.includes(attr);

// ---- 1. what the control says while its request is out ----------------------------------------------------------------------------------------------

test("an order in flight: the pressed item says it is placing the order, and every other action is off", () => {
  const ids = Object.keys(CATALOG);
  const html = pend({ kind: "order", target: ids[1] });
  const btns = buttons(html);
  const busy = btns.filter((b) => is(b.tag, 'aria-busy="true"'));
  assert.equal(busy.length, 1);
  assert.equal(busy[0].text, "Placing the order with PayPal…");
  assert.equal(busy[0].text, LIVE_PENDING.order);
  // the other two items keep their names; none of the lane's buttons or radios can be pressed
  assert.equal(btns.filter((b) => b.text === "Placing the order with PayPal…").length, 1);
  for (const id of ids.filter((x) => x !== ids[1])) assert.ok(btns.some((b) => b.text.startsWith(CATALOG[id as keyof typeof CATALOG].name)), id);
  assert.ok(btns.length >= 5, `${btns.length} buttons`);
  for (const b of btns) assert.ok(is(b.tag, 'disabled=""'), `disabled: ${b.text}`);
  for (const r of radios(html)) assert.ok(is(r, 'disabled=""'), r);
  // nothing is pressed when nothing is in flight: the refund is on once there is an order to refund
  const idle = buttons(pend(null));
  assert.ok(idle.some((b) => /^Refund order #/.test(b.text) && !is(b.tag, "disabled")));
  assert.ok(!idle.some((b) => is(b.tag, "aria-busy")));
});

test("a refund, a handler change, Run Doorbell, Ring again and a new session each say what they wait for", () => {
  const refund = buttons(pend({ kind: "refund" })).filter((b) => is(b.tag, 'aria-busy="true"'));
  assert.deepEqual(refund.map((b) => b.text), ["Asking PayPal to refund…"]);

  const run = buttons(pend({ kind: "run" })).filter((b) => is(b.tag, 'aria-busy="true"'));
  assert.deepEqual(run.map((b) => b.text), ["Checking the books against PayPal…"]);

  // Ring again, even though the snapshot says it could be rung
  const ring = pend({ kind: "ring" });
  const rung = buttons(ring).filter((b) => is(b.tag, 'aria-busy="true"'));
  assert.deepEqual(rung.map((b) => b.text), ["Asking PayPal to send it again…"]);
  assert.ok(is(rung[0].tag, 'disabled=""'));
  assert.ok(!/id="ring-why"/.test(ring), "while it waits, the button says why; there is no second reason");

  // a handler change: the radios are the control, so the line under them says it, and the picked one shows as chosen
  const target = ALL_MODES.find((m) => m !== "good")!;
  const mode = pend({ kind: "mode", target });
  assert.match(section(mode, 3), /<p class="live-status" role="status">Switching the shop&#x27;s handler…<\/p>/);
  const checked = radios(mode).filter((r) => is(r, "checked"));
  assert.equal(checked.length, 1);
  for (const r of radios(mode)) assert.ok(is(r, 'disabled=""'));
  assert.ok(buttons(mode).every((b) => is(b.tag, 'disabled=""')));

  // the status line of the last step says it too, to a screen reader
  assert.match(section(pend({ kind: "refund" }), 5), /role="status">Asking PayPal to refund… /);
});

test("the token form's button says it is opening a session, and it is off while it does", () => {
  const html = renderLiveSeeded(stories, { sid: "", pending: { kind: "start" } }); // no session yet: the lane shows the form
  const start = [...html.matchAll(/(<button type="submit"[^>]*>)([^<]*)<\/button>/g)].map((m) => ({ tag: m[1], text: m[2] }));
  assert.deepEqual(start.map((b) => b.text), ["Opening a session…"]);
  assert.ok(is(start[0].tag, 'disabled=""') && is(start[0].tag, 'aria-busy="true"'));
  const idle = [...renderLiveSeeded(stories, { sid: "" }).matchAll(/<button type="submit"[^>]*>([^<]*)<\/button>/g)].map((m) => m[1]);
  assert.deepEqual(idle, ["Start a session"]);
});

// ---- 2. a failure or a refusal is told in place -----------------------------------------------------------------------------------------------------

test("a failed request is told in the step of its control and nowhere else", () => {
  const cases: [Parameters<typeof failureNote>[0], number, string][] = [
    ["order", 2, "The order request failed. Something went wrong."],
    ["mode", 3, "The handler change failed. Something went wrong."],
    ["refund", 4, "The refund request failed. Something went wrong."],
    ["ring", 5, "The Ring again request failed. Something went wrong."],
  ];
  for (const [what, n, message] of cases) {
    const html = renderLiveSeeded(stories, fixedLane(true, { note: failureNote(what, failureOf(500, "Something went wrong.")) }));
    assert.ok(section(html, n).includes(`<p class="form-error" role="alert">${message}</p>`), `${what}: in step ${n}`);
    assert.equal((html.match(/(?:The order request|The handler change|The refund request|The Ring again request) failed\./g) ?? []).length, 1, `${what}: said once`);
  }
  // no note: none of those words
  assert.ok(!/request failed/.test(renderLiveSeeded(stories, fixedLane(true))));
});

test("when the server refused the ring after all, its reason is in the left column, beside Ring again, and it is not an error", () => {
  const reasons = ["Cannot auto-heal: PayPal refused the resend (HTTP 404)."];
  // the snapshot still says "ready" (the race): the server's reason is the only place that says why
  const html = renderLiveSeeded(stories, fixedLane(true, { note: { step: 4, tone: "info", message: NOT_RUNG, reasons } }));
  const line = html.match(/<div class="ring-line">[\s\S]*?<\/div>/)![0];
  assert.ok(line.includes(`<p class="live-status" role="status">${NOT_RUNG} ${reasons[0]}</p>`));
  assert.ok(!/form-error/.test(line));
  // the snapshot after the refusal says it too, beside the button: the reason is said once
  const why = ringRefusal({ sent: false, ring: { state: "not_listed", label: "x" } }, "refund")!;
  const said = renderLiveSeeded(stories, fixedLane(false, { note: { step: 4, tone: "info", message: NOT_RUNG, reasons: [why] } }));
  assert.equal((readable(said).text.match(/PayPal has not listed the refund event yet/g) ?? []).length, 1);
  assert.ok(readable(said).text.includes(NOT_RUNG));
});

// ---- 3. Ring again is on only when a row can be rung ------------------------------------------------------------------------------------------------

test("not in PayPal's list: Ring again is off and the reason is next to it, in plain words", () => {
  const html = renderLiveSeeded(stories, found(false));
  const ring = buttons(html).find((b) => b.text === "Ring again")!;
  assert.ok(ring && is(ring.tag, 'disabled=""') && is(ring.tag, 'aria-describedby="ring-why"'));
  const line = html.match(/<div class="ring-line">[\s\S]*?<\/div>/)![0];
  assert.match(readable(line).text, /PayPal has not listed the refund event yet, usually 1 to 3 minutes after the refund \(median about 80 s, up to 163 s measured\)\..*Ring again unlocks when it is\./);
  assert.ok(line.indexOf("Ring again") < line.indexOf('id="ring-why"'), "the reason comes right after the button");
});

test("in PayPal's list and nothing in flight: Ring again is on and needs no reason; with a request in flight it is off again", () => {
  const html = renderLiveSeeded(stories, found(true));
  const ring = buttons(html).find((b) => b.text === "Ring again")!;
  assert.ok(ring && !is(ring.tag, "disabled"), ring?.tag);
  assert.ok(!/id="ring-why"/.test(html));
  const busy = buttons(renderLiveSeeded(stories, found(true, { pending: { kind: "refund" } }))).find((b) => b.text === "Ring again")!;
  assert.ok(is(busy.tag, 'disabled=""'));
  // a retry of PayPal's own and a resend already on its way are waiting states too
  for (const state of ["retries_pending", "in_progress"] as const) {
    const r = buttons(renderLiveSeeded(stories, { ...found(true), snap: ringAs(live(0), true, state) })).find((b) => b.text === "Ring again")!;
    assert.ok(is(r.tag, 'disabled=""'), state);
  }
});

test("the lane never says healed for a row that is not tied", () => {
  const snap = ringAs(live(0), true);
  const row = snap.scan!.rows.find((r) => r.status !== "TIED")!;
  row.events.find((e) => e.finding)!.heal = { state: "healed", sends: 1, sentAt: [1], arrivedAt: 2, arrivalSeconds: 1 };
  const t = readable(renderLiveSeeded(stories, found(true, { snap }))).text;
  assert.ok(!/Healed/.test(t), "not tied: not healed");
  assert.match(t, /Resend delivered, books being checked/);
});

// ---- 4. the proposed fix, with the words of the recorded story ----------------------------------------------------------------------------------------

test("the live lane shows the proven fix under the gaps with the same labels and words as the recorded story", () => {
  const story = stories.find((s) => s.id === SCENARIOS[0].id)!;
  const proof = story.fix.proof!;
  assert.ok(proof, "the recorded run has a proven fix");
  const html = renderLiveSeeded(stories, fixedLane(true));
  const t = squash(readable(steps(html)).text);
  assert.ok(t.includes(squash(`${proof.proposed} · ${proof.note}`)), "Proposed by Claude · not deployed in this demo");
  assert.equal(`${proof.proposed} · ${proof.note}`, "Proposed by Claude · not deployed in this demo");
  for (const rich of [proof.verdict, proof.leftovers, proof.deployed, proof.lede]) assert.ok(t.includes(squash(richText(rich))), richText(rich));
  for (const s of [proof.basis, proof.verdictNote]) assert.ok(t.includes(squash(s)), s);
  assert.match(html, /<div class="fx-live">[\s\S]*<div class="fx">/);
  // it is under the gaps and Ring again, and before the certificate's list of what Doorbell cannot prove
  const at = (s: string): number => steps(html).indexOf(s);
  assert.ok(at("Ring again") < at("Proposed by Claude"));
  // the diff is the story's diff, line for line
  const lines = proof.hunks.flat().filter((l) => l.kind !== "ctx").map((l) => l.text.trim()).filter(Boolean);
  assert.ok(lines.length > 0);
  for (const l of lines) assert.ok(t.includes(squash(l)), l);
});

test("the proof is not shown before the working handler is on, nor for a cause without a proven fix", () => {
  assert.ok(!/Proposed by Claude/.test(renderLiveSeeded(stories, found(true))), "the bug is still on: the proof says what the demo runs, which is not true yet");
  const noFix = live(0);
  for (const c of noFix.causes) delete c.fix;
  assert.ok(!/Proposed by Claude/.test(renderLiveSeeded(stories, fixedLane(true, { diag: noFix }))));
  // a fix for another cause (the request hash differs) is not shown either
  const other = live(0);
  for (const c of other.causes) if (c.fix) c.fix = { ...c.fix, causeRequestHash: "not-this-one" };
  assert.ok(!/Proposed by Claude/.test(renderLiveSeeded(stories, fixedLane(true, { diag: other }))));
  // and a cause that the replay did not confirm
  const unconfirmed = live(0);
  for (const c of unconfirmed.causes) if (c.replay) c.replay = { ...c.replay, basis: "none" } as typeof c.replay;
  assert.ok(!/Proposed by Claude/.test(renderLiveSeeded(stories, fixedLane(true, { diag: unconfirmed }))));
});

// ---- 5. the right panel and the left column agree -----------------------------------------------------------------------------------------------------

test("the whole live page never says both 'Does not list' and 'Ready to ask'", () => {
  for (const was of [true, false]) {
    for (const now of [true, false]) {
      const html = renderLiveSeeded(stories, { sid: "abcdef12-0000", snap: ringAs(live(1), now), diag: ringAs(live(0), was), fixed: ringAs(live(1), now), everPlanted: true });
      const t = readable(html).text;
      assert.ok(!(/Does not list/.test(t) && /Ready to ask/.test(t)), `diagnosed ${was}, now ${now}`);
      assert.equal(/Does not list the refund event yet/.test(t), !now, `now ${now}: the panel speaks for the newest snapshot`);
    }
  }
});

// ---- 6. why the AI named no cause, beside the gap ----------------------------------------------------------------------------------------------------------

// The gap rows of the last step: each gap's finding, and what stands under it.
const gapRows = (html: string): string => readable(html.match(/<div class="gap-rows">[\s\S]*?<div class="ring-line">/)![0]).text;
const times = (text: string, part: string): number => text.split(part).length - 1;
const FOUND = "Order #2: Your handler turned the delivery away.";

test("a cause that is not proven says why beside the gap, in the words of the recorded story, once", () => {
  const phrase = NOT_PROVEN_PHRASE.model_abstained;
  const html = renderLiveSeeded(stories, notProvenSeed());
  const rows = gapRows(html);
  assert.match(rows, /The cause is not proven\. The AI found no changed line that explains this gap\./);
  assert.equal(times(rows, phrase), 1, "both gaps share the reason: it is said once, under the first");
  assert.ok(rows.indexOf(FOUND) >= 0 && rows.indexOf(FOUND) < rows.indexOf(phrase) && rows.indexOf(phrase) < rows.indexOf("Order #3:"), "under the finding of the first gap");
  assert.equal(times(readable(html).text, phrase), 1, "and nowhere else on the page");
  // the words of the third chapter of the recorded story of the same bug
  const story = stories.find((s) => s.id === "cause_not_in_code")!;
  assert.equal(story.why.h, "The cause is not proven.");
  assert.equal(richText(story.why.body[0]), phrase);
  // no sentence of five or more words twice among the gap rows
  const sentences = rows.split(/(?<=[.!?])\s+/).map((x) => x.trim().replace(/[.!?]$/, "").toLowerCase()).filter((x) => x.split(/\s+/).length >= 5);
  assert.deepEqual(sentences.filter((x, i) => sentences.indexOf(x) !== i), []);
});

test("a cause that was not diagnosed says why in the same place, with the reason's own words", () => {
  const seed = notProvenSeed();
  for (const s of [seed.snap!, seed.diag!]) for (const c of s.causes) c.cause = { status: "not_diagnosed", reason: "timeout", text: NOT_DIAGNOSED_TEXT, promptVersion: "x", requestHash: "h" };
  const rows = gapRows(renderLiveSeeded(stories, seed));
  assert.match(rows, new RegExp(`No cause was diagnosed\\. ${NOT_DIAGNOSED_PHRASE.timeout.replace(/[.()]/g, "\\$&")}`));
  assert.ok(!/The cause is not proven/.test(rows));
});

test("a proposed cause, a gap without a diagnosis and a row that is tied say nothing about an unproven cause", () => {
  const none = (html: string) => assert.ok(!/The cause is not proven|No cause was diagnosed/.test(readable(steps(html)).text));
  none(renderLiveSeeded(stories, found(true)));
  none(renderLiveSeeded(stories, fixedLane(true)));
  none(renderLiveSeeded(stories, { ...found(true), diag: null }));
  // the rows are tied by PayPal's own retry: the diagnosis was about gaps that are closed
  none(renderLiveSeeded(stories, selfHealedSeed()));
});

// ---- 7. a gap that PayPal's own retry closed: the lane never says a ring happened ----------------------------------------------------------------------

test("the lane opens on the Ring again chapter, which says what the newest snapshot shows, and says no resend was sent or healed", () => {
  const html = renderLiveSeeded(stories, selfHealedSeed());
  assert.match(html, /class="vis(?: tabs)?" data-ch="6"/);
  const t = readable(html).text;
  for (const s of ["Its own retry delivered the event after the fix", "Sent nothing: PayPal's own retry got there first", "Answered 200 OK to PayPal's own retry at", "Now says Refunded $48.00"]) assert.ok(t.includes(s), s);
  assert.ok(!/ealed/.test(t), "healed is the ring's word");
  assert.ok(!/class="ring-line"/.test(html), "no gap is left to ring");
});

// ---- 8. the seed's certificate: computed from the rows, as the live snapshot does ---------------------------------------------------------------------------

test("each seed is a snapshot that checkSnapshot accepts: scan and certificate present together, numbers and stamp agreeing", () => {
  for (const [name, seed] of [["notProvenSeed", notProvenSeed()], ["selfHealedSeed", selfHealedSeed()]] as const) {
    assert.deepEqual(checkSnapshot(seed.snap!), [], name);
    assert.deepEqual(checkSnapshot(seed.diag!), [], `${name} diag`);
    if (seed.fixed) assert.deepEqual(checkSnapshot(seed.fixed), [], `${name} fixed`);
  }
});

test("PayPal's own retry reaches the seed's shop within its measured retry window, after the lane read the gaps and the switch, and the certificate is computed after the edits", () => {
  const seed = selfHealedSeed();
  const scan = seed.snap!.scan!;
  for (const row of scan.rows.filter((r) => r.n >= 2)) {
    const z = closureOf(row)!;
    assert.equal(z.kind, "paypal_retry");
    assert.equal(z.sinceFirstSec, 150, "the third try, about +150 s: inside the 163 s PayPal's retries were measured to take");
    assert.ok(seed.diag!.session.now < seed.fixed!.session.now && seed.fixed!.session.now < z.at && z.at < seed.snap!.session.now, "the gaps, the fix, PayPal's try, the newest scan");
  }
  assert.deepEqual(seed.snap!.certificate, certificateOf(scan, { rowsInsideListLag: rowsInsideListLag(seed.snap!.session.orders, scan.at) }));
  assert.equal(seed.snap!.certificate!.numbers.closedByPaypalRetry, 2);
  assert.equal(seed.snap!.certificate!.stamp, "green");
});

test("the seed's certificate chapter leads with the stamp text and says the rows were booked on PayPal's own retry; the owner view says PayPal tried again by itself; neither says who fixed it", () => {
  const seed = selfHealedSeed();
  const c = seed.snap!.certificate!;
  const t = readable(renderLiveSeeded(stories, seed)).text;
  assert.ok(t.includes("Checked 3 of 3 captures (100%). Tied on 3/3 of what we can see. 2 booked on PayPal's own retry."), "the qualifier stays, the retry follows it");
  assert.ok(c.ownerView.join(" ").includes("PayPal tried again by itself"));
  // the line in the cannot-prove list follows the first, standing line
  const items = [...steps(renderLiveSeeded(stories, seed)).matchAll(/<li[^>]*>([\s\S]*?)<\/li>/g)].map((m) => readable(m[1]).text);
  const at = items.findIndex((x) => x.includes("booked on PayPal's own retry"));
  assert.ok(at >= 1 && /never captured|event-list lag/.test(items[at - 1]), items.slice(0, at + 1).join(" | "));
  // "Doorbell sent nothing" and "after the fix" are the lane's words, from its memory: the certificate does not carry them
  assert.doesNotMatch([c.header, c.stampText, ...c.limits, ...c.ownerView].join("\n"), /sent nothing|after the fix|self-healed|recovered|Doorbell (?:fixed|healed) it|the gap Doorbell found/i);
  assert.match(t, /Sent nothing: PayPal's own retry got there first/);
});

// The row shape where the certificate and the lane could disagree: a resend was asked for (PayPal accepted it), it was never seen reaching the shop, and PayPal's
// own retry (the same transmission id) got the 200 that wrote the books.
function resentNeverSeen(arrived: boolean): LiveSeed {
  const seed = selfHealedSeed();
  const scan = seed.snap!.scan!;
  for (const row of scan.rows.filter((r) => r.n >= 2)) {
    const ev = row.events.find((e) => e.kind === "refunded")!;
    const sentAt = ev.s![1].receivedAt! + 20_000;
    ev.heal = { state: "healed", sends: 1, sentAt: [sentAt], ...(arrived ? { arrivedAt: sentAt + 2_500, arrivalSeconds: 2.5, answer: 200 } : {}) };
  }
  seed.snap!.certificate = certificateOf(scan, { rowsInsideListLag: rowsInsideListLag(seed.snap!.session.orders, scan.at) });
  return seed;
}

test("a resend that was accepted and never seen arriving is not a ring: the lane and the certificate read the row the same way", () => {
  const seed = resentNeverSeen(false);
  const rows = seed.snap!.scan!.rows.filter((r) => r.n >= 2);
  // the certificate: booked on PayPal's own retry, not healed
  const n = seed.snap!.certificate!.numbers;
  assert.deepEqual([n.healed, n.closedByPaypalRetry], [0, 2]);
  assert.deepEqual(checkSnapshot(seed.snap!), []);
  // the lane: closed with no ring, and it does not say it sent nothing, nor healed, nor that a resend arrived
  for (const row of rows) assert.ok(closedByItself(row), `order #${row.n}`);
  const ring = liveRing(seed.snap!, 2);
  assert.deepEqual([ring.stage, ring.phase, ring.asks, Object.keys(ring.rows)], ["done", "saved", 0, []]);
  const html = renderLiveSeeded(stories, seed);
  const t = readable(html).text;
  assert.match(t, /PayPal accepted 1 resend; it was not seen arriving/);
  assert.match(t, /Its own retry delivered the event after the fix/);
  assert.match(t, /Answered 200 OK to PayPal's own retry at/);
  assert.doesNotMatch(t, /Sent nothing|ealed|Needed \d resend|Arrived after the resend|Was sent nothing/);
  assert.doesNotMatch(gapRowsOrEmpty(html), /Order #2: /, "a tied row with an unconfirmed resend is not listed as a ring");
  // with the arrival it is a ring: healed for the certificate, and not "closed by itself" for the lane
  const arrived = resentNeverSeen(true);
  const m = arrived.snap!.certificate!.numbers;
  assert.deepEqual([m.healed, m.closedByPaypalRetry ?? 0], [2, 0]);
  assert.match(gapRowsOrEmpty(renderLiveSeeded(stories, arrived)), /Order #2: Healed\./);
  for (const row of arrived.snap!.scan!.rows.filter((r) => r.n >= 2)) {
    assert.ok(!closedByItself(row));
    assert.equal(closureOf(row), null);
  }
});

const gapRowsOrEmpty = (html: string): string => html.match(/<div class="gap-rows">[\s\S]*?<\/div>/)?.[0] ?? "";
