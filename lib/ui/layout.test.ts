// Layout and motion of the screens (critique round 1, track B): what the markup and the stylesheet promise about orientation (the bar), Ring
// again (no overprint, no jump, the result in place of the instruction), the first chapter's untraced road, the diff, the live lane's buttons
// and the rhythm of the chapters. Offline: static markup and the stylesheet text; the motion itself was checked in a browser.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { allText, readable, renderLive, renderStory } from "./render-helpers.ts";
import { IDLE_RING, finalRing } from "./ring.ts";
import { richText } from "./rich.ts";
import { recordedStories } from "./source.ts";
import type { Story } from "./story.ts";

const app = join(dirname(fileURLToPath(import.meta.url)), "../../app");
const strip = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, "");
const css = strip(readFileSync(join(app, "globals.css"), "utf8"));
const tokens = strip(readFileSync(join(app, "tokens.css"), "utf8"));
const stories = recordedStories();
const squash = (s: string): string => s.replace(/\s+/g, "");
const ringed = (s: Story) => finalRing(s.panel.ledger, s.panel.subject!.n, s.ring.result);
const idx = (id: string): number => stories.findIndex((s) => s.id === id);

// the declarations of the first rule whose selector is exactly `sel`
const rule = (sel: string, from = 0): string => {
  const at = css.indexOf(`\n${sel} {`, from);
  assert.ok(at >= 0, `no rule for ${sel}`);
  return css.slice(at, css.indexOf("}", at));
};

test("the bar links to the live lane, and the scenario switch is a labelled select with a border", () => {
  const html = renderStory(stories, 0, "wide");
  assert.match(html, /<a class="bar-link" href="\/live">Run it live<\/a>/);
  assert.ok(html.indexOf('href="/live">Run it live') < html.indexOf("<main"), "the link is in the bar");
  assert.match(html, /<label for="scenario">Scenario<\/label>/);
  assert.ok(!/<label class="sr" for="scenario"/.test(html), "the label is on screen, not for screen readers only");
  assert.match(renderLive(stories, "wide"), /<a class="bar-link" href="\/">Recorded run<\/a>/);
  // the select: bordered on every width, 44 px tall on a phone
  assert.match(rule(".scn select"), /border:\s*1px solid var\(--edge\)/);
  const narrow = css.slice(css.indexOf("@media (max-width: 1099px)"));
  assert.match(narrow, /\.scn select \{[^}]*min-height:\s*44px/);
  assert.ok(!/\.scn select \{[^}]*border:\s*0/.test(narrow), "no borderless select on a phone");
});

test("on a phone only the brand row sticks; the honesty sentence stays in the markup of the bar and comes right under it", () => {
  const narrow = css.slice(css.indexOf("@media (max-width: 1099px)"));
  assert.match(narrow, /\.bar-main \{[^}]*position:\s*sticky[^}]*top:\s*0/);
  assert.match(narrow, /\.bar \{\s*display:\s*contents/);
  const html = renderStory(stories, 0, "narrow");
  const bar = html.slice(html.indexOf("<header"), html.indexOf("</header>"));
  assert.ok(readable(bar).text.includes("bugs are planted by us"));
  assert.ok(html.indexOf('<select id="scenario"') < html.indexOf('<p class="mode"'), "the switch comes before the sentence on a phone");
});

test("no text is smaller than 13 px: the smallest size is the --text-xs token, and it is 13", () => {
  assert.match(tokens, /--text-xs:\s*13px/);
  assert.deepEqual([...css.matchAll(/font-size:\s*(\d+(?:\.\d+)?)px/g)].map((m) => m[1]), [], "a literal font size");
});

test("Ring again: the result takes the place of the instruction, the recording note stays, and 'Replaying a recording' shows only while it rings", () => {
  for (const [i, s] of stories.entries()) {
    const body = squash(richText(s.ring.body));
    const idle = readable(renderStory(stories, i, "wide")).text;
    assert.ok(squash(idle).includes(body) && idle.includes(s.ring.note), `${s.id}: idle`);
    assert.ok(!idle.includes("Replaying a recording"), `${s.id}: not before the ring`);

    const running = readable(renderStory(stories, i, "wide", { ...IDLE_RING, stage: "running", announce: "Waiting for PayPal to deliver the event again." })).text;
    assert.ok(running.includes("Replaying a recording"), `${s.id}: said while it rings`);
    assert.ok(running.includes(s.ring.note) && squash(running).includes(body), `${s.id}: the note and the instruction stay while it rings`);
    assert.ok(!running.includes(s.ring.result), s.id);

    const done = readable(renderStory(stories, i, "wide", ringed(s))).text;
    assert.ok(done.includes(s.ring.result), `${s.id}: the result`);
    assert.ok(!squash(done).includes(body), `${s.id}: the instruction is gone once the result is there`);
    assert.ok(done.includes(s.ring.note), `${s.id}: the note stays`);
    assert.ok(!done.includes("Replaying a recording"), s.id);
  }
});

