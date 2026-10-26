// The live lane when a live scan finds a dispute nobody was listening for (S6): the lane tells it with the recorded dispute story's own sentences and panel,
// reads everything from the one newest scan, and never offers a ring, a replay or a fix that a dispute does not have. The seed /dev/live?state=dispute is the
// recorded run's third step as a live snapshot.
import { test } from "node:test";
import assert from "node:assert/strict";
import { certificateOf, rowsInsideListLag } from "../cert/cert.ts";
import { DISPUTE_SCENARIO } from "../run/recorded.ts";
import type { RunSnapshot } from "../run/snapshot.ts";
import { checkSnapshot } from "./check.ts";
import { FORBIDDEN_WORDS, HONESTY } from "./copy.ts";
import { utcTime } from "./format.ts";
import { disputeStoryOf, liveDisputePanel, liveDisputeRow, openDisputesOf } from "./dispute-story.ts";
import { liveChapter, livePanel, ringReadiness } from "./live.ts";
import { disputeSeed } from "./live-seeds.ts";
import { WAITING_PHRASE } from "./phrases.ts";
import { readable, renderLiveSeeded } from "./render-helpers.ts";
import { richText } from "./rich.ts";
import { allStories } from "./source.ts";
import type { ChapterNo } from "./story.ts";

const stories = allStories();
const story = stories.find((s) => s.id === "dispute_never_heard")!;
const squash = (s: string): string => s.replace(/\s+/g, "");
const steps = (html: string): string => html.slice(html.indexOf('class="narr steps-col"'), html.indexOf("<aside"));
const gapRows = (html: string): string => readable(html.match(/<div class="gap-rows">[\s\S]*?<div class="ring-line">/)![0]).text;
const ringLine = (html: string): string => html.match(/<div class="ring-line">[\s\S]*?<\/div>/)![0];
const rowOfDispute = (s: RunSnapshot) => s.scan!.rows.find((r) => (r.disputes ?? []).length > 0)!;
const text = (html: string): string => readable(html).text;

// the same dispute, not provable yet: the finding is not final and Ring again waits (the app's webhook list could not be read, or the window is still open)
function unverifiedSeed() {
  const seed = disputeSeed();
  const scan = seed.snap!.scan!;
  const row = rowOfDispute(seed.snap!);
  const d = row.disputes![0];
  d.status = "UNVERIFIED";
  d.webhooks = { shop: null, any: null };
  d.finding = { cls: "UNVERIFIED", final: false, why: "x", waiting: "absence_window", untilMs: scan.at + 120_000 };
  d.ring = { state: "wait", label: "Not provable yet", waitMs: 120_000 };
  row.status = "UNVERIFIED";
  scan.summary = { ...scan.summary, gaps: 0, unverified: 1 };
  seed.snap!.certificate = certificateOf(scan, { rowsInsideListLag: rowsInsideListLag(seed.snap!.session.orders, scan.at) });
  return seed;
}

// ---- the seed ------------------------------------------------------------------------------------------------------------------------------------

test("the dispute seed is a live snapshot that checkSnapshot accepts, with the certificate computed from its rows and the dispute counted in it", () => {
  const seed = disputeSeed();
  const snap = seed.snap!;
  assert.deepEqual(checkSnapshot(snap), []);
  assert.deepEqual([snap.mode, snap.recordedAt, snap.step], ["LIVE", null, null]);
  assert.deepEqual(snap.certificate, certificateOf(snap.scan!, { rowsInsideListLag: rowsInsideListLag(snap.session.orders, snap.scan!.at) }));
  assert.deepEqual(snap.certificate!.numbers.disputes, { open: 1, notInBooks: 1, unverified: 0, unsubscribed: 1, noWebhook: 1, moneyNotInBooks: "48.00", unreadable: 0 });
  assert.deepEqual([seed.diag, seed.fixed, seed.everPlanted], [null, null, false]);
  // it is the recording's third step, not an invented one
  assert.equal(rowOfDispute(snap).disputes![0].disputeId, rowOfDispute(DISPUTE_SCENARIO.steps[2]).disputes![0].disputeId);
  assert.equal(snap.causes.length, 0, "a dispute has no code to blame");
});

// ---- the panel -----------------------------------------------------------------------------------------------------------------------------------

