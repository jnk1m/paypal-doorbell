// The product rules of the words (plan 14, DO NOT CHANGE), run on everything the screens print:
//   - the words the product never uses (complete, nothing missing, all tied, every, no gaps, all clear, fully; never "PayPal lost an event");
//   - the honesty sentence on every screen, in full; "Recorded run" with its date; "planted by us" next to every planted bug;
//   - green only when the certificate says green; the owner view says it is not signed;
//   - no sentence of five or more words printed twice in one chapter (the panel and the text beside it say different things).
// The check for forbidden words is a plain case-insensitive substring match, so "completed" and "everything" count too.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import CertificatePage from "../../app/certificate/page.tsx";
import LiveStatesPage from "../../app/dev/live/page.tsx";
import StatesPage from "../../app/dev/states/page.tsx";
import { OwnerView } from "../../app/_components/owner-view.tsx";
import type { Ring, EvidenceClass, Flag, RingState, Waiting } from "../gaps/classify.ts";
import type { HealState } from "../shop/types.ts";
import * as copy from "./copy.ts";
import { FORBIDDEN_WORDS, HONESTY } from "./copy.ts";
import { TERMS } from "./glossary.ts";
import * as phrases from "./phrases.ts";
import { WAITING_PHRASE, evidenceWords, healWords, ringWords } from "./phrases.ts";
import { allText, readable, renderLive, renderStory } from "./render-helpers.ts";
import { finalRing } from "./ring.ts";
import { richText } from "./rich.ts";
import { SCENARIOS, recordedStories } from "./source.ts";
import { CHAPTERS, tokensOf, type ChapterNo, type Story } from "./story.ts";

const stories = recordedStories();
const hits = (text: string): string[] => FORBIDDEN_WORDS.filter((w) => text.toLowerCase().includes(w.toLowerCase()));
const strings = (v: unknown): string[] => (typeof v === "string" ? [v] : Array.isArray(v) ? v.flatMap(strings) : v && typeof v === "object" ? Object.values(v).flatMap(strings) : []);

// The page text, minus the lines of code: a diff line is the shop's own source, shown as it is.
const text = (html: string): string => allText(html.replace(/<code>[\s\S]*?<\/code>/g, ""));

test("the fixed copy constants hold none of the forbidden words", () => {
  const { FORBIDDEN_WORDS: _skip, ...rest } = copy;
  const all = strings(rest);
  assert.ok(all.length > 20, `${all.length} strings`);
  assert.deepEqual(all.flatMap((s) => hits(s).map((w) => `${w}: ${s}`)), []);
});

test("the phrase tables hold none of the forbidden words", () => {
  const classes: EvidenceClass[] = ["ACKED_BUT_NOT_APPLIED", "HANDLER_REJECTING", "NO_REPORT", "NO_EVENT_FOUND", "UNVERIFIED"];
  const flags: Flag[] = ["OUT_OF_ORDER", "CRASHED", "UNSUBSCRIBED_EVENT_TYPE"];
  const ringStates: RingState[] = ["ready", "wait", "cannot_heal", "not_listed", "retries_pending", "in_progress", "cap_reached"];
  const heals: HealState[] = ["sent", "arrived", "healed", "unchanged", "lost"];
  const all = [
    ...strings(WAITING_PHRASE),
    ...strings(phrases.NOT_PROVEN_PHRASE),
    ...strings(phrases.NOT_DIAGNOSED_PHRASE),
    ...strings(phrases.SCENARIO_LABEL),
    ...classes.flatMap((cls) => strings(evidenceWords({ cls }))),
    ...flags.flatMap((flag) => strings(evidenceWords({ cls: "ACKED_BUT_NOT_APPLIED", flag }))),
    ...ringStates.flatMap((state) => strings(ringWords({ state, label: "label", waitMs: 90_000 } as Ring))),
    ...heals.flatMap((state) => [true, false].flatMap((tied) => strings(healWords({ state, sends: 2, arrivalSeconds: 3, answer: 200 }, tied)))),
    ...Object.values(TERMS).map((t) => t.tip),
  ];
  assert.deepEqual(all.flatMap((s) => hits(s).map((w) => `${w}: ${s}`)), []);
});

