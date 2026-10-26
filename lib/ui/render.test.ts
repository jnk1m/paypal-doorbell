// The screens, rendered from the REAL recorded run: each chapter is printed from its story, the layouts hold what they should (one sticky panel
// on a wide screen, one panel inside each chapter on a phone), Ring again ends honestly, the recorded run makes no request, /stamp goes to /live,
// and no component of app/_components is left without a user.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import StampPage from "../../app/stamp/page.tsx";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { StoryView } from "../../app/_components/story-view.tsx";
import { NOT_PROVEN_TEXT } from "../cause/categories.ts";
import { allText, readable, renderLive, renderStory } from "./render-helpers.ts";
import { finalRing } from "./ring.ts";
import { richText } from "./rich.ts";
import { SCENARIOS, recordedStories } from "./source.ts";
import { CHAPTERS, buildStory, type Story } from "./story.ts";

const stories = recordedStories();
const ringed = (s: Story) => finalRing(s.panel.ledger, s.panel.subject!.n, s.ring.result);
const text = (html: string): string => allText(html);
// the glossary buttons put spaces around a word in the text read back from the markup; compare without any
const squash = (s: string): string => s.replace(/\s+/g, "");

test("each chapter is printed from the story of its scenario: heading, text and the path panel's own lines", () => {
  stories.forEach((s, i) => {
    const html = renderStory(stories, i, "wide");
    const t = text(html);
    const headings = [s.focal.h, s.travel.h, s.why.h, s.replay.h, s.fix.h, s.ring.hBefore, s.cert.before.focal];
    CHAPTERS.forEach((c, k) => {
      assert.ok(html.includes(`id="c${c.no}"`), `${s.id}: chapter ${c.no} section`);
      assert.ok(html.includes(`id="t${c.no}"`), `${s.id}: chapter ${c.no} heading`);
      assert.ok(t.includes(headings[k]), `${s.id}: "${headings[k]}"`);
    });
    const read = squash(readable(html).text);
    for (const p of [...s.focal.body, ...s.travel.body, ...s.why.body, ...s.replay.body, ...s.fix.body, s.ring.body]) assert.ok(read.includes(squash(richText(p))), `${s.id}: "${richText(p).slice(0, 50)}"`);
    for (const l of s.panel.stations[2].layers.flatMap((x) => x.variants.flatMap((v) => v.lines))) assert.ok(read.includes(squash(richText(l.rich))), `${s.id}: panel line "${richText(l.rich)}"`);
    if (s.panel.replay) assert.ok(t.includes(s.panel.replay.title), `${s.id}: the replay`);
    else assert.equal(s.id, "cause_not_in_code", "only the scenario whose cause is not proven has no replay");
    assert.ok(t.includes(s.panel.subject!.captureId), `${s.id}: the PayPal id of the capture`);
    for (const r of s.captures.before) assert.ok(t.includes(`#${r.n} ${r.item}`), `${s.id}: the list of all captures`);
  });
});

