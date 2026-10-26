// The ten words are explained where they first appear (plan 10.1 #10, R22 A22): on every recorded scenario, in the layout with the sticky panel
// and in the one with a panel inside each chapter, the first occurrence of each word on the page is one that carries its explanation, and all
// ten carry one. A Term is a button, so the keyboard reaches it. The path panel uses none of the ten before the chapter text has explained it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { TERMS, TERM_IDS, TermPlanner, splitByTerms, type TermId } from "./glossary.ts";
import { readable, renderLive, renderStory } from "./render-helpers.ts";
import { recordedStories } from "./source.ts";

const stories = recordedStories();

test("there are exactly ten terms, each with a one-line explanation", () => {
  assert.deepEqual([...TERM_IDS].sort(), ["Sandbox", "capture", "delivery", "event", "events list", "gap", "refund", "resend", "signature", "webhook"]);
  for (const id of TERM_IDS) {
    const tip = TERMS[id].tip;
    assert.ok(tip.length > 20 && tip.length < 140, `${id}: ${tip.length} characters`);
    assert.ok(!tip.includes("\n"), id);
  }
});

test("the planner explains a word once: at its first occurrence, and not again", () => {
  const p = new TermPlanner();
  const first = p.text("A refund and a gap.");
  const second = p.text("Another refund, another gap.");
  assert.deepEqual(first, ["A ", { term: "refund", text: "refund" }, " and a ", { term: "gap", text: "gap" }, "."]);
  assert.deepEqual(second, ["Another refund, another gap."]);
});

test("'events list' is its own word and does not use up 'event'", () => {
  const p = new TermPlanner();
  const a = p.text("The events list shows 0");
  assert.deepEqual(a, ["The ", { term: "events list", text: "events list" }, " shows 0"]);
  const b = p.text("The event arrived");
  assert.deepEqual(b, ["The ", { term: "event", text: "event" }, " arrived"]);
});

test("a word cut out of a text keeps the text's own spelling", () => {
  const { pieces, used } = splitByTerms("Resent deliveries and Webhooks", ["resend", "delivery", "webhook"]);
  assert.deepEqual(used.sort(), ["delivery", "resend", "webhook"]);
  assert.deepEqual(pieces.filter((x) => typeof x !== "string").map((x) => (x as { text: string }).text), ["Resent", "deliveries", "Webhooks"]);
});

for (const layout of ["wide", "narrow"] as const) {
  stories.forEach((story, i) => {
    test(`${story.id}, ${layout} layout: the first occurrence of each of the ten words is explained, and each is explained once`, () => {
      const html = renderStory(stories, i, layout);
      const { text, explained } = readable(html);
      const missing: string[] = [];
      for (const id of TERM_IDS as readonly TermId[]) {
        const m = new RegExp(TERMS[id].pattern.source, "i").exec(text);
        if (!m) {
          missing.push(`${id}: does not appear on the page`);
          continue;
        }
        if (!explained[m.index]) missing.push(`${id}: first occurrence "${text.slice(Math.max(0, m.index - 30), m.index + 30)}" has no explanation`);
        const count = (html.match(new RegExp(`data-term="${id}"`, "g")) ?? []).length;
        if (count !== 1) missing.push(`${id}: ${count} explanations on the page`);
      }
      assert.deepEqual(missing, []);
    });
  });
}

test("every explained word is a button, so that the keyboard reaches it, and points at its explanation", () => {
  const html = renderStory(stories, 0, "wide");
  const terms = html.match(/<span class="term"[^>]*>[\s\S]*?<\/span><\/span>/g) ?? [];
  assert.equal(terms.length, 10, "ten words, once each");
  for (const t of terms) {
    assert.match(t, /<button type="button" class="term-btn" aria-describedby="[^"]+"/);
    assert.match(t, /<span role="tooltip" id="[^"]+" class="term-tip" hidden="">/);
  }
});

test("the live lane (first paint) explains the first occurrence of every word that appears", () => {
  for (const layout of ["wide", "narrow"] as const) {
    const { text, explained } = readable(renderLive(stories, layout));
    const bad: string[] = [];
    for (const id of TERM_IDS as readonly TermId[]) {
      const m = new RegExp(TERMS[id].pattern.source, "i").exec(text);
      if (m && !explained[m.index]) bad.push(`${id}: "${text.slice(Math.max(0, m.index - 25), m.index + 25)}"`);
    }
    assert.deepEqual(bad, [], layout);
  }
});