test("the ring chapter's headline reserves the room of the other headline it can show, and a text that replaces another goes out before the new one comes in", () => {
  for (const [i, s] of stories.entries()) {
    const sizers = (html: string): string[] => [...html.matchAll(/<span class="sizer" aria-hidden="true">([^<]*)<\/span>/g)].map((m) => m[1]);
    assert.deepEqual(sizers(renderStory(stories, i, "wide")), [...new Set([s.ring.hDuring, s.ring.hAfter])].filter((h) => h !== s.ring.hBefore), `${s.id}: before the ring`);
    assert.deepEqual(sizers(renderStory(stories, i, "wide", ringed(s))), [...new Set([s.ring.hBefore, s.ring.hDuring])].filter((h) => h !== s.ring.hAfter), `${s.id}: after the ring`);
  }
  assert.match(rule(".focal.reserve"), /display:\s*grid/);
  assert.match(rule(".focal.reserve > .sizer"), /visibility:\s*hidden/);
  // out first (short, no delay), then in (after the out): two lines in one place are never both on screen
  assert.match(rule(".fade"), /transition:\s*opacity 0\.12s linear/);
  assert.match(rule(".fade.is-on"), /transition:\s*opacity 0\.22s linear 0\.12s/);
  // the books' slide from one line to the other follows the same order
  assert.match(rule(".stack > .fade[data-flip]"), /transition:\s*opacity 0\.12s linear, transform/);
  assert.match(rule(".stack > .fade[data-flip].is-on"), /transition:\s*opacity 0\.22s linear 0\.12s, transform/);
});

test("the message on the road is a small dot with nothing written on it, not a disc over the marks", () => {
  const dot = rule(".dot");
  assert.match(dot, /height:\s*28px/);
  const src = readFileSync(join(app, "_components/path-panel.tsx"), "utf8");
  assert.match(src, /<circle className="dot-disc" cx="14" cy="14" r="8" \/>/, "a dot of 16 px, smaller than a mark");
  assert.ok(!/<svg viewBox="0 0 48 48">/.test(src), "the 48 px disc is gone");
  assert.ok(!/className="dot-t"/.test(src), "no seconds on the dot: they ran over the station names");
});

test("the first chapter draws the road between its two known ends as one dashed line with a sentence, and keeps the stations in the markup", () => {
  for (const [i, s] of stories.entries()) {
    const wide = renderStory(stories, i, "wide");
    assert.match(wide, /<ol class="sts" data-untraced="">/, s.id);
    assert.equal((wide.match(/class="between"/g) ?? []).length, 1, s.id);
    assert.ok(allText(wide).includes("What happened in between: the next chapter traces it"), s.id);
    // the stations in between are still there (the next chapters fill them), and the stylesheet hides them while the first chapter is on
    assert.ok(wide.includes('data-k="doorbell"') && wide.includes('data-k="shop"'), s.id);
    const narrow = renderStory(stories, i, "narrow");
    assert.equal((narrow.match(/class="between"/g) ?? []).length, 0, `${s.id}: a phone has the strip, whose unknown stops are dashed circles with no name under them`);
  }
  assert.match(css, /\.sts\[data-untraced\] > \.st:not\(\.st-between\):not\(:first-child\):not\(:last-child\) \{\s*display:\s*none/);
  // a live session with nothing to trace has four untraced stations and no known ends: it keeps them all
  const live = renderLive(stories, "wide");
  assert.ok(!live.includes('class="between"') && !live.includes("data-untraced"));
});

test("the diff: one line per row that scrolls inside its row, the highlighter and the strike never on the same line", () => {
  const code = rule(".cl code");
  assert.match(code, /white-space:\s*pre;/);
  assert.match(code, /overflow-x:\s*auto/);
  assert.ok(!/pre-wrap|overflow-wrap/.test(code), "no wrapping");
  assert.match(css, /\.cl\.rm:not\(\.hit\) code \{[^}]*line-through/);
  assert.ok(!/\.cl\.rm code \{[^}]*line-through/.test(css), "no strike on a line the highlighter marks");
  // the cited line is `hit`: an added line, or, when the change only removes lines, those
  const lines = (id: string): string[] => [...renderStory(stories, idx(id), "wide").matchAll(/<p class="(cl [a-z ]+)">/g)].map((m) => m[1]);
  const ack = lines("refund_never_booked");
  assert.ok(ack.includes("cl rm") && ack.includes("cl ad hit"), `ack_then_drop: the removed line is struck, the added one is cited (${ack.join(" | ")})`);
  const late = lines("late_payment_overwrites");
  assert.ok(late.length > 0 && late.every((c) => c === "cl rm hit"), `last_write_wins: only removed lines, so those are cited and none is struck (${late.join(" | ")})`);
  // a line that scrolls takes the keyboard's focus, so that it can be read with the keyboard
  assert.match(renderStory(stories, 0, "wide"), /<code tabindex="0">/);
});

test("the live lane's steps are real buttons: a border when they can be pressed, a fill when they cannot", () => {
  const html = renderLive(stories, "wide");
  const quiet = html.match(/<button[^>]*class="btn-quiet"[^>]*>/g) ?? [];
  assert.ok(quiet.length >= 6, `the four items, the refund and Run Doorbell: ${quiet.length}`);
  assert.ok(quiet.every((b) => /disabled=""/.test(b)), "all of them are switched off before a session opens");
  assert.ok(!/class="btn-text"/.test(html), "no step is a line of text");
  assert.match(rule(".btn-quiet"), /border:\s*1px solid var\(--edge\)/);
  assert.match(rule(".btn-quiet"), /min-height:\s*44px/);
  assert.match(css, /\.btn-quiet\[disabled\] \{[^}]*background:\s*var\(--panel\)[^}]*color:\s*var\(--mute\)/);
});

test("the rhythm of the chapters: about three quarters of a window, the headline at the height of the panel's first node, the panel changes at 60%", () => {
  assert.match(rule(".chap"), /min-height:\s*75vh/);
  assert.match(rule(".chap"), /padding:\s*var\(--lead-in, 14vh\) 0 10vh/);
  const src = readFileSync(join(app, "_components/story-view.tsx"), "utf8");
  assert.match(src, /getBoundingClientRect\(\)\.top < window\.innerHeight \* 0\.6/);
  assert.match(src, /rootMargin: "0px 0px -40% 0px"/);
  assert.match(src, /setProperty\("--lead-in"/);
});
