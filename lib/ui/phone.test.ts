// The phone's copy (Story.phone) against the REAL recorded run: each chapter is one sentence, its evidence and the rest folded into a "More"; the facts of
// the chapter are the same facts on both layouts (nothing cut, nothing made up), every sentence is a template read from the snapshots, and the phone
// has its own reading order for the glossary words, so each is explained where a phone first meets it.
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { PITCH_BEATS, PITCH_FIRST, PITCH_LOOKS } from "./copy.ts";
import { TERM_IDS, TERMS } from "./glossary.ts";
import { allText, readable, renderStory } from "./render-helpers.ts";
import { richText } from "./rich.ts";
import { recordedStories } from "./source.ts";
import { brief, type FixProof, type Story } from "./story.ts";

const stories = recordedStories();
const R = (r: Parameters<typeof richText>[0]): string => richText(r);
const RR = (rs: Parameters<typeof richText>[0][]): string => rs.map(R).join(" ");
const strings = (v: unknown): string[] => (typeof v === "string" ? [v] : typeof v === "number" ? [String(v)] : Array.isArray(v) ? v.flatMap(strings) : v && typeof v === "object" ? Object.values(v).flatMap(strings) : []);
const sentences = (s: string): number => s.split(/(?<=[.!?])\s+/).filter(Boolean).length;
// a fact is a token with a digit in it: a time, a number, an amount, an id ("12:26:46.647", "$96.00", "401", "+28")
const facts = (s: string): Set<string> => new Set((s.match(/[\w$#+:.-]*\d[\w$:.-]*/g) ?? []).map((t) => t.replace(/[.:-]+$/, "")));
const missing = (from: Set<string>, into: Set<string>): string[] => [...from].filter((f) => !into.has(f));

// Every word and number of a proposed fix's proof, in the order a reader meets them.
function proofText(p: FixProof | null | undefined): string {
  if (!p) return "";
  const hunks = p.hunks.map((h) => h.map((l) => `${l.kind} ${l.text}`).join(" ")).join(" ");
  return [p.proposed, p.note, R(p.lede), hunks, p.legend ?? "", R(p.verdict), p.verdictNote, p.checks.map((c) => R(c.rich)).join(" "), p.controls.map((c) => `${R(c.rich)} ${c.n}`).join(" "), p.baseline ? R(p.baseline) : "", R(p.leftovers), R(p.deployed), p.basis].join(" ");
}

// The two layouts' text of one chapter. "Left" is what the wide layout's column prints for it; "phone" is what the phone prints for it, evidence included.
function left(s: Story, ch: number): string {
  const c = s.cert.before;
  const parts: Record<number, string[]> = {
    1: [s.focal.h, R(s.focal.lead), RR(s.focal.body), s.focal.found ? R(s.focal.found) : "", R(s.focal.pitch)],
    2: [s.travel.h, RR(s.travel.body)],
    3: [s.why.h, RR(s.why.body)],
    4: [s.replay.h, RR(s.replay.body)],
    5: [s.fix.h, RR(s.fix.body), proofText(s.fix.proof)],
    6: [s.ring.hBefore, R(s.ring.body), s.ring.note, s.ring.noteDetail ?? "", s.ring.result],
    7: [c.focal, c.lead, RR(c.cannot), c.checks.map((k) => R(k.rich)).join(" ")],
  };
  return parts[ch].join(" ");
}
function phone(s: Story, ch: number): string {
  const p = s.phone;
  const shop = s.panel.stations.find((st) => st.key === "shop")!;
  const code = shop.layers.find((l) => l.code)?.code;
  const replay = s.panel.replay;
  const parts: Record<number, string[]> = {
    1: [s.focal.h, p.c1.vs.map((v) => `${v.who} ${v.word} ${v.amount ?? ""}`).join(" "), R(p.c1.caption), RR(p.c1.beats), RR(p.c1.more)],
    2: [s.travel.h, R(p.c2.short), p.c2.rows.map((r) => `${r.t ?? ""} ${R(r.x)}`).join(" "), RR(p.c2.more)],
    3: [s.why.h, R(p.c3.short), RR(p.c3.more), code ? [R(code.caption), code.lines.map((l) => `${l.file} ${l.no} ${l.text}`).join(" "), code.checks.map((k) => k.text).join(" "), code.receipt ?? ""].join(" ") : ""],
    4: [s.replay.h, R(p.c4.short), RR(p.c4.more), replay ? [replay.good, replay.bad].map((b) => `${b.name} ${b.file} ${b.statuses.join(", ")} ${b.booksShort} ${s.panel.subject!.amount}`).join(" ") + " " + replay.verdict.text : ""],
    5: [p.c5.h, R(p.c5.short), JSON.stringify(p.c5.change), R(p.c5.books), RR(p.c5.more), proofText(p.c5.proof)],
    6: [s.ring.hBefore, R(p.c6.short), RR(p.c6.more), s.ring.note, s.ring.noteDetail ?? "", s.ring.result],
    7: [s.cert.before.focal, s.cert.before.lead, RR(p.cert.before.cannot), p.cert.before.checks.map((k) => R(k.rich)).join(" ")],
  };
  return parts[ch].join(" ");
}

test("every scenario has a phone copy for each chapter, and the one sentence of a chapter is one sentence", () => {
  for (const s of stories) {
    const p = s.phone;
    for (const [name, short] of [["chapter 2", p.c2.short], ["chapter 3", p.c3.short], ["chapter 4", p.c4.short], ["chapter 5", p.c5.short], ["chapter 6", p.c6.short]] as const) {
      assert.equal(sentences(R(short)), 1, `${s.id} ${name}: "${R(short)}"`);
      assert.ok(R(short).split(/\s+/).length <= 24, `${s.id} ${name}: short enough to read in one breath`);
    }
    assert.equal(p.c1.beats.length, PITCH_BEATS.length);
    assert.equal(R(p.c1.beats[0]), `Doorbell ${PITCH_BEATS[0]}`.replace(/==/g, ""));
    assert.ok(p.c1.more.length >= 3, "the rest of the first chapter is folded");
  }
});

test("the beats and the first sentence of the pitch are the desktop's pitch, cut in two places", () => {
  assert.equal(PITCH_LOOKS, `${PITCH_FIRST} It ${PITCH_BEATS.join(" ")}`);
  for (const s of stories) {
    assert.equal(R(s.focal.body[0]), PITCH_LOOKS.replace(/==/g, ""), s.id);
    assert.equal(R(s.phone.c1.more[0]), PITCH_FIRST, s.id);
    assert.equal(R(s.phone.c1.beats.at(-1)!), PITCH_BEATS.at(-1)!.replace(/==/g, ""), s.id);
  }
});

test("the same facts on both layouts: every number, time, amount and id of a chapter's text is on the phone, and the phone makes up none", () => {
  for (const s of stories) {
    const wide = [s.panel, s.cert, s.captures].flatMap(strings).join(" ");
    for (const ch of [1, 2, 3, 4, 5, 6, 7]) {
      const l = left(s, ch);
      const p = phone(s, ch);
      assert.deepEqual(missing(facts(l), facts(p)), [], `${s.id} chapter ${ch}: facts of the wide column that the phone does not print`);
      assert.deepEqual(missing(facts(p), facts(`${l} ${wide}`)), [], `${s.id} chapter ${ch}: facts on the phone that the wide layout does not print`);
    }
  }
});

test("nothing is cut: every word of a chapter's paragraphs is somewhere in the phone's chapter, and what is folded is in the page", () => {
  const words = (t: string): string[] => (t.toLowerCase().match(/[a-z]+/g) ?? []);
  for (const s of stories) {
    for (const ch of [2, 3, 4, 5, 6]) {
      const have = new Set(words(phone(s, ch)));
      // the only words the phone's sentence puts differently from the paragraph it came from
      const reworded = new Set(["run", "and", "so", "is", "that", "it"]);
      const lost = [...new Set(words(left(s, ch)))].filter((w) => !have.has(w) && !reworded.has(w));
      assert.deepEqual(lost, [], `${s.id} chapter ${ch}: words of the wide column that the phone's chapter does not have`);
    }
    const html = renderStory(stories, stories.indexOf(s), "narrow");
    const page = readable(html).text.replace(/\s+/g, "");
    for (const m of [...s.phone.c2.more, ...s.phone.c3.more, ...s.phone.c4.more, ...s.phone.c5.more, ...s.phone.c6.more]) assert.ok(page.includes(R(m).replace(/\s+/g, "")), `${s.id}: folded text "${R(m).slice(0, 40)}" is in the page`);
  }
});

test("the highlighter marks one phrase of a chapter at most, and the folded text of chapters 2, 3 and 5 has none", () => {
  for (const s of stories) {
    const p = s.phone;
    const hl = (rs: Parameters<typeof richText>[0][]): number => rs.flat().filter((run) => run.style === "hl").length;
    assert.ok(hl([p.c2.short]) <= 1 && hl(p.c2.more) === 0, `${s.id} chapter 2`);
    assert.ok(hl(p.c3.more) === 0 && hl(p.c5.more) === 0, s.id);
    assert.equal(hl(p.c1.beats), 1, `${s.id}: the cannot-prove phrase`);
  }
});

test("the sentence of chapter 2 is the true one for its scenario", () => {
  const s = (id: string) => stories.find((x) => x.id === id)!;
  assert.equal(R(s("refund_never_booked").phone.c2.short), "A 200 tells PayPal to stop trying, so nobody tried again.");
  assert.equal(R(s("late_payment_overwrites").phone.c2.short), "The refund arrived, then the late payment overwrote it.");
  for (const id of ["signature_rejected", "resend_not_delivered", "cause_not_in_code"]) assert.match(R(s(id).phone.c2.short), /^After the last try PayPal gave up: the Sandbox stops after 3 tries\.$/);
});

test("the timed rail has the event's own times, in the path's order, and ends at the books", () => {
  for (const s of stories) {
    const rows = s.phone.c2.rows;
    assert.match(rows[0].t!, /^\d\d:\d\d:\d\d$/, "PayPal made the event");
    assert.match(rows[1].t!, /^\d\d:\d\d:\d\d$/, "Doorbell heard it");
    assert.equal(rows.at(-1)!.mark, "bad", `${s.id}: the last row is the books, and they are wrong`);
    assert.ok(rows.slice(0, -1).every((r) => r.mark === null), s.id);
    assert.ok(rows.length >= 4 && rows.length <= 5, `${s.id}: ${rows.length} rows fit a phone`);
  }
  assert.deepEqual(stories.map((s) => s.phone.c2.rows.length), [4, 5, 5, 5, 5]);
  assert.equal(R(stories[1].phone.c2.rows.at(-1)!.x), "Books overwritten, with paid");
});

test("chapter 3: the sentence says what the checks did; an unproven cause says so and nothing about the code", () => {
  const s = (id: string) => stories.find((x) => x.id === id)!;
  for (const id of ["refund_never_booked", "signature_rejected", "resend_not_delivered"]) assert.equal(R(s(id).phone.c3.short), "The AI only proposes; two checks in plain code, with no model involved, both pass.");
  assert.equal(R(s("late_payment_overwrites").phone.c3.short), "The AI only proposes; of its two checks in plain code, one passes and one has nothing to test.");
  const none = s("cause_not_in_code");
  assert.equal(R(none.phone.c3.short), "The AI found no changed line that explains this gap.");
  assert.equal(RR(none.phone.c3.more), "The gap stands on its own: it does not depend on the AI. Nothing about its cause is claimed.");
});

test("chapter 5: the handler line before and now, from the cited change, when no patch was proven; a setting has no file", () => {
  const s = (id: string) => stories.find((x) => x.id === id)!;
  // a proven patch takes the place of the before/now: the evidence is its diff (the first three scenarios have one)
  for (const id of ["refund_never_booked", "late_payment_overwrites", "signature_rejected"]) {
    assert.equal(s(id).phone.c5.change, null, id);
    assert.ok(s(id).phone.c5.proof, id);
  }
  // resend_not_delivered is the 10-19 recording of the 401 bug, from before the fix existed: its chapter 5 is told as it was
  const c = s("resend_not_delivered");
  assert.ok(!c.phone.c5.proof);
  assert.deepEqual(c.phone.c5.change, { kind: "code", before: ["const event = canonical(…);"], now: null });
  assert.ok(!s("cause_not_in_code").phone.c5.proof);
  assert.deepEqual(s("cause_not_in_code").phone.c5.change, { kind: "setting", before: "Held the ID of another webhook", now: "The shop's own webhook ID" });
  for (const x of stories) {
    assert.equal(x.phone.c5.h, x.fix.h.split(". ")[0] + ".", x.id);
    assert.equal(R(x.phone.c5.short), x.fix.h.split(". ").slice(1).join(". "), x.id);
    assert.match(R(x.phone.c5.books), /^Books still say Paid \$48\.00$/);
  }
  assert.equal(brief("queue.push(event);"), "queue.push(event);", "a short line is shown whole");
  assert.equal(brief("await ctx.books.set(booking.captureId, { state: booking.state });"), "await ctx.books.set(…);");
});

test("chapter 1 says what PayPal says and what the books say, side by side", () => {
  for (const s of stories) {
    const [paypal, books] = s.phone.c1.vs;
    assert.deepEqual([paypal.who, paypal.word, paypal.amount, paypal.mark], ["PayPal says", "Refunded", "$48.00", "ink"], s.id);
    assert.deepEqual([books.who, books.word, books.amount, books.mark], ["Your books say", "Paid", "$48.00", "bad"], s.id);
    assert.equal(R(s.phone.c1.caption), `${s.panel.subject!.label}. ${R(s.focal.lead)}`, s.id);
  }
});

test("on a phone the ten glossary words are explained once each, where a phone first meets them, and the strip before them uses none", () => {
  stories.forEach((s, i) => {
    const html = renderStory(stories, i, "narrow");
    const { text, explained } = readable(html);
    for (const id of TERM_IDS) {
      const m = new RegExp(TERMS[id].pattern.source, "i").exec(text);
      assert.ok(m, `${s.id}: ${id} appears`);
      assert.ok(explained[m!.index], `${s.id}: the first "${id}" on the phone is the explained one: "${text.slice(Math.max(0, m!.index - 25), m!.index + 25)}"`);
      assert.equal((html.match(new RegExp(`data-term="${id}"`, "g")) ?? []).length, 1, `${s.id}: ${id} explained once`);
    }
  });
});

// ---- the stylesheet and the components: what they promise about the phone ----------------------------------------------------------------------

const app = join(dirname(fileURLToPath(import.meta.url)), "../../app");
const css = readFileSync(join(app, "globals.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const phoneCss = css.slice(css.indexOf(".narr-m,\n.strip,"));
const source = (f: string): string => readFileSync(join(app, "_components", f), "utf8");
// every rule of the phone's block that has exactly this selector, joined
const ruleOf = (sel: string): string => {
  const out: string[] = [];
  for (let at = phoneCss.indexOf(`\n  ${sel} {`); at >= 0; at = phoneCss.indexOf(`\n  ${sel} {`, at + 1)) out.push(phoneCss.slice(at, phoneCss.indexOf("}", at)));
  assert.ok(out.length > 0, `no rule for ${sel}`);
  return out.join("\n");
};

test("the phone's parts are hidden on a wide screen, and the wide column is hidden on a phone", () => {
  assert.match(phoneCss, /^\.narr-m,\n\.strip,\n\.p-scrim,\n\.p-sheet \{\n  display: none;/, "hidden until the phone's media query shows them");
  const narrow = phoneCss.slice(phoneCss.indexOf("@media (max-width: 1099px)"));
  assert.match(narrow, /\.narr-w \{\s*display: none/);
  assert.match(narrow, /\.narr-m \{\s*display: block/);
  assert.ok(!/\n  \.narr \{/.test(narrow), "the live lane's column is also called .narr, and a phone keeps it");
});

test("the strip is pinned to the top of the screen and the brand row is not, on the story page", () => {
  assert.match(ruleOf(".strip"), /position: sticky;\s*top: 0;\s*z-index: 20/);
  assert.match(ruleOf(".page .bar-main"), /position: static/);
  assert.ok(source("story-view.tsx").includes('<div className="page" inert={sheetOpen}'), "the story page wraps what the sheet makes inert");
  assert.ok(!source("live-lane.tsx").includes('className="page"'), "the live lane keeps its sticky brand row");
});

test("the fold, the sheet's Close, the brand row and the owner-view link are tap targets of 44 px or more", () => {
  assert.match(ruleOf(".pc-more summary"), /min-height: 44px/);
  assert.match(ruleOf(".p-sheet-top .btn-text"), /min-height: 44px/);
  assert.match(ruleOf(".page .brand,\n  .page .bar-link"), /min-height: 44px/);
  assert.match(ruleOf(".pc-link"), /min-height: 44px/);
});

test("the sheet is a dialog: modal, scroll-locked, Escape and Tab handled, focus returned to the strip, the page behind it inert", () => {
  const sheet = source("path-sheet.tsx");
  for (const must of ['role="dialog"', 'aria-modal="true"', 'e.key === "Escape"', 'e.key !== "Tab"', 'html.style.overflow = "hidden"', "data-close"]) assert.ok(sheet.includes(must), `path-sheet.tsx: ${must}`);
  const view = source("story-view.tsx");
  assert.ok(view.includes("strip.current?.focus"), "focus goes back to the strip");
  assert.ok(view.includes("inert={sheetOpen}"));
  assert.match(ruleOf(".p-sheet"), /max-height: 90svh;\s*overflow-y: auto;\s*overscroll-behavior: contain/);
  assert.match(ruleOf(".p-sheet"), /transform: translateY\(100%\)/);
});

test("the strip plays its motion only with motion allowed, and the reduced-motion style stops every transition", () => {
  assert.ok(source("path-strip.tsx").includes("if (!motion ||"), "no motion: the end state is painted at once");
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]*transition: none !important/);
  // one ripple, shared with the path panel: the strip adds a selector, not an animation
  assert.deepEqual([...css.matchAll(/animation:\s*([\w-]+)/g)].map((m) => m[1]).filter((v) => v !== "none"), ["ripple"]);
});

test("the top bar keeps the honesty sentence on one line from 1280 px up: it does not shrink or wrap, and the switch gives way first", () => {
  const from = css.indexOf("@media (min-width: 1280px)");
  const wide = css.slice(from, css.indexOf("@media (max-width: 1099px)", from));
  assert.match(wide, /\.mode \{\s*flex: 1 0 auto;\s*white-space: nowrap/);
  assert.match(wide, /\.scn \{\s*flex: 0 1 auto;\s*min-width: 0/);
  assert.match(wide, /\.scn select \{\s*width: 100%;\s*text-overflow: ellipsis/);
});

test("chapter 5 on a phone: the evidence is the patch and its verdict, the checks and the rest are folded in More; without a patch it is the before and now", () => {
  const chapter5 = (html: string): string => html.slice(html.indexOf('id="m5"'), html.indexOf('id="m6"'));
  stories.forEach((s, i) => {
    if (!["refund_never_booked", "late_payment_overwrites", "signature_rejected", "resend_not_delivered", "cause_not_in_code"].includes(s.id)) return; // the planted-bug scenarios
    const html = chapter5(renderStory(stories, i, "narrow"));
    const fold = html.indexOf("<details");
    assert.ok(fold > 0, s.id);
    const open = html.slice(0, fold);
    const more = html.slice(fold);
    const p = s.phone.c5.proof;
    if (!p) {
      assert.ok(!html.includes("fx-code") && !html.includes("Proposed by Claude"), `${s.id}: no patch, none shown`);
      assert.ok(open.includes("pc-ba"), `${s.id}: the before and now`);
      return;
    }
    assert.ok(!open.includes("pc-ba"), `${s.id}: the patch replaces the before and now`);
    assert.ok(open.includes("Proposed by Claude") && open.includes("not deployed in this demo"), s.id);
    assert.ok(open.includes("fx-code"), `${s.id}: the diff`);
    assert.ok(allText(open).includes(R(p.verdict)), `${s.id}: the verdict is on the screen, not folded`);
    assert.ok(allText(open).includes("Books still say"), `${s.id}: and so is what the books say`);
    for (const h of ["What the code checked", "What the replay compared"]) assert.ok(more.includes(h) && !open.includes(h), `${s.id}: "${h}" is folded`);
    for (const t of [R(p.leftovers), R(p.deployed), p.basis, ...(p.baseline ? [R(p.baseline)] : [])]) assert.ok(allText(more).includes(t), `${s.id}: folded "${t.slice(0, 40)}"`);
  });
});