test("the live panel follows the dispute: the recorded story's stations from one scan, with no replay, no fix chapter and a road that stays unlit", () => {
  const snap = disputeSeed().snap!;
  const { panel } = livePanel(snap, null, null);
  const recorded = story.panel;
  assert.deepEqual(panel.subject, { n: 2, label: "Order #2, gift set", amount: "$48.00", captureId: rowOfDispute(snap).captureId, eventWord: "dispute" });
  assert.deepEqual([panel.mode, panel.reach, panel.replay, panel.fixedFile, panel.badFile], ["live", 0, null, null, null]);
  assert.deepEqual(panel.available, { 1: true, 2: true, 3: true, 4: false, 5: false, 6: true, 7: true });
  assert.deepEqual(panel.ledger, recorded.ledger, "the ledger of the recorded story, row for row");
  assert.equal(panel.money, recorded.money);
  // chapters 1 to 3 say what the recorded story says; the one thing that differs is the time of the look: the newest scan, not the first that found it
  const lines = (p: typeof panel, key: string, ch: string): string[] => p.stations.find((s) => s.key === key)!.layers.filter((l) => l.on.includes(ch)).flatMap((l) => l.variants.flatMap((v) => v.lines.map((x) => richText(x.rich))));
  const scanAt = utcTime(snap.scan!.at);
  const asked = (s: string): string => s.replace(/at \d\d:\d\d:\d\d$/, `at ${scanAt}`);
  for (const key of ["paypal", "doorbell", "shop", "books"]) for (const ch of ["1", "2", "3"]) assert.deepEqual(lines(panel, key, ch), lines(recorded, key, ch).map(asked), `${key}, chapter ${ch}`);
  assert.equal(lines(panel, "doorbell", "2")[1], `Compared the books with PayPal at ${scanAt}`);
  // nothing for chapter 5 anywhere: no handler was switched and nothing looked again
  for (const st of panel.stations) assert.ok(st.layers.every((l) => !l.on.includes("5")), `${st.key}: a line for chapter 5`);
  // chapter 6: Ring again has nothing to send, and nothing was pressed
  assert.deepEqual(lines(panel, "paypal", "6"), ["Has no event to send again"]);
  assert.deepEqual(lines(panel, "doorbell", "6"), ["Cannot ring: it has no event to ask PayPal to send again"]);
  assert.deepEqual(lines(recorded, "doorbell", "6"), ["Pressed Ring again: it sent nothing"], "the recorded story still says what the real run did");
  // one scan is not "how long Doorbell took to find it"
  assert.equal(panel.stations[0].hop, null);
  assert.equal(recorded.stations[0].hop?.text, "About 39 s later, Doorbell asked");
  assert.equal(liveChapter(panel, snap), 2);
});