test("every Waiting reason has a phrase", () => {
  const all: Waiting[] = ["requery_failed", "status_not_modeled", "settling", "handler_working", "absence_window", "listing_unavailable", "reporter_record_missing"];
  for (const w of all) assert.ok(WAITING_PHRASE[w] && WAITING_PHRASE[w].length > 20, w);
});

test("the real recording's own sentences hold none of the forbidden words", () => {
  const all = SCENARIOS.flatMap((s) => s.steps).flatMap((s) => (s.certificate ? [s.certificate.stampText, s.certificate.header, s.certificate.footnote, ...s.certificate.limits, ...s.certificate.ownerView] : []).concat(s.heartbeat ? [s.heartbeat.text] : []).concat(s.step ? [s.step.title] : []));
  assert.deepEqual(all.flatMap((s) => hits(s).map((w) => `${w}: ${s}`)), []);
});

// ---- the rendered screens ---------------------------------------------------------------------------------------------------------------

function pages(): Record<string, string> {
  const out: Record<string, string> = {};
  stories.forEach((s, i) => {
    for (const layout of ["wide", "narrow"] as const) {
      out[`${s.id} ${layout}, before the ring`] = renderStory(stories, i, layout);
      out[`${s.id} ${layout}, after the ring`] = renderStory(stories, i, layout, finalRing(s.panel.ledger, s.panel.subject!.n, s.ring.result));
    }
  });
  out["live lane, first paint"] = renderLive(stories, "wide");
  out["gallery"] = renderToStaticMarkup(createElement(StatesPage));
  out["owner view"] = renderToStaticMarkup(createElement(OwnerView, { snapshot: SCENARIOS[0].steps.at(-1)! }));
  return out;
}

test("every rendered screen holds none of the forbidden words", async () => {
  const all = { ...pages(), "certificate page": renderToStaticMarkup(await CertificatePage({ searchParams: Promise.resolve({}) })) };
  const found = Object.entries(all).flatMap(([name, html]) => hits(text(html)).map((w) => `${name}: ${w}`));
  assert.deepEqual(found, []);
});

// After `npm run build`, the pages Next wrote to disk are scanned too (skipped when there is no build). Scripts are not page text.
const built = join(dirname(fileURLToPath(import.meta.url)), "../../.next/server/app");

for (const page of ["index.html", "live.html", "dev/states.html"]) {
  test(`the built page ${page} holds none of the forbidden words`, { skip: !existsSync(join(built, page)) && "run npm run build first" }, () => {
    const html = readFileSync(join(built, page), "utf8");
    assert.deepEqual(hits(text(html)), [], page);
    assert.ok(readable(html).text.includes(HONESTY), `${page}: the honesty sentence is in the built page`);
  });
}

// ---- the product rules ------------------------------------------------------------------------------------------------------------------------

test("the honesty sentence is on every screen, in full", () => {
  assert.equal(HONESTY, "Sandbox demo · fictional shop · PayPal test money · bugs are planted by us");
  for (const [name, html] of Object.entries(pages())) assert.ok(readable(html).text.includes(HONESTY), `${name}: the honesty sentence is missing`);
});

test("the /dev/live index page carries the honesty sentence in the same top bar, and none of the forbidden words", async () => {
  const html = renderToStaticMarkup(await LiveStatesPage({ searchParams: Promise.resolve({}) }));
  assert.ok(readable(html).text.includes(HONESTY), "the honesty sentence is missing");
  assert.match(html, /<header class="bar">/);
  assert.deepEqual(hits(text(html)), []);
  // every seed it lists opens (the index and the seeds are one table)
  for (const key of [...html.matchAll(/href="\/dev\/live\?state=(\w+)"/g)].map((m) => m[1])) {
    const seeded = renderToStaticMarkup(await LiveStatesPage({ searchParams: Promise.resolve({ state: key }) }));
    assert.ok(readable(seeded).text.includes(HONESTY), `/dev/live?state=${key}: the honesty sentence is missing`);
  }
});

test("the top bar sticks, so the honesty sentence stays on screen", () => {
  const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../app/globals.css"), "utf8");
  assert.match(css, /\.bar\s*\{[^}]*position:\s*sticky[^}]*top:\s*0/);
});