test("a wide screen has one sticky panel and nothing of the phone; a phone has the strip, seven chapters of its own and the closed sheet, and no panel beside", () => {
  stories.forEach((s, i) => {
    const wide = renderStory(stories, i, "wide");
    assert.equal((wide.match(/<aside /g) ?? []).length, 1, s.id);
    assert.equal((wide.match(/class="vis-inline"/g) ?? []).length, 0, s.id);
    assert.equal((wide.match(/class="steps"/g) ?? []).length, 1, "the chapter tabs are in the sticky panel");
    for (const phone of ['class="strip"', 'class="narr-m"', 'class="pch"', "p-sheet"]) assert.ok(!wide.includes(phone), `${s.id}: ${phone} is not on a wide screen`);
    const narrow = renderStory(stories, i, "narrow");
    assert.equal((narrow.match(/<aside /g) ?? []).length, 0, s.id);
    assert.equal((narrow.match(/class="vis-inline"/g) ?? []).length, 0, s.id);
    assert.equal((narrow.match(/class="narr narr-w"/g) ?? []).length, 0, "the wide column is not printed for a phone");
    assert.equal((narrow.match(/<button class="strip"/g) ?? []).length, 1, "one strip, a button that opens the full path");
    assert.match(narrow, /<button class="strip" type="button" aria-haspopup="dialog" aria-expanded="false" aria-label="Delivery path for order #2, gift set:/);
    assert.deepEqual([...narrow.matchAll(/<section class="pch" id="m(\d)"/g)].map((m) => Number(m[1])), [1, 2, 3, 4, 5, 6, 7], s.id);
    assert.equal((narrow.match(/class="steps"/g) ?? []).length, 0, "no chapter tabs on a phone: the strip is the way around");
    assert.match(narrow, /<div class="p-sheet" role="dialog" aria-modal="true" aria-labelledby="p-sheet-h"/, "the sheet is in the page, closed");
    // each chapter: its headline, one sentence, its evidence, and at most one fold; the folded text is in the page (nothing is cut)
    const sections = narrow.split('<section class="pch"').slice(1).map((x) => x.split("</section>")[0]);
    sections.forEach((sec, k) => {
      assert.equal((sec.match(/<h[12][ >]/g) ?? []).length, 1, `${s.id} chapter ${k + 1}: one heading`);
      assert.ok((sec.match(/<details class="pc-more"/g) ?? []).length <= 1, `${s.id} chapter ${k + 1}: at most one fold`);
      assert.ok(!/<details[^>]* open/.test(sec), `${s.id} chapter ${k + 1}: the fold is closed to begin with`);
    });
  });
});

test("the scenario switch is a select in the top bar with one option per scenario", () => {
  const html = renderStory(stories, 0, "wide");
  assert.match(html, /<select id="scenario"/);
  assert.deepEqual([...html.matchAll(/<option value="\d"[^>]*>([^<]*)<\/option>/g)].map((m) => m[1]), ["Dropped after a 200 OK", "A late payment wins", "Rejected with 401 three times", "Ring again, one never arrived", "Rejected after a settings change"]);
  assert.ok(html.indexOf('<select id="scenario"') < html.indexOf("<main"), "the switch is in the bar above the story");
});

test("the title heading is the first heading, and chapters follow in the order of the story", () => {
  const html = renderStory(stories, 0, "wide");
  const ids = [...html.matchAll(/<section class="chap" id="(c\d)"/g)].map((m) => m[1]);
  assert.deepEqual(ids, ["c1", "c2", "c3", "c4", "c5", "c6", "c7"]);
  assert.ok(html.indexOf('id="all-h"') > html.indexOf('id="c7"'), "the list of all captures comes after the story");
});

test("before Ring again the books still say paid; after it the story ends where the recording ended", () => {
  for (const [i, s] of stories.entries()) {
    const before = text(renderStory(stories, i, "wide"));
    assert.ok(before.includes("Ring again") && before.includes(s.ring.note), s.id);
    assert.ok(!before.includes(s.ring.result), `${s.id}: the result is not printed before the ring`);
    const after = renderStory(stories, i, "wide", ringed(s));
    assert.ok(text(after).includes(s.ring.result), `${s.id}: the result`);
    assert.ok(text(after).includes(s.cert.after.focal), s.id);
    assert.ok(after.includes("Start over"), s.id);
  }
});

test("resend_not_delivered's last state reads 'Resend accepted, not delivered', never 'waiting for it to arrive'", () => {
  const i = stories.findIndex((s) => s.id === "resend_not_delivered");
  const wide = text(renderStory(stories, i, "wide", ringed(stories[i])));
  assert.match(wide, /Order #3: Resend accepted, not delivered\. The gap stays open\./);
  assert.ok(!/waiting for it to arrive/i.test(wide), "no row is still said to be waiting");
  // the ledger of the panel (inside the ring chapter and the certificate chapter on a phone) says it too, with the limit
  const narrow = text(renderStory(stories, i, "narrow", ringed(stories[i])));
  assert.match(narrow, /Resend accepted, not delivered\. Resend limit reached \(5 per session\)/);
  assert.ok(!/waiting for it to arrive/i.test(narrow));
});

test("signature_rejected's last state ties both rows: the screen says the books now say refunded, and never that a resend was not delivered", () => {
  const i = stories.findIndex((s) => s.id === "signature_rejected");
  for (const layout of ["wide", "narrow"] as const) {
    const t = text(renderStory(stories, i, layout, ringed(stories[i])));
    assert.ok(t.includes(stories[i].ring.result), layout);
    assert.ok(t.includes("2 gaps found · 2 healed · 0 still open."), layout);
    assert.ok(!/not delivered|stays open|is still open|waiting for it to arrive/i.test(t), `${layout}: no row is open or waiting`);
  }
});

test("the live lane's first paint is the same layout: the judge's five steps on the left, the sticky panel on the right", () => {
  const html = renderLive(stories, "wide");
  const t = readable(html).text;
  for (const title of ["Enter the token", "Place an order", "Turn on a bug", "Refund it", "Run Doorbell"]) assert.ok(t.includes(title), title);
  assert.deepEqual([...html.matchAll(/<h2 id="s(\d)-h">/g)].map((m) => m[1]), ["1", "2", "3", "4", "5"]);
  assert.equal((html.match(/<aside /g) ?? []).length, 1);
  assert.match(html, /Nothing to trace yet/);
  assert.ok(t.includes("Live run · Sandbox demo"));
  assert.match(html, /planted by us/);
  const narrow = renderLive(stories, "narrow");
  assert.equal((narrow.match(/<aside /g) ?? []).length, 0);
  assert.match(narrow, /class="vis-inline"/);
});

test("the recorded run makes no network call: the stories are built and the pages rendered with every fetch throwing and the environment empty", () => {
  const realFetch = globalThis.fetch;
  const env = { ...process.env };
  let calls = 0;
  globalThis.fetch = (() => {
    calls++;
    throw new Error("a recorded run must not fetch");
  }) as typeof fetch;
  for (const k of Object.keys(process.env)) delete process.env[k];
  try {
    const built = recordedStories();
    renderStory(built, 0, "wide");
    renderStory(built, 2, "narrow", ringed(built[2]));
  } finally {
    globalThis.fetch = realFetch;
    Object.assign(process.env, env);
  }
  assert.equal(calls, 0);
  const root = join(dirname(fileURLToPath(import.meta.url)), "../../app/_components");
  for (const f of ["story-view.tsx", "path-panel.tsx", "captures-list.tsx", "top-bar.tsx"]) assert.ok(!/\bfetch\s*\(|XMLHttpRequest|EventSource/.test(readFileSync(join(root, f), "utf8")), `${f} makes no request`);
});

test("/stamp goes to the live lane", () => {
  assert.throws(
    () => StampPage(),
    (e: unknown) => /NEXT_REDIRECT/.test(String((e as { digest?: string }).digest)) && String((e as { digest?: string }).digest).includes("/live"),
  );
});

test("every component and helper in app/_components is used by a page or another component", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const dir = join(here, "../../app/_components");
  const all = [...walk(join(here, "../../app")), ...walk(join(here, ".."))].filter((f) => /\.(tsx?|css)$/.test(f));
  const sources = new Map(all.map((f) => [f, readFileSync(f, "utf8")]));
  const unused: string[] = [];
  for (const file of readdirSync(dir)) {
    const base = file.replace(/\.(tsx|ts)$/, "");
    const used = [...sources].some(([f, src]) => !f.endsWith(`/${file}`) && new RegExp(`from "[./a-z_-]*/${base}(\\.tsx?)?"`).test(src));
    if (!used) unused.push(file);
  }
  assert.deepEqual(unused, []);
  assert.ok(!existsSync(join(dir, "stamp.tsx")) && !existsSync(join(here, "../../app/stamp/stamp.css")), "the old stamp screen is gone");
});

function walk(d: string): string[] {
  return readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.name === "node_modules" || e.name.startsWith(".") ? [] : e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));
}