test("an event gap still comes first: the path follows it, and a dispute is followed only when there is no gap of an event left to follow", () => {
  const snap = disputeSeed().snap!;
  // a row of a refund that is not in the books, beside the dispute (the shape that checkSnapshot knows is not needed here: only which one the path follows)
  const mixed = structuredClone(snap);
  const other = mixed.scan!.rows.find((r) => r.n === 3)!;
  other.status = "GAP";
  other.events = [{ kind: "refunded", resourceId: "R1", eid: "WH-1", listed: true, listedAt: 1, d: null, s: [], noted: false, finding: { cls: "NO_REPORT", final: true, why: "x" }, heal: null, ring: { state: "ready", label: "Ring again" } } as never];
  assert.equal(livePanel(mixed, null, null).panel.subject!.n, 3, "the event gap");
  assert.equal(livePanel(snap, null, null).panel.subject!.n, 2, "the dispute, once there is no event gap");
  // the left column and the ring line count the dispute either way
  const r = ringReadiness(mixed);
  assert.deepEqual(r.ready, [other.captureId]);
  assert.match(r.reason!, /^Order #2: Nothing to resend: no webhook of this app subscribes to dispute events/);
});

// ---- the left column -----------------------------------------------------------------------------------------------------------------------------

test("the lane tells the dispute chapter by chapter with the recorded story's sentences, not new ones", () => {
  const html = renderLiveSeeded(stories, disputeSeed());
  const rows = squash(gapRows(html));
  // what happened, how it travelled, why (no AI was asked), no replay, the fix is a setting
  for (const s of [story.focal.h, story.travel.h, story.why.h, story.replay.h, story.fix.h]) assert.ok(rows.includes(squash(s)), s);
  assert.ok(rows.includes(squash(richText(story.why.body[1]).split(". The shop runs")[0] + ".")), "No AI was asked, because there was no code change to read.");
  assert.equal(story.focal.h, "PayPal lists a $48.00 dispute on order #2. Your books have none.");
  assert.match(gapRows(html), /No AI was asked, because there was no code change to read\./);
  // the order of the chapters
  const t = gapRows(html);
  const at = [story.focal.h, story.travel.h, story.why.h, story.replay.h, story.fix.h].map((s) => t.indexOf(s));
  assert.ok(at.every((i) => i >= 0) && at.every((i, k) => k === 0 || i > at[k - 1]), at.join(","));
  // the words that belong to a code bug are nowhere: no cause card, no "not proven", no proposed patch
  const all = text(steps(html));
  for (const never of ["The cause is not proven", "Cause not proven", "No cause was diagnosed", "Proposed by Claude", "Confirmed by replay", "AI receipt", "healed", "Healed"]) assert.ok(!all.includes(never), never);
});

test("Ring again is off and says why in the backend's own words, once; the panel and the left column agree that nothing can be rung", () => {
  const seed = disputeSeed();
  const html = renderLiveSeeded(stories, seed);
  assert.match(html, /class="vis(?: tabs)?" data-ch="2"/, "the lane opens on how the message travelled");
  const label = rowOfDispute(seed.snap!).disputes![0].ring!.label;
  assert.ok(label.startsWith("Nothing to resend: no webhook of this app subscribes to dispute events"));
  const btn = html.match(/<button type="button" class="btn(?:-quiet)?"[^>]*>Ring again<\/button>/)![0];
  assert.ok(btn.includes('disabled=""') && btn.includes('aria-describedby="ring-why"'), btn);
  assert.equal(text(ringLine(html)).split(label).length - 1, 1, "the reason, once, next to the button");
  assert.deepEqual(ringReadiness(seed.snap!), { ready: [], reason: label });
  const all = text(html);
  assert.ok(!/Ready to ask|Ready to ask PayPal|Does not list|Waiting for PayPal to list/.test(all), "no line of the panel says that a ring is possible or waits for a list");
  // whatever state the backend gives a dispute, nothing is ready, and no line of the panel (nor a word of the strip) says that a ring is possible
  for (const state of ["wait", "cannot_heal"] as const) {
    const s = structuredClone(seed.snap!);
    rowOfDispute(s).disputes![0].ring = { state, label: "x" };
    assert.deepEqual(ringReadiness(s).ready, [], state);
    const panelLines = livePanel(s, null, null).panel.stations.flatMap((st) => [...st.layers.flatMap((l) => l.variants.flatMap((v) => v.lines.map((x) => richText(x.rich)))), ...Object.values(st.glance)]);
    assert.ok(panelLines.length > 0 && !panelLines.some((l) => /Does not list|Ready to ask|^Ready$|Waiting for PayPal to list/.test(l)), state);
  }
});

test("the certificate leads with the dispute's number and money, and its cannot-prove list holds the dispute's own limits", () => {
  const seed = disputeSeed();
  const html = renderLiveSeeded(stories, seed);
  const t = text(html);
  assert.ok(t.includes("1 of 3 captures did not match PayPal. 1 open dispute on PayPal that the books do not show ($48.00)."), "the lead");
  assert.equal(story.cert.before.lead, "1 open dispute on PayPal that the books do not show ($48.00).", "the recorded story says the same");
  for (const limit of seed.snap!.certificate!.limits) assert.ok(t.includes(limit), limit);
  assert.match(t, /whether PayPal would have sent an event cannot be proven from here/);
  assert.ok(t.indexOf("First, what Doorbell cannot prove") > t.indexOf("1 open dispute on PayPal"), "cannot-prove after the lead");
});

test("a dispute that is not provable yet gets the fixed title and the waiting reason, no path, and a Ring again that waits", () => {
  const seed = unverifiedSeed();
  assert.deepEqual(checkSnapshot(seed.snap!), []);
  const [o] = openDisputesOf(seed.snap!);
  assert.equal(liveDisputePanel(seed.snap!), null, "this story cannot tell a dispute that is not provable yet");
  assert.equal(livePanel(seed.snap!, null, null).panel.subject, null);
  const w = liveDisputeRow(seed.snap!, o);
  assert.equal(w.title, "PayPal lists a $48.00 dispute on order #2. The shop's books have none.");
  assert.equal(w.detail, WAITING_PHRASE.absence_window);
  assert.equal(w.cause, null);
  const html = renderLiveSeeded(stories, seed);
  const rows = gapRows(html);
  assert.ok(rows.includes(w.title) && rows.includes(w.detail!), rows);
  for (const never of ["No AI was asked", "There is no replay", "The fix is a setting"]) assert.ok(!rows.includes(never), never);
  assert.match(text(ringLine(html)), /Not provable yet\. Doorbell can say more in about 2 min\./);
});

// ---- the rules every screen obeys ----------------------------------------------------------------------------------------------------------------

test("no forbidden word and no claim of a closure on the dispute screen, and the honesty sentence is in the bar", () => {
  for (const [name, seed] of [["dispute", disputeSeed()], ["not provable yet", unverifiedSeed()]] as const) {
    for (const layout of ["wide", "narrow"] as const) {
      const html = renderLiveSeeded(stories, seed, layout);
      const t = text(html).toLowerCase();
      for (const w of FORBIDDEN_WORDS) assert.ok(!t.includes(w.toLowerCase()), `${name}, ${layout}: "${w}"`);
      assert.ok(text(html).includes(HONESTY), `${name}, ${layout}: the honesty sentence`);
      assert.equal(["Tied on 3/3", "all tied", "Healed", "now match"].filter((x) => text(html).includes(x)).length, 0, `${name}, ${layout}: the books are not said to match`);
    }
  }
});

test("the live variant leaves the recorded story as it was: its builder takes the recording and it keeps its chapter 5", () => {
  assert.doesNotThrow(() => disputeStoryOf(structuredClone(DISPUTE_SCENARIO), "x"));
  const chapters = [1, 2, 3, 4, 5, 6, 7] as ChapterNo[];
  assert.deepEqual(chapters.map((c) => story.panel.available[c]), [true, true, true, false, true, true, true], "the recorded story keeps its chapter 5");
});
