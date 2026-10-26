// The fifth story, "a dispute nobody heard" (Track UI-B), from the real recording fixtures/recorded-run/dispute_never_heard.json: the story is built from it and from
// nothing else, says only what the recording shows, has no AI card, no replay, no "healed" and no deploy, and passes the rules every screen obeys (forbidden words,
// the honesty sentence, the ten explained words, no sentence twice in a chapter, no horizontal overflow of the strip's words).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import CertificatePage from "../../app/certificate/page.tsx";
import { booksPhrase } from "../../app/_components/path-panel.tsx";
import { checkDisputeScenario } from "../run/check-disputes.ts";
import { ALL_RECORDED_SCENARIOS, DISPUTE_SCENARIO, RECORDED_SCENARIOS } from "../run/recorded.ts";
import type { RecordedDisputeScenario } from "../run/snapshot.ts";
import { checkSnapshot } from "./check.ts";
import { FORBIDDEN_WORDS, HONESTY } from "./copy.ts";
import { disputeStoryOf } from "./dispute-story.ts";
import { TERM_IDS, TERMS, type TermId } from "./glossary.ts";
import { allText, readable, renderStory } from "./render-helpers.ts";
import { IDLE_RING } from "./ring.ts";
import { richText } from "./rich.ts";
import { ALL_SCENARIOS, allStories, recordedStories, scenarioLabel } from "./source.ts";
import { CHAPTERS, tokensOf, type ChapterNo, type Story } from "./story.ts";
import { stripScene } from "./strip.ts";

const stories = allStories();
const di = stories.findIndex((s) => s.id === "dispute_never_heard");
const story = stories[di];
const sc = DISPUTE_SCENARIO;
const FIRST = sc.steps[0];
const DUE = sc.steps[2];
const END = sc.steps[3];
const DISPUTE = END.scan!.rows.find((r) => r.disputes?.length)!.disputes![0];
const CAPTURE = END.scan!.rows.find((r) => r.disputes?.length)!.captureId;

const hits = (text: string): string[] => FORBIDDEN_WORDS.filter((w) => text.toLowerCase().includes(w.toLowerCase()));
const strings = (v: unknown): string[] => (typeof v === "string" ? [v] : Array.isArray(v) ? v.flatMap(strings) : v && typeof v === "object" ? Object.values(v).flatMap(strings) : []);
const squash = (s: string): string => s.replace(/\s+/g, "");
const clone = (): RecordedDisputeScenario => structuredClone(sc);

// ---- registration -----------------------------------------------------------------------------------------------------------------------

test("the dispute run is registered after the five planted-bug runs, with its own label, and the five are unchanged", () => {
  assert.deepEqual(RECORDED_SCENARIOS.map((s) => s.id), ["refund_never_booked", "late_payment_overwrites", "signature_rejected", "resend_not_delivered", "cause_not_in_code"]);
  assert.deepEqual(ALL_RECORDED_SCENARIOS.map((s) => s.id), [...RECORDED_SCENARIOS.map((s) => s.id), "dispute_never_heard"]);
  assert.equal(ALL_SCENARIOS.at(-1), DISPUTE_SCENARIO);
  assert.equal(recordedStories().length, 5, "recordedStories() is the five planted-bug runs: what a planted bug looks like is tested over them");
  assert.deepEqual(stories.map((s) => s.id), [...recordedStories().map((s) => s.id), "dispute_never_heard"]);
  assert.equal(scenarioLabel(sc), "A dispute nobody heard");
  assert.equal(story.label, "A dispute nobody heard");
});

test("the scenario select lists the dispute last, after 'Rejected after a settings change', and a link opens it", () => {
  const html = renderStory(stories, 0, "wide");
  assert.deepEqual([...html.matchAll(/<option value="\d"[^>]*>([^<]*)<\/option>/g)].map((m) => m[1]), ["Dropped after a 200 OK", "A late payment wins", "Rejected with 401 three times", "Ring again, one never arrived", "Rejected after a settings change", "A dispute nobody heard"]);
  const opened = renderStory(stories, di, "wide");
  assert.match(opened, /<option value="5" selected="">A dispute nobody heard<\/option>/);
  assert.match(opened, /Recorded run · Oct 20, 2026 · /, "the recorded date comes from the fixture");
  assert.equal(story.date, "Oct 20, 2026");
});