test("a recorded run says Recorded run and its date", () => {
  for (const [name, html] of Object.entries(pages())) {
    if (name.startsWith("live lane")) {
      assert.ok(readable(html).text.includes("Live run · Sandbox demo"), name);
      continue;
    }
    if (name === "gallery" || name === "owner view") continue;
    // recorded on 10-20 (the first three again that evening, with the proven fix), except resend_not_delivered: the 10-19 recording of the 401 bug, kept for its ending
    const day = name.startsWith("resend_not_delivered") ? "Oct 19, 2026" : "Oct 20, 2026";
    assert.ok(readable(html).text.includes(`Recorded run · ${day} · Sandbox demo`), name);
  }
  assert.match(allText(renderToStaticMarkup(createElement(OwnerView, { snapshot: SCENARIOS[0].steps[0] }))), /Recorded run, recorded 2026-10-20 10:43 UTC/);
});

test("'planted by us' stands next to every planted bug: in the cause, in the replay, in the fix", () => {
  // the setting bug is not in a file: its planted thing is the webhook id, said in the fix chapter (its deploy changed only a comment)
  const setting = stories.find((s) => s.id === "cause_not_in_code")!;
  assert.match(setting.fix.body.map(richText).join(" "), /planted by us/);
  for (const s of stories.filter((x) => x !== setting)) {
    const caption = richText(s.panel.stations[2].layers.find((l) => l.code)!.code!.caption);
    assert.match(caption, /handlers\/[a-z-]+\.ts, planted by us$/);
    // the fix chapter says it once, in its text; the panel line beside it names only the fixed handler (a chapter says "planted by us" once at most)
    const panelFix = richText(s.panel.stations[2].layers.find((l) => l.on.includes("5"))!.variants[0].lines[0].rich);
    // a proven patch beside the cause: the demo's switch is said as what it is, the last good build (the patch is Claude's, and not deployed)
    assert.match(panelFix, s.fix.proof ? /^Now runs good\.ts, the last good build$/ : /^Now runs good\.ts, the fixed handler$/);
    assert.match(s.fix.body.map(richText).join(" "), /instead of [a-z-]+\.ts, planted by us/);
  }
  for (const [i, s] of stories.entries()) {
    if (s === setting) continue;
    const html = renderStory(stories, i, "wide");
    const bad = SCENARIOS[i].plantedMode;
    const file = { ack_then_drop: "ack-drop.ts", bad_body: "bad-body.ts", last_write_wins: "last-write-wins.ts", wrong_webhook_id_setting: "tidy.ts" }[bad];
    assert.ok(html.includes(file), s.id);
    // each place the bug's file is named says who planted it, in the same sentence or the same line
    for (const m of text(html).matchAll(new RegExp(`${file.replace(".", "\\.")}`, "g"))) {
      const around = text(html).slice(m.index!, m.index! + 70);
      assert.ok(/planted by us/.test(around) || /^[a-z-]+\.ts:\d+/.test(around) || /handlers\/[a-z-]+\.ts:\d+/.test(text(html).slice(Math.max(0, m.index! - 9), m.index! + 20)), `${s.id}: "${around}"`);
    }
  }
});

test("a chapter says 'planted by us' once at most (the bar's honesty sentence is not part of a chapter)", () => {
  stories.forEach((s, i) => {
    // the narrow layout prints its own chapters (the sentence, the evidence, the folded "More"), so the evidence and the folded text are counted too
    const sections = renderStory(stories, i, "narrow").split('<section class="pch"').slice(1);
    assert.equal(sections.length, 7, s.id);
    sections.forEach((section, k) => {
      const said = (text(section.split("</section>")[0]).match(/planted by us/g) ?? []).length;
      assert.ok(said <= 1, `${s.id} chapter ${k + 1}: said ${said} times`);
    });
    // and the three chapters that show the bug each say it once; the setting bug shows no file in chapters 3 and 4 (no cause is claimed,
    // there is no replay), so only its fix chapter says who planted the wrong id
    const want = s.id === "cause_not_in_code" ? [0, 0, 1] : [1, 1, 1];
    assert.deepEqual(sections.map((section) => (text(section.split("</section>")[0]).match(/planted by us/g) ?? []).length).slice(2, 5), want, s.id);
  });
});