test("the scenario files are the ones the pages play", () => {
  assert.deepEqual(stories.map((s) => s.id), SCENARIOS.map((s) => s.id));
});

test("chapter 4 without a replay: the tab is off and the panel says so in one quiet line instead of going blank; with a replay the line is not there", () => {
  const before = structuredClone(SCENARIOS[0].steps[0]);
  before.causes = before.causes.map((c) => ({ captureId: c.captureId, mode: c.mode, cause: { promptVersion: "x", requestHash: "h", status: "not_proven" as const, reason: "model_abstained" as const, text: NOT_PROVEN_TEXT }, replay: null, confirmation: null }));
  const none = buildStory({ id: "no-replay", label: "no replay", before, fixed: null, after: null, mode: "script" });
  assert.equal(none.panel.available[4], false);
  const chapter4 = (html: string): string => html.split('id="m4"')[1].split('id="m5"')[0];
  const QUIET = "No replay result to show for this gap.";

  const narrow = renderToStaticMarkup(createElement(StoryView, { stories: [none], start: 0, layout: "narrow" }));
  assert.ok(text(chapter4(narrow)).includes(QUIET), "chapter 4's evidence on a phone");
  assert.equal((text(narrow).match(/No replay result to show/g) ?? []).length, 1, "and only there");
  const wide = renderToStaticMarkup(createElement(StoryView, { stories: [none], start: 0, layout: "wide" }));
  assert.match(wide, /data-go="4" disabled/, "the tab of chapter 4 is off");
  assert.match(wide, /data-go="3"(?! disabled)/, "chapter 3 (the cause) is still there");

  const withReplay = renderStory(stories, 0, "narrow");
  assert.ok(!text(withReplay).includes(QUIET));
  assert.ok(text(chapter4(withReplay)).includes("Good build") && text(chapter4(withReplay)).includes("Bad build"), "the replay is drawn instead: two builds side by side");
});