// ---- the recording is what the story stands on ---------------------------------------------------------------------------------------------

test("the real recording passes the dispute rules and the rules every snapshot obeys", () => {
  assert.deepEqual(checkDisputeScenario(sc), []);
  assert.equal(sc.steps.length, 4);
  for (const [i, st] of sc.steps.entries()) assert.deepEqual(checkSnapshot(st).filter((v) => !/ is a gap without a final finding$/.test(v)), [], `step ${i + 1}`);
  assert.deepEqual([DISPUTE.disputeId, DISPUTE.amount, DISPUTE.dueDateSource, DISPUTE.webhooks, DISPUTE.ring?.state, END.scan!.resendsUsed], ["PP-R-JLV-10193723", "48.00", "sandbox_test", { shop: false, any: false }, "cannot_heal", 0]);
});

test("the story says the real numbers: the order, the amount, the ids, the three times, the 39 seconds and the response-due date with its label", () => {
  const all = strings(story).join(" ");
  const wide = readable(renderStory(stories, di, "wide")).text;
  for (const must of ["$48.00", "order #2", "10:42:31", "10:43:10", "10:46:09", "About 39 seconds later", "2026-10-31 03:59 UTC", "set by our own Sandbox test call", "PENDING", "PP-R-JLV-10193723", CAPTURE, "Recorded run · Oct 20, 2026"]) {
    assert.ok(all.includes(must) || wide.includes(must), `"${must}"`);
  }
  // the times are the recording's: PayPal created the dispute at 10:42:31, the first scan that found it ran at 10:43:10, the next at 10:46:09
  assert.equal(new Date(DISPUTE.createdAt).toISOString().slice(11, 19), "10:42:31");
  assert.equal(new Date(sc.steps[1].scan!.at).toISOString().slice(11, 19), "10:43:10");
  assert.equal(new Date(DUE.scan!.at).toISOString().slice(11, 19), "10:46:09");
  assert.equal(Math.round((sc.steps[1].scan!.at - DISPUTE.createdAt) / 1000), 39);
  assert.equal(new Date(DISPUTE.sellerResponseDueAt!).toISOString().slice(0, 16), "2026-10-31T03:59");
});

test("the headline of every chapter says what that chapter's data says", () => {
  assert.equal(story.focal.h, "PayPal lists a $48.00 dispute on order #2. Your books have none.");
  assert.equal(story.travel.h, "Nothing reached your shop. Doorbell found the dispute by asking PayPal.");
  assert.equal(story.why.h, "No webhook of this app asks for dispute events.");
  assert.equal(story.replay.h, "There is no replay for this gap.");
  assert.equal(story.fix.h, "The fix is a setting in PayPal, and it is the shop owner's to change.");
  assert.equal(story.ring.hBefore, "Ring again has nothing to send.");
  assert.equal(story.cert.before.focal, "1 of 3 captures did not match PayPal.");
  assert.equal(story.cert.before.lead, "1 open dispute on PayPal that the books do not show ($48.00).");
});

// ---- what each chapter shows ------------------------------------------------------------------------------------------------------------