test("green is printed only when the certificate says green", () => {
  stories.forEach((s, i) => {
    const before = renderStory(stories, i, "wide");
    const after = renderStory(stories, i, "wide", finalRing(s.panel.ledger, s.panel.subject!.n, s.ring.result));
    assert.ok(before.includes('data-cert="none"') && !before.includes('data-cert="green"'), `${s.id}: red before the ring`);
    assert.equal(after.includes('data-cert="green"'), s.certGreen, `${s.id}: after the ring`);
    assert.equal(after.includes('data-cert="none"'), !s.certGreen, s.id);
  });
});

test("the owner view says that the certificate is not signed", () => {
  const html = renderToStaticMarkup(createElement(OwnerView, { snapshot: SCENARIOS[0].steps[0] }));
  assert.ok(/not signed/i.test(allText(html)));
});

test("the page has one h1, and it comes first", () => {
  for (const [name, html] of Object.entries(pages())) {
    if (name === "owner view") continue;
    assert.equal((html.match(/<h1[ >]/g) ?? []).length, 1, name);
    assert.ok(html.indexOf("<h1") < html.indexOf("<h2"), `${name}: the first heading is the h1`);
  }
});

// ---- no sentence twice in one chapter ---------------------------------------------------------------------------------------------------------

const sentencesOf = (s: string): string[] => s.split(/(?<=[.!?])\s+|\n/).map((x) => x.trim().replace(/[.!?]$/, "").toLowerCase()).filter((x) => x.split(/\s+/).length >= 5);

// What one chapter has on screen at once: its own text, the path panel for it (the resting phase), the ledger, and the bar.
function onScreen(s: Story, ch: ChapterNo, rung: boolean): string[] {
  const out: string[] = [richText(s.bar)];
  const left: Record<ChapterNo, string[]> = {
    1: [s.focal.h, richText(s.focal.lead), ...s.focal.body.map(richText), s.focal.found ? richText(s.focal.found) : "", richText(s.focal.pitch)],
    2: [s.travel.h, ...s.travel.body.map(richText)],
    3: [s.why.h, ...s.why.body.map(richText)],
    4: [s.replay.h, ...s.replay.body.map(richText)],
    5: [s.fix.h, ...s.fix.body.map(richText)],
    6: [rung ? s.ring.hAfter : s.ring.hBefore, richText(s.ring.body), rung ? s.ring.result : s.ring.note],
    7: [(rung ? s.cert.after : s.cert.before).focal, (rung ? s.cert.after : s.cert.before).lead, ...(rung ? s.cert.after : s.cert.before).cannot.map(richText), ...(rung ? s.cert.after : s.cert.before).checks.map((c) => richText(c.rich))],
  };
  out.push(...left[ch]);
  const tokens = tokensOf(ch, rung ? "saved" : "idle");
  if (ch !== 4 && ch !== 7) {
    for (const st of s.panel.stations) for (const l of st.layers) if (l.on.some((t) => tokens.includes(t))) {
      for (const v of l.variants) if (v.on.length === 0 || v.on.some((t) => tokens.includes(t))) out.push(...v.lines.map((ln) => richText(ln.rich)));
      if (l.code) out.push(richText(l.code.caption), ...l.code.checks.map((c) => c.text), ...(l.code.receipt ? [l.code.receipt] : []));
    }
  }
  if (ch === 4 && s.panel.replay) out.push(s.panel.replay.title, s.panel.replay.sub, s.panel.replay.verdict.text, ...s.panel.replay.good.answers, ...s.panel.replay.bad.answers);
  // a ledger row is read in separate cells: the order, what PayPal says, what the books say, the note
  if (ch === 1 || ch >= 5) for (const r of s.panel.ledger) out.push(`#${r.n} ${r.item}`, `PayPal says ${r.paypal}`, (rung && ch >= 6 ? r.end : r.start).books, rung && ch >= 6 ? (r.end.note ?? "") : "");
  return out.filter(Boolean);
}

test("no sentence of five or more words appears twice on the screen of one chapter", () => {
  const dup: string[] = [];
  for (const s of stories) {
    for (const rung of [false, true]) {
      for (const { no } of CHAPTERS) {
        const seen = new Map<string, number>();
        for (const sentence of onScreen(s, no, rung).flatMap(sentencesOf)) seen.set(sentence, (seen.get(sentence) ?? 0) + 1);
        for (const [k, n] of seen) if (n > 1) dup.push(`${s.id} chapter ${no}${rung ? " after the ring" : ""}: "${k}" x${n}`);
      }
    }
  }
  assert.deepEqual(dup, []);
});
