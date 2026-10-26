// The incident story (lib/ui/story.ts) against the REAL recorded run: every scenario builds the same seven chapters, every sentence is a template
// with numbers read from the snapshots, nothing a model or PayPal wrote is printed, and the ring is played from the recorded heal data.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { NOT_PROVEN_TEXT } from "../cause/categories.ts";
import { ROOT } from "../cause/test-helpers.ts";
import { MODEL_ID } from "../core/llm.ts";
import { readResults, readReviewed, readPatched } from "../fix/files.ts";
import { HELD_OUT } from "./story.ts";
import { sha256 } from "../fix/result.ts";
import { CANNOT_SEE, CHECK_LABEL, CONTROL_LABEL } from "../fix/types.ts";
import { closureOf } from "../gaps/closure.ts";
import { ARRIVAL_WAIT_MS } from "../gaps/heal.ts";
import { ALL_RECORDED_SCENARIOS } from "../run/recorded.ts";
import type { RecordedScenario, RunSnapshot } from "../run/snapshot.ts";
import { FORBIDDEN_WORDS } from "./copy.ts";
import { allText, renderStory } from "./render-helpers.ts";
import { ASK_MS, finalRing, ringBeats, totalMs, applyBeat, IDLE_RING } from "./ring.ts";
import { richText } from "./rich.ts";
import { SCENARIOS, recordedStories } from "./source.ts";
import { CHAPTERS, RESEND_WINDOW_S, buildPanel, buildStory, focusOf, gapKindOf, storyOfScenario, type Story } from "./story.ts";

const stories = recordedStories();
const byId = (id: string): Story => stories.find((s) => s.id === id)!;
const A = byId("refund_never_booked");
const B = byId("late_payment_overwrites");
const C = byId("signature_rejected");
// E is the 10-19 recording of the same planted bug as C, from before the fix existed: no proven fix, and its ring ended with order #3 still open
const E = byId("resend_not_delivered");
const D = byId("cause_not_in_code");
// the stories with a proposed cause: the setting bug (D) has none, so no code block, no replay and a different fix chapter
const coded = [A, B, C, E];

// Every string the story prints, in one list.
function strings(v: unknown): string[] {
  if (typeof v === "string") return [v];
  if (Array.isArray(v)) return v.flatMap(strings);
  if (v && typeof v === "object") return Object.values(v).flatMap(strings);
  return [];
}
const textOf = (s: Story): string => strings(s).join("\n");

// The day each scenario was recorded. The first, second, third and fifth were recorded on 10-20 (the first three again that evening, with the proven fix);
// resend_not_delivered is the 10-19 recording of the third one's planted bug, kept because its ending is the honest "resend accepted, not delivered".
const DAY: Record<string, string> = { refund_never_booked: "Oct 20, 2026", late_payment_overwrites: "Oct 20, 2026", signature_rejected: "Oct 20, 2026", resend_not_delivered: "Oct 19, 2026", cause_not_in_code: "Oct 20, 2026" };
// The scenarios whose recording carries a proven fix beside the replay-confirmed cause (which ones: the test "a proposed fix is told only where ...").
// The tests below take what the data says, so that a scenario recorded again with a fix is held to the same rules.
const proven = stories.filter((s) => !!s.fix.proof);