test("chapter 2: PayPal sent the shop nothing and Doorbell read the Disputes list; the road stays unlit (reach 0) for every chapter and in the strip", () => {
  assert.equal(story.panel.reach, 0);
  const t = story.travel.body.map(richText).join(" ");
  assert.match(t, /No webhook of this app asked for dispute events, so no webhook message about the dispute was ever going to reach your shop/);
  assert.match(t, /Doorbell read PayPal's Disputes API for each capture and found a \$48\.00 dispute on order #2 that the books do not show/);
  assert.match(t, /Whether PayPal made an event of its own for this dispute cannot be proven from here/, "the cannot-prove line is said in the chapter too");
  const [paypal, doorbell, shop, books] = story.panel.stations;
  assert.equal(richText(shop.layers.find((l) => l.on.includes("2"))!.variants[0].lines[0].rich), "Heard nothing about the dispute");
  assert.equal(shop.marks["2"], "ghost", "no answer of the shop's to judge: nothing arrived");
  assert.equal(shop.hop?.text, "So nothing was booked");
  assert.equal(paypal.hop?.text, "About 39 s later, Doorbell asked");
  assert.match(richText(doorbell.layers.find((l) => l.on.includes("2"))!.variants[0].lines[0].rich), /^Read PayPal's Disputes API for each capture and found the \$48\.00 dispute$/);
  assert.equal(books.marks["2"], "bad");
  for (const ch of [1, 2, 3, 5, 6, 7] as ChapterNo[]) assert.deepEqual(stripScene(story.panel, ch, IDLE_RING).lit, [], `strip, chapter ${ch}: no link is filled in`);
});

test("a planted-bug story still lights the road up to the shop (reach defaults to 2)", () => {
  const code = recordedStories()[0];
  assert.equal(code.panel.reach, undefined);
  assert.deepEqual(stripScene(code.panel, 2, IDLE_RING).lit, ["pp-db", "db-sh"]);
  assert.deepEqual(stripScene(code.panel, 1, IDLE_RING).lit, []);
});

test("chapter 3 is a fact of the setup, read from PayPal: no AI card, no 'cause not proven', and it says that no AI was asked and why", () => {
  const body = story.why.body.map(richText).join(" ");
  assert.match(body, /does not subscribe to the dispute-created event, CUSTOMER\.DISPUTE\.CREATED, and no other webhook of the app does/);
  assert.match(body, /No AI was asked, because there was no code change to read/);
  for (const st of story.panel.stations) for (const l of st.layers) assert.equal(l.code, undefined, `${st.key}: no code block anywhere`);
  const lines = story.panel.stations[2].layers.find((l) => l.on.includes("3"))!;
  assert.equal(lines.mark, "bad");
  assert.deepEqual(lines.variants[0].lines.map((l) => richText(l.rich)), ["Its webhook does not subscribe to dispute events", "Neither does any other webhook of this app"]);
  const html = renderStory(stories, di, "wide") + renderStory(stories, di, "narrow");
  const t = allText(html);
  for (const never of ["Cause not proven", "The cause is not proven", "Not diagnosed", "No cause was diagnosed", "AI receipt", "The AI proposed", "Confirmed by replay", "The AI only proposes"]) assert.ok(!t.includes(never), never);
});

test("chapter 4: no replay; the tab is off and the panel says so in one quiet line", () => {
  assert.equal(story.panel.replay, null);
  assert.equal(story.panel.available[4], false);
  const wide = renderStory(stories, di, "wide");
  assert.match(wide, /data-go="4" disabled/);
  assert.match(wide, /data-go="3"(?! disabled)/);
  assert.match(wide, /data-go="5"(?! disabled)/);
  assert.match(wide, /data-go="6"(?! disabled)/);
  const narrow = renderStory(stories, di, "narrow");
  const chapter4 = narrow.split('id="m4"')[1].split('id="m5"')[0];
  assert.ok(allText(chapter4).includes("No replay result to show for this gap."), "chapter 4's evidence on a phone");
  assert.equal((allText(narrow).match(/No replay result to show/g) ?? []).length, 1, "and only there");
  assert.ok(!/Good build|Bad build/.test(allText(wide) + allText(narrow)), "no two builds are drawn");
});

test("chapter 5: the fix is the owner's setting in PayPal's dashboard; Doorbell and the demo do not make it, so the gap stays; nothing is said to be deployed", () => {
  const body = story.fix.body.map(richText).join(" ");
  assert.match(body, /The shop owner opens the webhook in PayPal's dashboard and adds the dispute events/);
  assert.match(body, /Doorbell does not make that change: it only reads from PayPal\. The demo does not make it either, so in this run the gap stays open/);
  assert.match(body, /We did not test whether it would also send one for this dispute/);
  assert.equal(story.panel.fixedFile, null);
  assert.equal(story.panel.badFile, null);
  const t = allText(renderStory(stories, di, "wide") + renderStory(stories, di, "narrow"));
  for (const never of ["The fix is deployed", "Now runs", "the fixed handler", "good.ts", "Proposed by Claude", "handlers/"]) assert.ok(!t.includes(never), never);
  assert.equal(story.phone.c5.change, null, "no before/now handler line");
  assert.match(richText(story.phone.c5.books), /Books still have no dispute on file/);
});

test("chapter 6: the backend's ring state is what is said, 0 resends were used, nothing is 'healed', and there is no button to press", () => {
  const label = DISPUTE.ring!.label;
  assert.ok(label.startsWith("Nothing to resend: no webhook of this app subscribes to dispute events"));
  const body = richText(story.ring.body);
  assert.ok(body.includes(label), "the ring state's words, as they are");
  assert.match(body, /^On the real run, Ring again was pressed for this dispute and nothing was sent: 0 resends used\./);
  assert.equal(story.ring.result, label);
  assert.deepEqual(story.panel.ledger.map((r) => r.ring), [null, null, null]);
  for (const html of [renderStory(stories, di, "wide"), renderStory(stories, di, "narrow")]) {
    assert.ok(!html.includes('id="ring"') && !html.includes('id="ring-m"'), "no Ring again button");
    assert.ok(!/Start over|Replaying a recording|Ringing/.test(html));
    assert.ok(!/healed|Healed/.test(allText(html)));
  }
});

test("the certificate: the dispute numbers and the cannot-prove lines come from the recording; no line mentions an AI or a replay", () => {
  for (const c of [story.cert.before, story.cert.after, story.phone.cert.before, story.phone.cert.after]) {
    assert.equal(c.stamp, "red");
    assert.equal(c.focal, "1 of 3 captures did not match PayPal.");
    assert.equal(c.lead, "1 open dispute on PayPal that the books do not show ($48.00).");
    const lines = [c.focal, c.lead, ...c.cannot.map(richText), ...c.checks.map((k) => richText(k.rich))];
    assert.deepEqual(lines.filter((l) => /\bAI\b|replay/i.test(l)), []);
    const cannot = c.cannot.map(richText);
    for (const limit of DUE.certificate!.limits.filter((l) => !/event-list lag/.test(l))) assert.ok(cannot.includes(limit), `the limit, as the backend wrote it: ${limit.slice(0, 50)}`);
    assert.ok(cannot.some((l) => /response-due date is the one the test call that made it asked for/.test(l)));
    assert.ok(cannot.some((l) => /This certificate is not signed/.test(l)));
    assert.deepEqual(c.checks.map((k) => k.done), [true, true, true, false]);
  }
  assert.equal(story.certGreen, false);
  const everything = DUE.certificate!.ownerView.concat(END.certificate!.ownerView, [DUE.certificate!.header, DUE.certificate!.stampText]).join(" ");
  assert.deepEqual(everything.match(/\bAI\b|replay/i), null, "the recording's own certificate says neither");
});

test("the owner view of the dispute run opens from the story's link and shows the dispute, not the first scenario's", async () => {
  const link = `/certificate?s=${story.id}`;
  assert.ok(renderStory(stories, di, "wide").includes(`href="${link}"`));
  assert.ok(renderStory(stories, di, "narrow").includes(`href="${link}"`));
  const page = allText(renderToStaticMarkup(await CertificatePage({ searchParams: Promise.resolve({ s: "dispute_never_heard" }) })));
  assert.match(page, /PayPal lists 1 open dispute on your orders that your books do not show\. That is \$48\.00 under dispute\./);
  assert.match(page, /Your shop's webhook is not set up to hear about disputes/);
  assert.match(page, /Recorded run, recorded 2026-10-20 10:46 UTC/, "the last step, as for every run");
  const first = allText(renderToStaticMarkup(await CertificatePage({ searchParams: Promise.resolve({ s: "refund_never_booked" }) })));
  assert.ok(!/dispute/i.test(first), "another run's owner view is unchanged");
});

// ---- the words of the product ------------------------------------------------------------------------------------------------------------

test("no forbidden word anywhere in the story, and none on the rendered pages", () => {
  assert.deepEqual(strings(story).flatMap((s) => hits(s).map((w) => `${w}: ${s}`)), []);
  for (const layout of ["wide", "narrow"] as const) assert.deepEqual(hits(allText(renderStory(stories, di, layout).replace(/<code>[\s\S]*?<\/code>/g, ""))), [], layout);
});

test("the honesty sentence is on the page in full, and 'planted by us' appears only there: no bug was planted in this run", () => {
  for (const layout of ["wide", "narrow"] as const) {
    const text = readable(renderStory(stories, di, layout)).text;
    assert.ok(text.includes(HONESTY), layout);
    assert.equal((text.match(/planted by us/g) ?? []).length, 1, `${layout}: only the honesty sentence`);
  }
  assert.equal(story.certGreen, false);
  assert.ok(!renderStory(stories, di, "wide").includes('data-cert="green"'));
});

test("the dispute is said to be ours: a Sandbox test call made it, and the response-due date is labelled as that call's", () => {
  const t = readable(renderStory(stories, di, "wide")).text;
  assert.match(t, /A Sandbox test call of ours opened a \$48\.00 dispute on it, standing in for a customer who asks their bank for the money back/);
  assert.match(t, /That date was set by our own Sandbox test call, not by PayPal's rules/);
  assert.match(t, /Response due 2026-10-31 03:59 UTC, set by our own Sandbox test call/, "and in the panel, next to the date");
});

for (const layout of ["wide", "narrow"] as const) {
  test(`${layout} layout: the first occurrence of each glossary word that appears is explained, and each is explained once`, () => {
    const html = renderStory(stories, di, layout);
    const { text, explained } = readable(html);
    const bad: string[] = [];
    for (const id of TERM_IDS as readonly TermId[]) {
      const m = new RegExp(TERMS[id].pattern.source, "i").exec(text);
      if (!m) continue; // a word this story has no use for is not on the page
      if (!explained[m.index]) bad.push(`${id}: first occurrence "${text.slice(Math.max(0, m.index - 30), m.index + 30)}" has no explanation`);
      const n = (html.match(new RegExp(`data-term="${id}"`, "g")) ?? []).length;
      if (n !== 1) bad.push(`${id}: ${n} explanations`);
    }
    assert.deepEqual(bad, []);
    for (const id of ["webhook", "capture", "event", "gap", "Sandbox"] as const) assert.ok(new RegExp(TERMS[id].pattern.source, "i").test(text), `${id} is used`);
  });
}

const sentencesOf = (s: string): string[] => s.split(/(?<=[.!?])\s+|\n/).map((x) => x.trim().replace(/[.!?]$/, "").toLowerCase()).filter((x) => x.split(/\s+/).length >= 5);

// What one chapter has on screen at once: its text, the panel's lines for it, the ledger, and the bar.
function onScreen(s: Story, ch: ChapterNo): string[] {
  const out: string[] = [richText(s.bar)];
  const left: Record<ChapterNo, string[]> = {
    1: [s.focal.h, richText(s.focal.lead), ...s.focal.body.map(richText), s.focal.found ? richText(s.focal.found) : "", richText(s.focal.pitch)],
    2: [s.travel.h, ...s.travel.body.map(richText)],
    3: [s.why.h, ...s.why.body.map(richText)],
    4: [s.replay.h, ...s.replay.body.map(richText)],
    5: [s.fix.h, ...s.fix.body.map(richText)],
    6: [s.ring.hBefore, richText(s.ring.body)],
    7: [s.cert.before.focal, s.cert.before.lead, ...s.cert.before.cannot.map(richText), ...s.cert.before.checks.map((c) => richText(c.rich))],
  };
  out.push(...left[ch]);
  const tokens = tokensOf(ch, "idle");
  if (ch !== 4 && ch !== 7) for (const st of s.panel.stations) {
    if (st.hop && st.hop.on.some((t) => tokens.includes(t))) out.push(st.hop.text);
    for (const l of st.layers) if (l.on.some((t) => tokens.includes(t))) for (const v of l.variants) out.push(...v.lines.map((ln) => richText(ln.rich)));
  }
  if (ch === 1 || ch >= 5) for (const r of s.panel.ledger) out.push(`#${r.n} ${r.item}`, `PayPal says ${r.paypal}`, r.start.books);
  return out.filter(Boolean);
}

test("no sentence of five or more words appears twice on the screen of one chapter", () => {
  const dup: string[] = [];
  for (const { no } of CHAPTERS) {
    const seen = new Map<string, number>();
    for (const sentence of onScreen(story, no).flatMap(sentencesOf)) seen.set(sentence, (seen.get(sentence) ?? 0) + 1);
    for (const [k, n] of seen) if (n > 1) dup.push(`chapter ${no}: "${k}" x${n}`);
  }
  assert.deepEqual(dup, []);
});

// ---- the layouts -------------------------------------------------------------------------------------------------------------------------

test("a wide screen has one sticky panel; a phone has the strip, seven chapters of its own with at most one fold each, and the evidence of the dispute", () => {
  const wide = renderStory(stories, di, "wide");
  assert.equal((wide.match(/<aside /g) ?? []).length, 1);
  assert.deepEqual([...wide.matchAll(/<section class="chap" id="(c\d)"/g)].map((m) => m[1]), ["c1", "c2", "c3", "c4", "c5", "c6", "c7"]);
  const read = squash(readable(wide).text);
  for (const p of [...story.focal.body, ...story.travel.body, ...story.why.body, ...story.replay.body, ...story.fix.body, story.ring.body]) assert.ok(read.includes(squash(richText(p))), richText(p).slice(0, 50));
  const narrow = renderStory(stories, di, "narrow");
  assert.match(narrow, /<button class="strip" type="button" aria-haspopup="dialog" aria-expanded="false" aria-label="Delivery path for order #2, gift set:/);
  assert.deepEqual([...narrow.matchAll(/<section class="pch" id="m(\d)"/g)].map((m) => Number(m[1])), [1, 2, 3, 4, 5, 6, 7]);
  const sections = narrow.split('<section class="pch"').slice(1).map((x) => x.split("</section>")[0]);
  sections.forEach((sec, k) => {
    assert.equal((sec.match(/<h[12][ >]/g) ?? []).length, 1, `chapter ${k + 1}: one heading`);
    assert.ok((sec.match(/<details class="pc-more"/g) ?? []).length <= 1, `chapter ${k + 1}: at most one fold`);
    assert.ok(!/<details[^>]* open/.test(sec), `chapter ${k + 1}: the fold is closed`);
  });
  const t = allText(narrow);
  for (const must of ["Dispute open", "No dispute", "Nothing reached", "Its webhook does not subscribe to dispute events", "No replay result to show for this gap.", "Books still have no dispute on file", "books have no dispute"]) assert.ok(t.includes(must), must);
  assert.match(sections[2], /data-m="bad"/, "chapter 3's evidence wears the cross of the panel, not the 'waiting' ring");
  assert.ok(!sections[4].includes("pc-ba"), "chapter 5 has no before/now handler line");
  assert.ok(sections[1].includes("PayPal opened the") && sections[1].includes("10:42:31") && sections[1].includes("10:43:10") && sections[1].includes("10:46:09"), "chapter 2's rail has the three times");
});

test("the strip's words are short, use none of the ten glossary words, and say what the stop knows in each chapter", () => {
  const seen: Record<string, string[]> = {};
  for (const ch of [1, 2, 3, 5, 6] as ChapterNo[]) {
    const scene = stripScene(story.panel, ch, IDLE_RING);
    for (const k of ["pp", "db", "sh", "bk"] as const) {
      const v = scene.stops[k].value;
      (seen[k] ??= []).push(v);
      assert.ok(v.length <= 10, `chapter ${ch} ${k}: "${v}" is ${v.length} characters; a quarter of a phone's width holds about ten`);
      for (const id of TERM_IDS) assert.ok(!new RegExp(TERMS[id].pattern.source, "i").test(v), `chapter ${ch} ${k}: "${v}" is a glossary word`);
    }
  }
  assert.deepEqual(seen.pp, ["Dispute", "10:42:31", "10:42:31", "10:42:31", "Nothing"]);
  assert.deepEqual(seen.bk, ["No dispute", "No dispute", "No dispute", "No dispute", "No dispute"]);
  assert.deepEqual(seen.sh, ["", "Nothing", "Not told", "Not told", "Nothing"]);
  assert.deepEqual([1, 2, 3, 5, 6].map((ch) => stripScene(story.panel, ch as ChapterNo, IDLE_RING).stops.sh.mark), ["ghost", "ghost", "bad", "bad", "bad"]);
  // the chapter after the missing replay keeps the picture of the one before
  assert.deepEqual(stripScene(story.panel, 4, IDLE_RING).stops, stripScene(story.panel, 3, IDLE_RING).stops);
});

test("the ledger's one new phrase: 'no dispute' reads as 'books have no dispute'; the others are as they were", () => {
  assert.equal(booksPhrase("no dispute"), "books have no dispute");
  assert.equal(booksPhrase("no entry"), "books have no entry");
  assert.equal(booksPhrase("Paid $48.00"), "books say Paid");
  assert.deepEqual(story.panel.ledger.map((r) => [r.n, r.paypal, r.start.books, r.start.kind]), [[1, "Paid", "Paid $14.00", "tied"], [2, "a dispute is open", "no dispute", "gap"], [3, "Paid", "Paid $14.00", "tied"]]);
  assert.deepEqual(story.captures.after.map((r) => [r.n, r.paypal, r.books, r.result]), [[1, "Paid", "Paid $14.00", "Tied"], [2, "Dispute open, capture PENDING", "Paid $48.00, no dispute", "Gap"], [3, "Paid", "Paid $14.00", "Tied"]]);
  assert.equal(story.panel.money, "$76.00");
});

// ---- what the builder refuses -------------------------------------------------------------------------------------------------------------------

test("a recording this story cannot tell truthfully makes the builder throw: a subscribed webhook, a ring that is ready, a resend, a second dispute, a missing step", () => {
  const throwsFor = (mutate: (s: RecordedDisputeScenario) => void, why: RegExp): void => {
    const s = clone();
    mutate(s);
    assert.throws(() => disputeStoryOf(s, "x"), why);
  };
  assert.doesNotThrow(() => disputeStoryOf(clone(), "x"));
  const row = (s: RecordedDisputeScenario, step: number) => s.steps[step].scan!.rows.find((r) => r.disputes?.length)!;
  throwsFor((s) => (row(s, 2).disputes![0].webhooks.any = true), /a webhook of the app does subscribe/);
  throwsFor((s) => (row(s, 3).disputes![0].ring!.state = "ready"), /"cannot_heal"/);
  throwsFor((s) => (s.steps[3].scan!.resendsUsed = 1), /used 1 resends/);
  throwsFor((s) => row(s, 3).disputes!.push({ ...row(s, 3).disputes![0], disputeId: "PP-R-XXX-00000001" }), /exactly one dispute/);
  throwsFor((s) => (s.steps = s.steps.slice(0, 3)), /four recorded steps/);
  throwsFor((s) => (s.steps[2].scan!.disputeReads!.unreadable = 1), /not read for every order/);
  throwsFor((s) => (s.steps[2].certificate!.limits = []), /cannot-prove line/);
  throwsFor((s) => (row(s, 1).disputes![0].finding!.flag = undefined), /never subscribed/);
});

test("the story is built and rendered with no network call and an empty environment", () => {
  const realFetch = globalThis.fetch;
  const env = { ...process.env };
  let calls = 0;
  globalThis.fetch = (() => {
    calls++;
    throw new Error("a recorded run must not fetch");
  }) as typeof fetch;
  for (const k of Object.keys(process.env)) delete process.env[k];
  try {
    const built = allStories();
    renderStory(built, built.length - 1, "wide");
    renderStory(built, built.length - 1, "narrow");
  } finally {
    globalThis.fetch = realFetch;
    Object.assign(process.env, env);
  }
  assert.equal(calls, 0);
});