test("there are seven chapters, and five scenarios that share them", () => {
  assert.deepEqual(CHAPTERS.map((c) => c.no), [1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(stories.map((s) => s.id), ["refund_never_booked", "late_payment_overwrites", "signature_rejected", "resend_not_delivered", "cause_not_in_code"]);
  for (const s of stories) {
    assert.deepEqual(Object.keys(s.panel.available).map(Number), [1, 2, 3, 4, 5, 6, 7]);
    // a cause that is not proven has no replay, so the setting bug's chapter 4 has nothing to show; every other chapter of every story has
    const empty = Object.entries(s.panel.available).filter(([, v]) => !v).map(([k]) => Number(k));
    assert.deepEqual(empty, s.id === "cause_not_in_code" ? [4] : [], `${s.id}: chapters with nothing to show`);
    assert.equal(s.panel.stations.length, 4);
    assert.deepEqual(s.panel.stations.map((st) => st.name), ["PayPal", "Doorbell", "Your shop", "Your books"]);
  }
});

test("each scenario names its kind of gap from the finding, and the story follows order #2's refund", () => {
  assert.deepEqual(stories.map((s) => s.kind), ["ack", "late", "rejected", "rejected", "rejected"]);
  for (const s of stories) {
    assert.equal(s.panel.subject!.n, 2);
    assert.equal(s.panel.subject!.eventWord, "refund");
    assert.equal(s.panel.subject!.amount, "$48.00");
    assert.match(s.panel.subject!.captureId, /^[0-9A-Z]{17}$/);
  }
  assert.equal(gapKindOf(null), "other");
  assert.equal(gapKindOf({ cls: "UNVERIFIED", final: false, why: "" }), "other");
});

test("the recorded date is in the bar, with the honesty sentence", () => {
  for (const s of stories) {
    const bar = richText(s.bar);
    assert.equal(bar, `Recorded run · ${DAY[s.id]} · Sandbox demo · fictional shop · PayPal test money · bugs are planted by us`);
  }
});

// ---- chapter 1 and 2: what happened, how it travelled -------------------------------------------------------------------------------------

test("chapter 1 says what PayPal says and what the books say, from the snapshot", () => {
  for (const s of stories) assert.equal(s.focal.h, "PayPal refunded $48.00. Your books still say paid.");
  assert.equal(richText(A.focal.lead), "No error anywhere.");
  assert.match(richText(B.focal.lead), /A later message undid the refund/);
  for (const s of [C, E]) assert.match(richText(s.focal.lead), /turned the refund message away three times/, s.id);
  // the found line is plain words, defines the capture where it first appears, and says what the shop did only as far as it is true of the scenario
  assert.equal(richText(A.focal.found!), "Doorbell checked the shop's 3 captures: the payments PayPal took, one per order. 2 refunds ($96.00) are missing from your books: the shop answered 200 but did not save them.");
  assert.match(richText(B.focal.found!), /2 refunds \(\$96\.00\) are missing from your books: the shop answered 200 to each, then a late payment overwrote the books\.$/);
  assert.match(richText(E.focal.found!), /2 refunds \(\$96\.00\) are missing from your books: the shop turned the messages away\.$/);
  assert.match(richText(C.focal.found!), /2 refunds \(\$96\.00\) are missing from your books: the shop turned the messages away\. Order #1 matches/);
  for (const s of stories) assert.doesNotMatch(richText(s.focal.found!), /answered 200 but not applied|not in books/, s.id);
});

test("chapter 1 puts what Doorbell is right under the lead, names the AI's part in a clause, and closes by saying which order the chapters follow", () => {
  for (const s of stories) {
    const first = richText(s.focal.body[0]);
    assert.match(first, /^Doorbell is the tool that looks\. It finds the PayPal webhooks your shop never heard or never saved, has an AI point at the changed line of your code behind it, rings them again/);
    assert.match(richText(s.focal.body[1]), /^Order #2 at Maple Mug, a fictional coffee shop/);
    assert.equal(richText(s.focal.pitch), "The chapters below follow order #2 from PayPal to your books. The other gap, order #3, comes back in Ring again.");
  }
});

// An order other than the followed one whose books PayPal's own retry wrote after the shop did not take the first delivery. The sentence is built from the row's
// own tries (lib/gaps/closure.ts), so these tests change the tries of order #1 of the 10-20 recording and read the sentence back.
function retryStory(tries: { status?: number; at: number; tid?: string }[]): Story {
  const sc: RecordedScenario = structuredClone(SCENARIOS.find((x) => x.id === "signature_rejected")!);
  const ev = sc.steps[0].scan!.rows.find((r) => r.n === 1)!.events.find((e) => e.kind === "completed")!;
  const t0 = ev.s![0].receivedAt!;
  const row = sc.steps[0].scan!.rows.find((r) => r.n === 1)!;
  ev.s = tries.map((t, i) => ({ tid: t.tid ?? ev.s![0].tid, attempt: `t${i}`, state: t.status === undefined ? "crashed" : "responded", receivedAt: t0 + t.at * 1000, ...(t.status !== undefined ? { status: t.status, respondedAt: t0 + t.at * 1000 + 300 } : {}) }));
  row.book!.at = t0 + tries[tries.length - 1].at * 1000 + 100;
  return storyOfScenario(sc, "x");
}
const retryText = (s: Story): string => richText(s.focal.found!);

test("chapter 1 tells an order that PayPal's own retry closed, from the row's own tries: the code, the seconds, the ordinal, and 'not planted' only for a 5xx or a crash", () => {
  // the recording: order #1 got a 500, PayPal retried 35 s later and the books took it
  assert.match(richText(C.focal.found!), / Order #1 matches, but its first delivery got a 500 from the shop \(not a bug we planted\); PayPal retried 35 s later and the books took it\.$/);
  // the headline, the lead and the closing line stay on the followed order
  for (const t of [C.focal.h, richText(C.focal.lead), richText(C.focal.pitch)]) assert.doesNotMatch(t, /matches, but|Order #1/);
  assert.equal(C.panel.subject!.n, 2);
  // the phone prints it too, with the rest of the paragraph
  assert.ok(C.phone.c1.more.some((r) => richText(r).includes("Order #1 matches, but its first delivery got a 500 from the shop")));
  // the tries decide the words
  assert.match(retryText(retryStory([{ status: 401, at: 0 }, { status: 200, at: 35 }])), /its first delivery got a 401 from the shop; PayPal retried 35 s later/);
  assert.match(retryText(retryStory([{ at: 0 }, { status: 200, at: 12 }])), /its first delivery got no answer from the shop \(not a bug we planted\); PayPal retried 12 s later/);
  assert.match(retryText(retryStory([{ status: 500, at: 0 }, { status: 502, at: 20 }, { status: 200, at: 70 }])), /its first two deliveries got a 500 and a 502 from the shop \(not a bug we planted\); PayPal's 3rd try came 70 s after the first and the books took it\./);
  assert.match(retryText(retryStory([{ status: 500, at: 0 }, { status: 500, at: 20 }, { status: 200, at: 70 }])), /its first two deliveries each got a 500 from the shop/);
  assert.match(retryText(retryStory([{ at: 0 }, { status: 502, at: 20 }, { status: 200, at: 70 }])), /got no answer and a 502 from the shop \(not a bug we planted\)/);
  // one failure that is not a 5xx or a crash takes the parenthesis away from the whole sentence
  assert.doesNotMatch(retryText(retryStory([{ status: 500, at: 0 }, { status: 401, at: 20 }, { status: 200, at: 70 }])), /planted/);
  // a delivery on a new transmission id is not PayPal's own retry: nothing is said
  assert.doesNotMatch(retryText(retryStory([{ status: 500, at: 0 }, { status: 200, at: 35, tid: "another-delivery" }])), /matches, but/);
});

test("the sentence about PayPal's own retry fires for one order of the six recordings (signature_rejected, order #1), and no planted handler answers a 5xx", () => {
  const hits: string[] = [];
  for (const sc of ALL_RECORDED_SCENARIOS) for (const [i, st] of sc.steps.entries()) for (const row of st.scan?.rows ?? []) if (closureOf(row)) hits.push(`${sc.id} step ${i + 1} order #${row.n} ${closureOf(row)!.kind}`);
  assert.deepEqual(hits, [1, 2, 3, 4].map((i) => `signature_rejected step ${i} order #1 paypal_retry`));
  assert.deepEqual(stories.filter((s) => richText(s.focal.found!).includes("matches, but its")).map((s) => s.id), ["signature_rejected"]);
  // "(not a bug we planted)" is true of a 5xx or a crash because the planted handlers answer 401 or 200 and nothing else
  const dir = join(ROOT, "handlers");
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".ts"))) {
    const statuses = [...readFileSync(join(dir, file), "utf8").matchAll(/status:\s*(\d+)/g)].map((m) => Number(m[1]));
    assert.ok(statuses.length > 0 && statuses.every((c) => c === 200 || c === 401), `${file}: ${statuses.join()}`);
  }
});

test("chapter 1's path says what is known: PayPal and the books, and the two hops between are marked as not followed yet", () => {
  for (const s of stories) {
    const [paypal, doorbell, shop, books] = s.panel.stations;
    // known: PayPal says the refund happened, the books still say paid
    assert.equal(paypal.marks["1"], "ok", s.id);
    assert.equal(books.marks["1"], "bad", s.id);
    // not followed yet: Doorbell and the shop, in chapter 1 only, and said as what comes next, not as "Not traced yet"
    assert.deepEqual([paypal.untraced, doorbell.untraced, shop.untraced, books.untraced], [[], ["1"], ["1"], []], s.id);
    const lineOn1 = (st: (typeof s.panel.stations)[number]) => richText(st.layers.find((l) => l.on.includes("1"))!.variants[0].lines[0].rich);
    assert.equal(lineOn1(doorbell), "What it heard comes next");
    assert.equal(lineOn1(shop), "What your shop did comes next");
    assert.ok(!textOf(s).includes("Not traced yet"), `${s.id}: a recorded story never prints "Not traced yet"`);
  }
  // a session with nothing to trace still draws four ghosts, none of them a "hop to follow"
  const empty = structuredClone(SCENARIOS[0].steps[0]);
  empty.scan = null;
  empty.certificate = null;
  empty.causes = [];
  const ghosts = buildPanel({ before: empty, fixed: null, after: null, mode: "script" }).panel.stations;
  assert.deepEqual(ghosts.map((g) => richText(g.layers[0].variants[0].lines[0].rich)), ["Not traced yet", "Not traced yet", "Not traced yet", "Not traced yet"]);
  assert.ok(ghosts.every((g) => g.untraced.length === 0));
});

test("chapter 2, dropped after a 200: PayPal made the event, Doorbell heard it 9 s later, the shop answered 200 in 321 ms", () => {
  assert.equal(A.travel.h, "Each hop said OK. The books never changed.");
  const t = A.travel.body.map(richText).join(" ");
  assert.match(t, /About 9 seconds later Doorbell heard it/);
  assert.match(t, /answered 200 OK in 321 milliseconds/);
  assert.match(t, /nobody tried again/);
  assert.match(t, /Doorbell's check at 10:42:58 looked each capture up at PayPal/);
  const shop = A.panel.stations[2];
  assert.deepEqual(shop.times[0], { on: ["2", "3"], text: "10:42:37.982" });
  assert.equal(A.panel.stations[0].times[0].text, "10:42:28");
  assert.equal(A.panel.stations[1].times[0].text, "10:42:37");
});

test("chapter 2, late payment: the arrival order is payment, refund, then the late payment that overwrote it", () => {
  const lines = B.panel.stations[2].layers[1].variants[0].lines.map((l) => richText(l.rich));
  assert.deepEqual(lines, [
    "Payment at 10:42:18.084, answered 200 OK",
    "Refund at 10:42:36.753, answered 200 OK",
    "Late payment at 10:44:36.211, answered 200 OK",
    "The books were last written at 10:44:36.529, with paid",
  ]);
  const t = B.travel.body.map(richText).join(" ");
  assert.match(t, /The refund arrived, then the late payment overwrote it/);
  assert.doesNotMatch(t, /OUT_OF_ORDER/, "a product code is not printed");
  assert.match(t, /the same payment, delivered a second time \(PayPal does not promise the order of deliveries\)/);
  assert.match(t, /Doorbell files this as an out-of-order delivery/);
  assert.equal(B.panel.stations[2].hop!.text, "The late payment overwrote the refund");
});

test("chapter 2 names the PayPal calls once each: verify-webhook-signature for the signature, the events list for the check", () => {
  for (const s of stories) {
    const t = s.travel.body.map(richText).join(" ");
    assert.equal((t.match(/verify-webhook-signature/g) ?? []).length, 1, s.id);
    assert.match(t, /checked its signature with PayPal's verify-webhook-signature call/, s.id);
    assert.match(t, /looked each capture up at PayPal, read PayPal's events list, and found the gap/, s.id);
  }
  // when the scan did not read the list, the sentence does not claim it
  const sc = structuredClone(SCENARIOS[0]);
  for (const st of sc.steps) if (st.scan) st.scan.listing = { asked: true, read: false, events: 0 };
  const t = storyOfScenario(sc, "x").travel.body.map(richText).join(" ");
  assert.doesNotMatch(t, /events list/);
  assert.match(t, /looked each capture up at PayPal and found the gap/);
});

test("chapter 2, rejected: the attempts at 0 s, +28 s and +154 s (10-19 recording) or 0 s, +34 s and +156 s (10-20 recording), then PayPal gave up", () => {
  const lines = (s: Story) => s.panel.stations[2].layers[1].variants[0].lines.map((l) => richText(l.rich));
  assert.deepEqual(lines(E), ["Try 1 at 0 s, answered 401", "Try 2 at +28 s, answered 401", "Try 3 at +154 s, answered 401", "Then PayPal gave up: the Sandbox stops after 3 tries"]);
  assert.deepEqual(lines(C), ["Try 1 at 0 s, answered 401", "Try 2 at +34 s, answered 401", "Try 3 at +156 s, answered 401", "Then PayPal gave up: the Sandbox stops after 3 tries"]);
  for (const s of [C, E]) assert.equal(s.travel.h, "Three tries, three rejections. PayPal then gave up.", s.id);
  assert.match(E.travel.body.map(richText).join(" "), /at 0 s, \+28 s and \+154 s/);
  assert.match(C.travel.body.map(richText).join(" "), /at 0 s, \+34 s and \+156 s/);
});

// ---- chapter 3 and 4: why, the replay -----------------------------------------------------------------------------------------------------

test("chapter 3 shows the diff lines by id: the added line, the removed lines, and the checks that passed", () => {
  const code = (s: Story) => s.panel.stations[2].layers.find((l) => l.code)!.code!;
  assert.deepEqual(code(A).lines.map((l) => [l.file, l.no, l.kind]), [["handlers/good.ts", 18, "del"], ["handlers/ack-drop.ts", 11, "add"]]);
  assert.equal(code(A).lines[1].text, "  queue.push(event);");
  assert.deepEqual(code(B).lines.map((l) => [l.file, l.no, l.kind]), [["handlers/good.ts", 15, "del"], ["handlers/good.ts", 16, "del"]]);
  for (const s of [C, E]) assert.deepEqual(code(s).lines.map((l) => [l.file, l.no, l.kind]), [["handlers/bad-body.ts", 8, "add"]], s.id);
  for (const s of coded) {
    assert.equal(code(s).checks.length, 2);
    assert.match(richText(code(s).caption), /^The AI proposed this change in handlers\/[a-z-]+\.ts, planted by us$/);
  }
  // the headings say in plain words what the cited line does
  assert.equal(A.why.h, "The handler says OK before it saves the refund, so the save can be lost");
  for (const s of [C, E]) assert.equal(s.why.h, "The handler reshapes the message before checking its signature, so the check fails", s.id);
  assert.equal(B.why.h, "The AI points at two removed lines, but none of its categories fits");
});

test("the symptom check says what the shop answered, never what the books did; for OTHER_CODE_CHANGE it cannot pass, so it is shown open", () => {
  const code = (s: Story) => s.panel.stations[2].layers.find((l) => l.code)!.code!;
  assert.deepEqual(code(A).checks, [
    { done: true, text: "The cited line is a changed code line" },
    { done: true, text: "The category fits the symptom: the shop answered 200 OK, but its books do not match PayPal" },
  ]);
  for (const s of [C, E]) {
    assert.deepEqual(code(s).checks, [
      { done: true, text: "The cited line is a changed code line" },
      { done: true, text: "The category fits the symptom: the shop answered 401 on each try" },
    ], s.id);
  }
  // late payment: the model named no category. consistentWith() is true for it on every symptom, so the check has nothing to test.
  assert.deepEqual(code(B).checks, [
    { done: true, text: "The cited line is a changed code line" },
    { done: false, text: "No named category, so the symptom cannot rule this line out" },
  ]);
  for (const s of coded) assert.ok(!code(s).checks.some((c) => /books unchanged/.test(c.text)), `${s.id}: "books unchanged" is not true of every case of the class`);
  // the left column says the same: one check passes, the other has nothing to test; it never says "both pass" for it
  assert.doesNotMatch(B.why.body.map(richText).join(" "), /both pass/);
  assert.match(B.why.body.map(richText).join(" "), /One passes: the cited line is a changed line\. The other asks whether the category fits the symptom, and with no named category it has nothing to test/);
  for (const s of [A, C, E]) assert.match(s.why.body.map(richText).join(" "), /Two checks run in plain code, with no model involved, and both pass/, s.id);
  // the check is shown open whatever the symptom, as soon as the category is OTHER_CODE_CHANGE
  const sc = structuredClone(SCENARIOS[0]);
  for (const st of sc.steps) for (const g of st.causes) if (g.cause.status === "proposed") g.cause.category = "OTHER_CODE_CHANGE";
  const other = storyOfScenario(sc, "x");
  assert.deepEqual(code(other).checks.map((c) => c.done), [true, false]);
  // coverage done, line done, category open, replay not done (it confirms only the category its planted mode predicts), the books match
  assert.deepEqual(other.cert.after.checks.map((c) => c.done), [true, true, false, false, true]);
  assert.match(richText(other.cert.after.checks[2].rich), /^The AI named no category, so the symptom could not rule the line out\.$/);
  assert.doesNotMatch(other.cert.after.checks.map((c) => richText(c.rich)).join(" "), /category fits/);
});

const HELD_OUT_SENTENCE = "On a held-out set sealed before the run (2026-10-26) it named the right category in 34 of 35 cases; the README has the rest.";

test("the AI receipt: model from the config, one of eight categories, the lines cited, a stored recording, and the held-out result in plain counts (no percentage)", () => {
  const receipt = (s: Story) => s.panel.stations[2].layers.find((l) => l.code)!.code!.receipt;
  assert.equal(receipt(A), `AI receipt: claude-sonnet-5-5 picked 1 of 8 categories (work after acknowledgement) and cited 2 changed lines. The answer is a stored recording; this page makes no model call. ${HELD_OUT_SENTENCE}`);
  assert.equal(receipt(B), `AI receipt: claude-sonnet-5-5 picked 1 of 8 categories (other code change) and cited 2 changed lines. The answer is a stored recording; this page makes no model call. ${HELD_OUT_SENTENCE}`);
  for (const s of [C, E]) assert.equal(receipt(s), `AI receipt: claude-sonnet-5-5 picked 1 of 8 categories (request body altered) and cited 1 changed line. The answer is a stored recording; this page makes no model call. ${HELD_OUT_SENTENCE}`, s.id);
  for (const s of coded) assert.doesNotMatch(receipt(s)!, /%|accuracy|precision|recall|\d+\/\d+ /, `${s.id}: the held-out result is a count, never a percentage or a claim word`);
  // the model name is the config's: it is the one the recordings were made with, and a story built without it does not guess one
  assert.equal(MODEL_ID, "claude-sonnet-5-5");
  const bare = storyOfScenario(SCENARIOS[0], "x");
  assert.match(receipt(bare)!, /^AI receipt: the AI picked 1 of 8 categories/);
  // a live answer is not called a recording
  const sc = structuredClone(SCENARIOS[0]);
  for (const st of sc.steps) for (const g of st.causes) if (g.cause.status === "proposed") g.cause.source = "live";
  assert.match(receipt(storyOfScenario(sc, "x"))!, /The answer came from a live model call\. On a held-out set/);
});

test("chapter 3 uses the category's fixed sentence, never the explanation field of the snapshot", () => {
  const s = structuredClone(SCENARIOS[0]);
  const MARK = "ZZ-MODEL-TEXT-ZZ";
  for (const st of s.steps) for (const c of st.causes) if (c.cause.status === "proposed") c.cause.explanation = MARK;
  const story = storyOfScenario(s, "x");
  assert.ok(!textOf(story).includes(MARK));
  assert.match(story.why.body.map(richText).join(" "), /answers PayPal before the booking work is finished/);
});

test("chapter 4: the good build and the bad build on the same real events, and the verdict", () => {
  const r = (s: Story) => s.panel.replay!;
  assert.equal(r(A).title, "The 2 real signed events");
  assert.deepEqual([r(A).good.statuses, r(A).bad.statuses], [[200, 200], [200, 200]]);
  assert.equal(richText(r(A).bad.books), "Have no entry, nothing was booked");
  assert.equal(A.replay.h, "Same messages, two builds. Only one saves them.");
  assert.equal(richText(r(B).bad.books), "Say Paid $48.00");
  assert.equal(r(B).sub, "Sent to both builds in the order they arrived: refund, payment");
  for (const s of [C, E]) {
    assert.deepEqual([r(s).good.statuses, r(s).bad.statuses], [[200, 200], [401, 401]], s.id);
    assert.equal(s.replay.h, "Same messages, two builds. Only one accepts them.", s.id);
  }
  for (const s of coded) {
    assert.equal(r(s).verdict.text, "Confirmed by replay");
    assert.equal(r(s).bad.planted, true);
    assert.equal(r(s).good.planted, false);
  }
});

test("the recorded setting bug: the AI abstained, so chapter 3 claims no cause, chapter 4 has no replay, and the gap stands without the AI", () => {
  assert.equal(D.why.h, "The cause is not proven.");
  assert.deepEqual(D.why.body.map(richText), ["The AI found no changed line that explains this gap.", "The gap stands on its own: it does not depend on the AI. Nothing about its cause is claimed."]);
  const shop = D.panel.stations[2];
  assert.equal(shop.layers.find((l) => l.code), undefined, "no code block: no line is cited");
  assert.deepEqual(shop.layers.filter((l) => l.on.includes("3")).flatMap((l) => l.variants.flatMap((v) => v.lines.map((x) => richText(x.rich)))), ["Cause not proven", "The gap still stands"]);
  assert.equal(D.panel.replay, null);
  assert.equal(D.panel.available[4], false);
  assert.equal(D.fix.h, "Fixing the setting does not rewrite the books. Only another delivery of the same event can.");
  assert.equal((D.fix.body.map(richText).join(" ").match(/planted by us/g) ?? []).length, 1);
  assert.ok(D.certGreen, "both rows tied again after the ring (recorded)");
  for (const cert of [D.cert.before, D.cert.after]) assert.doesNotMatch([cert.focal, cert.lead, ...cert.checks.map((c) => richText(c.rich))].join(" "), /\bAI\b|replay/);
});

// ---- chapter 5: the fix is deployed --------------------------------------------------------------------------------------------------------

test("chapter 5 closes the logic hole: the fix is in, the books still say paid, and only a new delivery can change them", () => {
  for (const s of coded) {
    // the insight leads; the text names who deploys the fix and does not say the insight again
    assert.equal(s.fix.h, "Fixing the code does not rewrite the books. Only another delivery of the same event can.");
    const t = s.fix.body.map(richText).join(" ");
    assert.doesNotMatch(t, /Fixing the code does not rewrite the books/);
    // with a proven patch beside it, the demo's switch is said as what it is: the last good build, not Claude's patch
    const what = proven.includes(s) ? "last good build" : "fixed handler";
    assert.match(t, new RegExp(`^The shop's developer deploys the ${what}\\. The shop now runs good\\.ts instead of [a-z-]+\\.ts, planted by us\\.`), s.id);
    assert.equal((t.match(/planted by us/g) ?? []).length, 1, `${s.id}: said once in the chapter`);
    assert.match(t, /the books still differ from PayPal on two captures/);
  }
  assert.match(A.fix.body.map(richText).join(" "), /PayPal got its 200 and stopped trying/);
  assert.match(B.fix.body.map(richText).join(" "), /the late payment already overwrote the refund/);
  for (const s of [C, E]) assert.match(s.fix.body.map(richText).join(" "), /PayPal gave up after its last try/, s.id);
});

test("chapter 5 reads the fix from the second step: the rows after the fix are the rows before it", () => {
  for (const sc of SCENARIOS) {
    const rows = (st: RunSnapshot) => st.scan!.rows.map((r) => [r.n, r.status, r.book?.state]);
    assert.deepEqual(rows(sc.steps[1]), rows(sc.steps[0]), `${sc.id}: the fix changes no book`);
    assert.equal(sc.steps[1].session.session.planted, false);
    assert.equal(sc.steps[1].session.session.file, "handlers/good.ts");
  }
  for (const s of stories) {
    assert.deepEqual(s.panel.ledger.filter((r) => r.n !== 1).map((r) => r.start.kind), ["gap", "gap"], s.id);
    assert.equal(s.panel.fixedFile, "handlers/good.ts");
  }
});

// ---- chapter 5: the patch Claude proposed, and the proof behind it ----------------------------------------------------------------------------

const proofOf = (s: Story) => s.fix.proof!;
// Which of the five planted-bug scenarios carry a proof today. resend_not_delivered is the 10-19 recording of the 401 bug, from before the fix existed:
// it has none. This table is the one place to change when a recording is made again with one.
const HAS_PROOF: Record<string, boolean> = { refund_never_booked: true, late_payment_overwrites: true, signature_rejected: true, resend_not_delivered: false, cause_not_in_code: false };
const FIX_CHECK_LINE = "Claude's proposed patch passed 5 code checks. Replayed on 15 signed events, it behaved like the shop's last good build and PayPal's answer.";
const FIX_CANNOT_LINE = "The proposed patch's comments and leftover code are not checked.";

test("a proposed fix is told only where the recording carries a proven one beside a replay-confirmed cause: today the first three scenarios", () => {
  for (const [id, want] of Object.entries(HAS_PROOF)) {
    assert.equal(!!byId(id).fix.proof, want, id);
    assert.equal(!!byId(id).phone.c5.proof, want, `${id}: the phone tells the same`);
  }
  assert.deepEqual(proven.map((s) => s.id), Object.entries(HAS_PROOF).filter(([, v]) => v).map(([k]) => k));
  // the wide column and the phone tell it in the same words
  for (const s of proven) {
    const text = (p: NonNullable<Story["fix"]["proof"]>) => [p.proposed, p.note, richText(p.lede), richText(p.verdict), p.verdictNote, ...p.checks.map((c) => richText(c.rich)), ...p.controls.map((c) => `${richText(c.rich)} ${c.n}`), richText(p.leftovers), p.baseline ? richText(p.baseline) : "", richText(p.deployed), p.basis];
    assert.deepEqual(text(s.phone.c5.proof!), text(proofOf(s)), s.id);
    assert.deepEqual(s.phone.c5.proof!.hunks, proofOf(s).hunks, s.id);
  }
});

test("the proof is labelled Proposed by Claude and not deployed, and says only what was run: the real numbers, never 'correct'", () => {
  for (const s of [A, B, C]) {
    const p = proofOf(s);
    assert.equal(p.proposed, "Proposed by Claude");
    assert.equal(p.note, "not deployed in this demo");
    assert.equal(richText(p.verdict), "Behaves like the shop's last good build and PayPal's answer on these 15 inputs.");
    assert.equal(p.verdictNote, "The 15 inputs are 5 deliveries from 3 orders, run three ways: in arrival order, reversed, and with one amount changed.");
    assert.equal(richText(p.lede), "Claude also proposed a patch for the cited lines. Plain code checked it first. Then it was run on real signed events and compared with the shop's last good build and with PayPal's own answer.");
    assert.deepEqual(p.checks.map((c) => [c.done, richText(c.rich)]), Object.values(CHECK_LABEL).map((l) => [true, l]));
    assert.deepEqual(p.controls.map((c) => [c.done, richText(c.rich), c.n]), Object.values(CONTROL_LABEL).map((l, i) => [true, l, ["5 deliveries", "5 deliveries", "5 deliveries", "6 comparisons"][i]]));
    assert.equal(richText(p.baseline!), "The same patch with its signature check removed (written by us) fails the tampered control and passes the other three.");
    assert.equal(richText(p.deployed), "The demo does not run this patch. It runs good.ts, the shop's last good build, which the patch matches on these 15 inputs.");
    const all = [p.proposed, p.note, richText(p.lede), richText(p.verdict), p.verdictNote, richText(p.leftovers), richText(p.deployed), p.basis, p.legend ?? ""].join(" ");
    assert.doesNotMatch(all, /\b(correct|proved|proves|guarantee|safe)\b/i, s.id);
    for (const w of FORBIDDEN_WORDS) assert.ok(!all.toLowerCase().includes(w), `${s.id}: "${w}"`);
  }
  // when the controls ran, and where the edits come from
  assert.equal(proofOf(A).basis, "The comparison ran at 10:43:12 UTC, on this run's own signed events. The edits are a stored recording from claude-sonnet-5-5; this page makes no model call.");
  assert.equal(proofOf(B).basis, "The comparison ran at 10:45:14 UTC, on this run's own signed events. The edits are a stored recording from claude-sonnet-5-5; this page makes no model call.");
  assert.equal(proofOf(C).basis, "The comparison ran at 11:57:30 UTC, on this run's own signed events. The edits are a stored recording from claude-sonnet-5-5; this page makes no model call.");
});

test("what the patch leaves behind is computed from the patched file, and said in one line with what the checks cannot see", () => {
  assert.equal(richText(proofOf(A).leftovers), `Compared with the shop's last good build, the patch still has: a comment that may no longer match the code; \u201cqueue\u201d, a value nothing reads. ${CANNOT_SEE}`);
  assert.equal(richText(proofOf(B).leftovers), `Compared with the shop's last good build, the patch still has: the imports written differently, naming the same things. ${CANNOT_SEE}`);
  assert.equal(richText(proofOf(C).leftovers), `Compared with the shop's last good build, the patch still has: \u201ccanonical\u201d, a function nothing calls. ${CANNOT_SEE}`);
  // an older result has no leftovers: the line then says only what the checks cannot see, and claims nothing about the file
  const sc = structuredClone(SCENARIOS[0]);
  for (const c of sc.steps[0].causes) delete c.fix!.leftovers;
  assert.equal(richText(storyOfScenario(sc, "x").fix.proof!.leftovers), CANNOT_SEE);
});

test("the diff is the reviewed patch line for line, and the lines the AI cited wear the highlighter", () => {
  const results = readResults();
  const reviewed = readReviewed();
  const marked = (s: Story) => proofOf(s).hunks.flat().filter((l) => l.cited).map((l) => `${l.kind} ${l.text.trim()}`);
  for (const [s, mode] of [[A, "ack_then_drop"], [B, "last_write_wins"], [C, "bad_body"]] as const) {
    const shown = proofOf(s).hunks.map((h) => h.map((l) => ({ kind: l.kind, text: l.text })));
    assert.deepEqual(shown, results[mode]!.patch!.hunks, `${s.id}: what the screen shows is the patch in fixtures/fix/results.json`);
    const sha = SCENARIOS.find((x) => x.id === s.id)!.steps[0].causes[0].fix!.patchSha256;
    assert.equal(sha, results[mode]!.patchSha256, s.id);
    assert.equal(sha256(readPatched(mode)!), sha, `${s.id}: the patched file on disk is the one that was proven`);
    assert.equal(reviewed[mode], sha, `${s.id}: and the owner reviewed that file`);
  }
  assert.deepEqual(marked(A), ["add await ctx.books.set(booking.captureId, { state: booking.state, amount: booking.amount, eid: event.id, at: ctx.now() });", "del queue.push(event);"]);
  assert.deepEqual(marked(B), ["add const current = await ctx.books.get(booking.captureId);", "add if (current && rank(current.state) > rank(booking.state)) return { status: 200 };"]);
  assert.deepEqual(marked(C), ["del const event = canonical(JSON.parse(ctx.rawBody));"]);
  // the legend counts the cited lines it highlights: two in A and B, one in C
  for (const s of proven) assert.equal(proofOf(s).legend, `Highlighted: ${marked(s).length === 1 ? "the line" : "the lines"} the AI cited as the cause.`, s.id);
  assert.deepEqual(proven.map((s) => marked(s).length), [2, 2, 1]);
  // two hunks, with a skip between them; the diff has the bad deploy's lines and the patched file's, and no line of a file name
  assert.deepEqual(proofOf(A).hunks.map((h) => h.length), [4, 14]);
  assert.deepEqual(proofOf(B).hunks.map((h) => h.length), [5, 8]);
  assert.deepEqual(proofOf(C).hunks.map((h) => h.length), [6]);
  assert.ok(!textOf(A).includes("ack-drop.ts:") && !JSON.stringify(proofOf(A).hunks).includes("handlers/"));
});

test("the wide page prints the patch under chapter 5: every line of the diff, the highlighter on the cited ones, then the verdict and the details; a story without one prints none", () => {
  const chapter5 = (html: string): string => html.slice(html.indexOf('id="c5"'), html.indexOf('id="c6"'));
  stories.forEach((s, i) => {
    const html = chapter5(renderStory(stories, i, "wide"));
    const p = s.fix.proof;
    if (!p) {
      assert.ok(!html.includes("fx-") && !allText(html).includes("Proposed by Claude"), `${s.id}: no patch, none printed`);
      return;
    }
    const lines = p.hunks.flat();
    assert.equal((html.match(/class="fx-l /g) ?? []).length, lines.length, `${s.id}: every line of the diff`);
    assert.equal((html.match(/class="fx-l [a-z]+ hit"/g) ?? []).length, lines.filter((l) => l.cited).length, `${s.id}: the cited lines`);
    assert.equal((html.match(/<mark class="cited">/g) ?? []).length, lines.filter((l) => l.cited).length, s.id);
    assert.equal((html.match(/class="fx-skip"/g) ?? []).length, p.hunks.length - 1, `${s.id}: a skip between two hunks`);
    const text = allText(html);
    // the order a reader meets it: the paragraphs, what stands behind the patch, the label, the verdict, the checks, the controls, the leftovers, what the demo deployed
    const at = ["deploys the last good build", "Claude also proposed a patch", "Proposed by Claude", "Behaves like the shop's last good build", "What the code checked", "What the replay compared", "fails the tampered control", "the patch still has", "The demo does not run this patch", "this page makes no model call"].map((t) => text.indexOf(t));
    assert.ok(at.every((n) => n >= 0), `${s.id}: ${at}`);
    assert.deepEqual([...at].sort((a, b) => a - b), at, s.id);
    assert.ok(!html.includes("pc-ba"), s.id);
  });
});

test("chapter 5 says what the demo did: it switched to the last good build, and the patch is a separate proposal", () => {
  for (const s of proven) {
    assert.match(s.fix.body.map(richText).join(" "), /^The shop's developer deploys the last good build\. The shop now runs good\.ts instead of [a-z-]+\.ts, planted by us\./, s.id);
    assert.doesNotMatch(s.fix.body.map(richText).join(" "), /fixed handler/, s.id);
    assert.equal(richText(s.panel.stations[2].layers.find((l) => l.on.includes("5"))!.variants[0].lines[0].rich), "Now runs good.ts, the last good build");
    assert.equal(s.panel.stations[2].glance["5"], "Good build", `${s.id}: the phone's strip does not call the shop fixed by a patch that was not deployed`);
    assert.equal(s.fix.h, "Fixing the code does not rewrite the books. Only another delivery of the same event can.", "the insight stays first");
    // the chapter says it once, in its text (the earlier test); the proof adds no second place, and does not name the planted file at all
    assert.equal((JSON.stringify(proofOf(s)).match(/planted by us|ack-drop|last-write-wins|bad-body/g) ?? []).length, 0, s.id);
  }
  // no proven fix (the setting bug has none, and resend_not_delivered's 10-19 recording has none): the chapter is told as it always was
  for (const s of coded.filter((x) => !proven.includes(x))) {
    assert.match(s.fix.body.map(richText).join(" "), /^The shop's developer deploys the fixed handler\. The shop now runs good\.ts instead of [a-z-]+\.ts, planted by us\./, s.id);
    assert.equal(richText(s.panel.stations[2].layers.find((l) => l.on.includes("5"))!.variants[0].lines[0].rich), "Now runs good.ts, the fixed handler", s.id);
    assert.equal(s.panel.stations[2].glance["5"], "Fixed", s.id);
  }
});

test("a patch is shown only when it may be: the fix proven, for this cause, beside a cause that the replay confirmed", () => {
  const without = (edit: (sc: ReturnType<typeof structuredClone<(typeof SCENARIOS)[number]>>) => void): Story => {
    const sc = structuredClone(SCENARIOS[0]);
    edit(sc);
    return storyOfScenario(sc, "x");
  };
  const causes = (sc: (typeof SCENARIOS)[number]) => sc.steps[0].causes;
  assert.ok(proofOf(A));
  // not proven: the recorded result says so and carries no patch
  const unproven = without((sc) => causes(sc).forEach((c) => Object.assign(c.fix!, { verdict: "not_proven", patch: null, baseline: null, claim: "Fix not proven." })));
  // another cause: the diff or the cause recording changed since
  const other = without((sc) => causes(sc).forEach((c) => (c.fix!.causeRequestHash = "0".repeat(64))));
  // the replay no longer confirms the cause (its category is switched to the one the planted mode does not predict)
  const unconfirmed = without((sc) => causes(sc).forEach((c) => c.cause.status === "proposed" && (c.cause.category = "OTHER_CODE_CHANGE")));
  const none = without((sc) => causes(sc).forEach((c) => delete c.fix));
  for (const [name, s] of Object.entries({ unproven, other, unconfirmed, none })) {
    assert.ok(!s.fix.proof, name);
    assert.ok(!s.phone.c5.proof, name);
    assert.ok(s.phone.c5.change, `${name}: the before and now take its place`);
    assert.match(s.fix.body.map(richText).join(" "), /deploys the fixed handler/, name);
    assert.ok(!s.cert.after.checks.some((c) => /proposed patch/.test(richText(c.rich))), `${name}: no check line`);
    assert.ok(!s.cert.after.cannot.some((c) => richText(c) === FIX_CANNOT_LINE), `${name}: no cannot line`);
    assert.ok(!textOf(s).includes("Proposed by Claude"), name);
  }
});

test("the certificate has a check line for a proven fix and says that comments and leftover code are not checked; a run without one has neither", () => {
  for (const s of proven) {
    for (const v of [s.cert.before, s.cert.after]) {
      assert.equal(v.checks.filter((c) => /proposed patch/.test(richText(c.rich))).length, 1, s.id);
      assert.ok(v.checks.some((c) => c.done && richText(c.rich) === FIX_CHECK_LINE), s.id);
      const lines = v.cannot.map(richText);
      assert.equal(lines.filter((l) => l === FIX_CANNOT_LINE).length, 1, s.id);
      assert.match(lines[lines.length - 1], /This certificate is not signed/);
      assert.equal(lines[lines.length - 2], FIX_CANNOT_LINE, "just before the line that says the certificate is not signed");
    }
  }
  for (const s of stories.filter((x) => !x.fix.proof)) {
    const all = [s.cert.before, s.cert.after].flatMap((v) => [...v.cannot.map(richText), ...v.checks.map((c) => richText(c.rich))]);
    assert.ok(!all.some((l) => /proposed patch|leftover code/.test(l)), s.id);
  }
  assert.ok(stories.some((s) => !s.fix.proof), "the setting bug has none, and is held to this");
  // the check line says when it ran: a result recorded earlier is not called a replay of this run's own events
  const sc = structuredClone(SCENARIOS[0]);
  for (const c of sc.steps[0].causes) c.fix!.basis = "recorded";
  const later = storyOfScenario(sc, "x");
  assert.ok(later.cert.after.checks.some((c) => richText(c.rich) === "Claude's proposed patch passed 5 code checks. Replayed on 15 signed events earlier, it behaved like the shop's last good build and PayPal's answer."));
  assert.match(later.fix.proof!.basis, /^This is a recorded result: the comparison ran on 2026-10-20 10:43 UTC, on earlier signed events\./);
});

// ---- chapter 6: Ring again, from the heal data ---------------------------------------------------------------------------------------------

const heals = (s: Story) => s.panel.ledger.filter((r) => r.ring).map((r) => r.ring!);

test("Ring again is read from the heal data: the sends, the waits between them and the arrival", () => {
  // 10-20 recording: order #2's resend was accepted three times and the third one arrived; order #3's first one arrived
  const a = heals(A);
  assert.deepEqual(a.map((r) => [r.n, r.sends, r.waitsSec, r.arrivalSeconds, r.end]), [[2, 3, [66, 66], 2.2, "tied"], [3, 1, [], 3.3, "tied"]]);
  assert.equal(a[1].arrivedAt! - a[1].sentAt[0], 3253); // 10:44:00.351 -> 10:44:03.604: the 3.3 s on the screen
  assert.equal(a[0].arrivedAt! - a[0].sentAt[2], 2170); // 10:45:54.117 -> 10:45:56.287: the 2.2 s of the third resend
  const b = heals(B);
  assert.deepEqual(b.map((r) => [r.n, r.sends, r.arrivalSeconds, r.end]), [[2, 1, 3, "tied"], [3, 1, 2.5, "tied"]]);
  // 10-20 recording of the 401 bug: order #2 needed 2 resends (63 s apart), order #3 needed 3 (64 s and 64 s apart), and both arrived
  const c = heals(C);
  assert.deepEqual(c.map((r) => [r.n, r.sends, r.waitsSec, r.arrivalSeconds, r.end]), [[2, 2, [63], 3.2, "tied"], [3, 3, [64, 64], 2.9, "tied"]]);
  assert.equal(c[0].arrivedAt! - c[0].sentAt[1], 3229); // 11:58:39.755 -> 11:58:42.984: the 3.2 s of order #2's second resend
  assert.equal(c[1].arrivedAt! - c[1].sentAt[2], 2877); // 11:59:44.647 -> 11:59:47.524: the 2.9 s of order #3's third resend
  // 10-19 recording of the same bug: order #2's resend was accepted three times and the third arrived; order #3's two were accepted and none arrived
  const e = heals(E);
  assert.deepEqual(e.map((r) => [r.n, r.sends, r.waitsSec, r.arrivalSeconds, r.end]), [[2, 3, [64, 62], 2.9, "tied"], [3, 2, [64], null, "open"]]);
  assert.equal(e[1].arrivedAt, null);
  assert.equal(RESEND_WINDOW_S, ARRIVAL_WAIT_MS / 1000);
});

test("resend_not_delivered ends honestly: one row tied, the other 'Resend accepted, not delivered' and still a gap", () => {
  const row3 = E.panel.ledger.find((r) => r.n === 3)!;
  assert.equal(row3.end.kind, "gap");
  assert.match(row3.end.note!, /^Resend accepted, not delivered\./);
  assert.match(row3.end.note!, /Resend limit reached \(5 per session\)/);
  assert.doesNotMatch(row3.end.note!, /waiting for it to arrive/);
  assert.match(E.ring.result, /Order #3: Resend accepted, not delivered\. The gap stays open\./);
  assert.doesNotMatch(E.ring.result, /waiting for it to arrive/);
  const row2 = E.panel.ledger.find((r) => r.n === 2)!;
  assert.equal(row2.end.kind, "tied");
  assert.equal(E.ring.hAfter, "Order #2 now says refunded. Order #3 is still open.");
  assert.equal(E.certGreen, false);
  // the last beat of the script says it, and the final view holds it
  const beats = ringBeats(E.panel.ledger, 2, E.ring.result);
  const end = beats.reduce((v, b) => applyBeat(v, b), IDLE_RING);
  assert.equal(end.stage, "done");
  assert.equal(end.rows[3].state, "open");
  assert.match(end.rows[3].note, /Resend accepted, not delivered/);
  assert.equal(end.rows[2].state, "tied");
  assert.match(finalRing(E.panel.ledger, 2, E.ring.result).rows[3].note, /Resend accepted, not delivered/);
});

test("signature_rejected (10-20) ends with both rows tied, each by the resend that arrived, and says nothing about a resend that did not", () => {
  const row = (n: number) => C.panel.ledger.find((r) => r.n === n)!;
  assert.deepEqual([row(2).end.kind, row(3).end.kind], ["tied", "tied"]);
  assert.equal(row(2).end.note, "Needed 2 resends. The last arrived 3.2 s after it was accepted.");
  assert.equal(row(3).end.note, "Needed 3 resends. The last arrived 2.9 s after it was accepted.");
  assert.equal(C.ring.result, "Order #2 needed 2 resends; the last arrived 3.2 s after PayPal accepted it, and the books now say refunded. Order #3 needed 3 resends; the last arrived 2.9 s after PayPal accepted it, and the books now say refunded.");
  assert.doesNotMatch(C.ring.result, /not delivered|stays open|waiting for it to arrive/);
  assert.equal(C.ring.hAfter, "The books now say refunded.");
  assert.equal(C.certGreen, true);
  const beats = ringBeats(C.panel.ledger, 2, C.ring.result);
  const end = beats.reduce((v, b) => applyBeat(v, b), IDLE_RING);
  assert.equal(end.stage, "done");
  assert.deepEqual([end.rows[2].state, end.rows[3].state], ["tied", "tied"]);
  assert.equal(end.announce, C.ring.result);
});

test("the ring script plays the real arrival time, shortens only the long waits, and says so in small text", () => {
  for (const s of stories) {
    const beats = ringBeats(s.panel.ledger, s.panel.subject!.n, s.ring.result);
    assert.ok(beats.length > 0);
    assert.ok(totalMs(beats) < 20_000, `${s.id}: ${totalMs(beats)} ms`);
    assert.ok(beats.every((b) => b.after <= 4600), `${s.id}: no single wait is long`);
    const end = beats.reduce((v, b) => applyBeat(v, b), IDLE_RING);
    assert.equal(end.stage, "done");
    assert.equal(end.announce, s.ring.result);
    const fin = finalRing(s.panel.ledger, s.panel.subject!.n, s.ring.result);
    assert.deepEqual(end.rows, fin.rows, `${s.id}: the script ends where reduced motion starts`);
    assert.equal(end.phase, fin.phase);
  }
  // the arrival of the focused row is played at its real length: B's single resend took 3.0 s, A's third resend of order #2 2.2 s; the two resends of A that
  // were accepted and not delivered in time travel only halfway
  const travels = (s: Story) => ringBeats(s.panel.ledger, 2, "").flatMap((b) => (b.patch.phase === "sent" ? [b.patch.travel] : []));
  assert.deepEqual(travels(B)[0], { to: "shop", ms: 3000 });
  assert.deepEqual(travels(A).slice(0, 3), [{ to: "half", ms: 1100 }, { to: "half", ms: 1100 }, { to: "shop", ms: 2200 }]);
  assert.ok(ASK_MS < 1000);
  // one short plain sentence, and the exact shortened waits in a second line
  assert.equal(A.ring.note, "A replay of the real resend from Oct 20, 2026, sped up. Nothing is sent to PayPal.");
  assert.match(A.ring.noteDetail!, /^Each wait was cut to about a second: order #2's 66 s and 66 s between resends, the 19 s before order #3's first resend\.$/);
  assert.equal(B.ring.note, "A replay of the real resend from Oct 20, 2026. Nothing is sent to PayPal.", "nothing in this ring was longer than 5 s, so it is not called sped up");
  assert.equal(B.ring.noteDetail, null);
  assert.match(E.ring.noteDetail!, /order #2's 64 s and 62 s between resends/);
  // the 10-20 recording of the 401 bug: order #2's first resend was accepted and not delivered in time (half way), its second arrived in 3.2 s
  assert.deepEqual(travels(C), [{ to: "half", ms: 1100 }, { to: "shop", ms: 3200 }]);
  assert.equal(C.ring.note, "A replay of the real resend from Oct 20, 2026, sped up. Nothing is sent to PayPal.");
  assert.equal(C.ring.noteDetail, "Each wait was cut to about a second: order #2's 63 s between resends, order #3's 64 s and 64 s between resends.");
});

test("the books slide only for a row the ring changed, and the heading follows the focused row", () => {
  for (const s of [A, B, C]) {
    assert.equal(s.ring.hAfter, "The books now say refunded.");
    assert.ok(s.panel.ledger.filter((r) => r.ring).every((r) => r.start.books === "Paid $48.00" && r.end.books === "Refunded $48.00"));
  }
  // resend_not_delivered ends with order #3 still open: the heading must not speak for the whole run.
  assert.equal(E.ring.hAfter, "Order #2 now says refunded. Order #3 is still open.");
});

test("the Ring again headings are honest at each moment: not the first headline's words, and 'the books now say' only when every rung row is tied", () => {
  for (const s of stories) {
    // before: what the chapter does, not the first chapter's headline again
    assert.equal(s.ring.hBefore, "Ask PayPal to send it again.");
    assert.notEqual(s.ring.hBefore, s.focal.h);
    assert.ok(!s.ring.hBefore.includes("Your books still say"), s.id);
    // during: the focused row is tied while another is still ringing, so the heading says that and does not speak for the books as a whole
    assert.equal(s.ring.hDuring, "Order #2 now says refunded. Order #3 is still ringing.", s.id);
    assert.doesNotMatch(s.ring.hDuring, /The books now say/, s.id);
  }
  // after: the whole claim only when nothing is left open
  for (const s of [A, B, C]) assert.equal(s.ring.hAfter, "The books now say refunded.", s.id);
  assert.doesNotMatch(E.ring.hAfter, /The books now say/);
  assert.match(E.ring.hAfter, /Order #3 is still open\./);
  // a ring of one row has no other row to be ringing: during is after
  const one = structuredClone(SCENARIOS[0]);
  const last = one.steps[one.steps.length - 1];
  for (const r of last.scan!.rows) if (r.n === 3) for (const e of r.events) e.heal = null;
  const solo = storyOfScenario(one, "x");
  assert.equal(solo.ring.hDuring, solo.ring.hAfter);
  assert.equal(solo.ring.hAfter, "The books now say refunded.");
});

// ---- chapter 7: the certificate -------------------------------------------------------------------------------------------------------------

test("chapter 7 puts what cannot be proven first, and the last line says the certificate is not signed", () => {
  for (const s of stories) {
    for (const v of [s.cert.before, s.cert.after]) {
      const lines = v.cannot.map(richText);
      assert.match(lines[lines.length - 1], /This certificate is not signed/);
      assert.ok(lines.length >= 4);
    }
    assert.match(richText(s.cert.before.cannot[0]), /event-list lag|never captured/);
  }
  // the line about rows that PayPal's own retry closed follows the first line, and only the recording that has such a row has it (C's order #1)
  for (const s of stories) {
    for (const v of [s.cert.before, s.cert.after]) {
      const at = v.cannot.map(richText).flatMap((t, i) => (t.includes("booked on PayPal's own retry") ? [i] : []));
      assert.deepEqual(at, s.id === "signature_rejected" ? [1] : [], s.id);
    }
  }
  assert.match(richText(C.cert.after.cannot[1]), /^1 capture was booked on PayPal's own retry, after the shop did not take the earlier try; this record does not show why, or whether the shop's code changed in between\.$/);
  // the certificate says what the record shows about the row, never who did what: that is the live lane's to say, from its own memory
  for (const v of [C.cert.before, C.cert.after]) assert.doesNotMatch([v.focal, v.lead, ...v.cannot.map(richText), ...v.checks.map((c) => richText(c.rich))].join("\n"), /sent nothing|after the fix|self-healed|recovered|Doorbell (?:fixed|healed) it|the gap Doorbell found/i);
  assert.equal(A.cert.before.stamp, "red");
  assert.equal(A.cert.after.stamp, "green");
  // the headline says what was found, before and after the ring, with the real numbers of each step; coverage is not the headline
  for (const s of stories) {
    assert.equal(s.cert.before.focal, "2 of 3 captures did not match PayPal.");
    assert.equal(s.cert.before.lead, s.id === "signature_rejected" ? "$96.00 across 2 refunds not in books. 1 booked on PayPal's own retry." : "$96.00 across 2 refunds not in books.");
  }
  assert.equal(A.cert.after.focal, "2 gaps found · 2 healed · 0 still open.");
  assert.equal(A.cert.after.lead, "Tied on 3/3 of what we can see.", "one 3/3 after the ring, not two");
  assert.ok(!A.cert.after.focal.includes("3 of 3") && !A.cert.after.focal.includes("100%"));
  assert.equal(E.cert.after.stamp, "red");
  assert.equal(E.cert.after.focal, "2 gaps found · 1 healed · 1 still open.");
  assert.equal(E.cert.after.lead, "$48.00 across 1 refund not in books.");
  // the 10-20 recording of the same bug ties both rows, like A
  assert.equal(C.cert.after.stamp, "green");
  assert.equal(C.cert.after.focal, "2 gaps found · 2 healed · 0 still open.");
  assert.equal(C.cert.after.lead, "Tied on 3/3 of what we can see. 1 booked on PayPal's own retry.", "the qualifier stays, and the retry is a sentence of its own");
  assert.deepEqual(C.cert.after.checks.map((c) => c.done), [true, true, true, true, true]);
  assert.equal(richText(E.cert.after.checks[3].rich), "After the resend, the books match PayPal for 2 of 3 captures. The rest stay open.");
  // a scenario with no proven fix has the checks it always had: coverage, the cited line, the replay, the books after the resend (E, recorded before the fix existed)
  assert.ok(!E.fix.proof);
  assert.deepEqual(E.cert.after.checks.map((c) => c.done), [true, true, true, false]);
  // A has the fix check between the replay and the books after the resend: coverage, the cited line, the replay, the fix, the books
  assert.deepEqual(A.cert.after.checks.map((c) => c.done), [true, true, true, true, true]);
  assert.equal(A.cert.before.checks[4].done, false);
  assert.equal(richText(A.cert.before.checks[4].rich), "The resend has not run yet, so the gaps are still open.");
});

test("green is only the certificate's: the story knows it at the end of the run, and only when the stamp says green", () => {
  assert.deepEqual(stories.map((s) => s.certGreen), [true, true, true, false, true]);
  for (const s of stories) assert.equal(s.certGreen, SCENARIOS.find((x) => x.id === s.id)!.steps.at(-1)!.certificate!.stamp === "green");
});

test("the list of all captures has the run's rows, open while the gaps are open and final after the ring", () => {
  assert.deepEqual(A.captures.before.map((r) => r.result), ["Tied", "Gap", "Gap"]);
  assert.deepEqual(A.captures.after.map((r) => r.result), ["Tied", "Tied", "Tied"]);
  assert.deepEqual(C.captures.after.map((r) => [r.result, r.books]), [["Tied", "Paid $14.00"], ["Tied", "Refunded $48.00"], ["Tied", "Refunded $48.00"]]);
  assert.deepEqual(E.captures.after.map((r) => [r.result, r.books]), [["Tied", "Paid $14.00"], ["Tied", "Refunded $48.00"], ["Gap", "Paid $48.00"]]);
});

// ---- nothing that was not in the snapshot --------------------------------------------------------------------------------------------------

test("no product code is printed as a word (OUT_OF_ORDER, ACKED_BUT_NOT_APPLIED ...): the screens use plain words", () => {
  for (const s of stories) assert.doesNotMatch(textOf(s), /\b[A-Z]{2,}(?:_[A-Z]+)+\b/, s.id);
});

test("no sentence of five or more words is said twice in the story's text (the headline of the ring chapter counts at its start and at its end, not the moment between; the certificate counts once; the panel repeats its own lines on purpose)", () => {
  const words = (x: string): number => x.split(/\s+/).length;
  for (const s of stories) {
    const text = [
      s.focal.h, richText(s.focal.lead), ...s.focal.body.map(richText), s.focal.found ? richText(s.focal.found) : "", richText(s.focal.pitch),
      s.travel.h, ...s.travel.body.map(richText), s.why.h, ...s.why.body.map(richText), s.replay.h, ...s.replay.body.map(richText), s.fix.h, ...s.fix.body.map(richText),
      s.ring.hBefore, s.ring.hAfter, richText(s.ring.body), s.ring.note, s.ring.noteDetail ?? "", s.ring.result,
      s.cert.after.focal, s.cert.after.lead, ...s.cert.after.cannot.map(richText), ...s.cert.after.checks.map((c) => richText(c.rich)),
    ];
    const seen = new Map<string, number>();
    for (const t of text) for (const sentence of t.split(/(?<=[.!?])\s+/).map((x) => x.trim().replace(/[.!?]$/, "").toLowerCase())) if (words(sentence) >= 5) seen.set(sentence, (seen.get(sentence) ?? 0) + 1);
    assert.deepEqual([...seen].filter(([, n]) => n > 1).map(([k]) => k), [], s.id);
  }
});

test("no sentence of the story holds a forbidden word", () => {
  for (const s of stories) {
    const t = textOf(s).toLowerCase();
    for (const w of FORBIDDEN_WORDS) assert.ok(!t.includes(w), `${s.id}: "${w}"`);
  }
});

test("free text in the snapshots (a finding's why, an explanation, a title, a chip, an expectation) never reaches the story", () => {
  const MARK = "ZZ-FREE-TEXT-ZZ";
  for (const sc of SCENARIOS) {
    const c = structuredClone(sc);
    for (const st of c.steps) {
      if (st.step) st.step.title = MARK;
      for (const row of st.scan?.rows ?? []) for (const e of row.events) if (e.finding) e.finding.why = MARK;
      for (const g of st.causes) {
        if (g.cause.status === "proposed") g.cause.explanation = MARK;
        if (g.replay) g.replay.expectation = MARK;
        if (g.confirmation) g.confirmation.chip = MARK;
      }
      if (st.heartbeat) st.heartbeat.text = MARK;
    }
    const story = storyOfScenario(c, "x");
    assert.ok(!textOf(story).includes(MARK), sc.id);
    assert.deepEqual(textOf(story), textOf(storyOfScenario(sc, "x")), `${sc.id}: the story is the same without that text`);
  }
});

test("the story needs a gap to follow: a first step without one is refused with the scenario's name", () => {
  const sc = structuredClone(SCENARIOS[0]);
  for (const r of sc.steps[0].scan!.rows) for (const e of r.events) e.finding = null;
  for (const r of sc.steps[0].scan!.rows) r.status = "TIED";
  assert.throws(() => storyOfScenario(sc, "x"), /no event that the books are waiting for/);
  assert.equal(focusOf(sc.steps[0]), null);
  const two = { ...structuredClone(SCENARIOS[0]), steps: SCENARIOS[0].steps.slice(0, 2) };
  assert.throws(() => storyOfScenario(two, "x"), /has 2 steps/);
  assert.ok(buildStory);
});

// ---- the setting bug (the deploy changed a comment; a setting was wrong) -----------------------------------------------------------------
// The scenario's own recording is checked in scenario tests once it exists. These are about the story builder: the resend_not_delivered recording
// (the 10-19 one of the 401 bug) re-labelled as the setting bug, with the cause step's honest outcome (the AI found no changed line) and no replay.

function settingScenario(): ReturnType<typeof structuredClone<(typeof SCENARIOS)[number]>> {
  const sc = structuredClone(SCENARIOS.find((s) => s.id === "resend_not_delivered")!);
  sc.id = "cause_not_in_code";
  sc.plantedMode = "wrong_webhook_id_setting";
  for (const step of sc.steps) {
    if (step.session.session.mode !== "good") {
      step.session.session.mode = "wrong_webhook_id_setting";
      step.session.session.file = "handlers/tidy.ts";
    }
    step.causes = step.causes.map((c) => ({ captureId: c.captureId, mode: "wrong_webhook_id_setting" as const, cause: { promptVersion: "x", requestHash: "h", status: "not_proven" as const, reason: "model_abstained" as const, text: NOT_PROVEN_TEXT }, replay: null, confirmation: null }));
  }
  return sc;
}

test("the setting bug's story: the cause is not proven, there is no replay (tab off), and chapter 5 says the fix is the setting, who planted it, and names no file", () => {
  const story = storyOfScenario(settingScenario(), "Rejected after a settings change", { model: MODEL_ID });
  assert.equal(story.kind, "rejected", "the gap itself is told as before: the shop turned the message away");
  assert.equal(story.why.h, "The cause is not proven.");
  assert.deepEqual(story.why.body.map(richText), ["The AI found no changed line that explains this gap.", "The gap stands on its own: it does not depend on the AI. Nothing about its cause is claimed."]);
  assert.equal(story.panel.available[3], true);
  assert.equal(story.panel.available[4], false, "no replay: the tab is off");
  assert.equal(story.panel.replay, null);
  assert.equal(story.replay.h, "There is no replay for this gap.");
  assert.match(richText(story.replay.body[0]), /^A replay needs a cause that Doorbell can check/);

  assert.equal(story.fix.h, "Fixing the setting does not rewrite the books. Only another delivery of the same event can.");
  const fix = story.fix.body.map(richText).join(" ");
  assert.match(fix, /puts the shop's own webhook ID back/);
  assert.match(fix, /ID of another webhook on the same PayPal app\. That wrong ID was planted by us, and Doorbell did not find it\./);
  assert.match(fix, /A refund that arrives from now on is booked\./);
  assert.ok(!/\.ts|handler|deploys the fixed/i.test(fix), `no file and no 'fixed handler': "${fix}"`);
  assert.equal((fix.match(/planted by us/g) ?? []).length, 1, "a chapter says it once");

  const shop = story.panel.stations[2];
  assert.equal(richText(shop.layers.find((l) => l.on.includes("5"))!.variants[0].lines[0].rich), "Checks signatures against its own webhook ID again");
  const why = shop.layers.find((l) => l.on.includes("3"))!;
  assert.equal(why.code, undefined, "no code block and no chips: nothing is cited");
  // the station names the state only; the reason and "the gap stands on its own" are the chapter text's, said once on the screen
  assert.deepEqual(why.variants[0].lines.map((l) => richText(l.rich)), ["Cause not proven", "The gap still stands"]);
});

test("the setting bug's certificate has no line about the AI: those appear only for a proposed cause", () => {
  const story = storyOfScenario(settingScenario(), "x");
  for (const cert of [story.cert.before, story.cert.after]) {
    const t = [cert.focal, cert.lead, ...cert.cannot.map(richText), ...cert.checks.map((c) => richText(c.rich))].join("\n");
    assert.ok(!/\bAI\b|replay/i.test(t.replace(/^.*not signed.*$/gim, "")), `"${t.match(/.*\b(AI|replay)\b.*/i)?.[0]}"`);
  }
});

test("a story that is not the setting bug does not say 'setting' anywhere", () => {
  for (const s of stories.filter((x) => x.id !== "cause_not_in_code")) assert.ok(!/setting/i.test(textOf(s).replace(/Sandbox/g, "")), s.id);
});

test("the held-out numbers on the screen are the sealed H-a result file's (category right, runs averaged inside a case, as verdict.ts counts)", () => {
  const r = JSON.parse(readFileSync(join(ROOT, "eval/runs/sealed-ha/results+b2.json"), "utf8")) as { sealed: boolean; startedAt: string; perCase: { runs: { cat: boolean }[] }[] };
  assert.equal(r.sealed, true);
  const right = r.perCase.reduce((s, c) => s + c.runs.filter((x) => x.cat).length / c.runs.length, 0);
  assert.equal(HELD_OUT.cases, r.perCase.length);
  assert.equal(HELD_OUT.right, right);
  assert.equal(HELD_OUT.date, r.startedAt.slice(0, 10));
});
