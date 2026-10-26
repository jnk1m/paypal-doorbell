// The phone's path strip (lib/ui/strip.ts) against the REAL recorded run: what it draws at rest for each chapter and each state of Ring again is read
// from the same Panel the desktop's sticky panel draws (the same marks, the words of Station.glance), it forks for the replay, it follows the ring
// wherever the reader has scrolled, and what it says under a stop is short and uses none of the ten glossary words (the strip comes first on the page).
import { test } from "node:test";
import assert from "node:assert/strict";
import { TERMS } from "./glossary.ts";
import { IDLE_RING, finalRing, type RingView } from "./ring.ts";
import { recordedStories } from "./source.ts";
import { FORK_LINKS, PATH_LINKS, STOP_KEYS, stripScene, stripView, type StopKey } from "./strip.ts";
import { PHASES, codesGlance, markOf, type ChapterNo, type Phase, type Story } from "./story.ts";

const stories = recordedStories();
const ringed = (s: Story): RingView => finalRing(s.panel.ledger, s.panel.subject!.n, s.ring.result);
const at = (phase: Phase, stage: RingView["stage"] = "running"): RingView => ({ ...IDLE_RING, stage, phase, asks: phase === "idle" ? 0 : 1 });
const STATION = { pp: "paypal", db: "doorbell", sh: "shop", bk: "books" } as const;
const station = (s: Story, k: keyof typeof STATION) => s.panel.stations.find((st) => st.key === STATION[k])!;
const PATH: (keyof typeof STATION)[] = ["pp", "db", "sh", "bk"];

test("the strip has four stops on a path, in the order of the path, named as the panel names them", () => {
  for (const s of stories) {
    const scene = stripScene(s.panel, 2, IDLE_RING);
    assert.equal(scene.mode, "path");
    assert.deepEqual(PATH.map((k) => scene.stops[k].name), ["PayPal", "Doorbell", "Your shop", "Your books"], s.id);
    assert.deepEqual(STOP_KEYS.filter((k) => scene.stops[k].shown), PATH, `${s.id}: the second pair of stops is only for the replay`);
  }
});

test("at rest each stop wears the mark the panel gives its station in that chapter, and says the station's own glance", () => {
  for (const s of stories) {
    for (const ch of [1, 2, 3, 5] as ChapterNo[]) {
      const scene = stripScene(s.panel, ch, IDLE_RING);
      for (const k of PATH) {
        const st = station(s, k);
        assert.equal(scene.stops[k].mark, markOf(st, ch, "idle"), `${s.id} chapter ${ch} ${k}: mark`);
        assert.equal(scene.stops[k].value, st.glance[String(ch)] ?? "", `${s.id} chapter ${ch} ${k}: words`);
      }
    }
  }
});

test("the first chapter knows PayPal's answer and the books and nothing between; the road is not filled yet", () => {
  for (const s of stories) {
    const one = stripScene(s.panel, 1, IDLE_RING);
    assert.deepEqual([one.stops.pp.mark, one.stops.db.mark, one.stops.sh.mark, one.stops.bk.mark], ["ok", "ghost", "ghost", "bad"], s.id);
    assert.equal(one.stops.pp.value, "Refunded");
    assert.equal(one.stops.bk.value, "Paid");
    assert.equal(one.stops.db.value + one.stops.sh.value, "", "the stops in between say nothing yet");
    assert.deepEqual(one.lit, [], s.id);
    assert.deepEqual(stripScene(s.panel, 2, IDLE_RING).lit, PATH_LINKS.slice(0, 2), `${s.id}: the message went as far as the shop`);
  }
});

test("chapter 2 says what each hop did, and the shop's answer reads as the story says it", () => {
  const two = (id: string) => stripScene(stories.find((s) => s.id === id)!.panel, 2, IDLE_RING);
  assert.equal(two("refund_never_booked").stops.sh.value, "200 OK");
  assert.equal(two("late_payment_overwrites").stops.sh.value, "200, 200");
  assert.equal(two("signature_rejected").stops.sh.value, "401 ×3");
  assert.equal(two("resend_not_delivered").stops.sh.value, "401 ×3");
  assert.equal(two("cause_not_in_code").stops.sh.value, "401 ×3");
  for (const s of stories) {
    assert.match(two(s.id).stops.pp.value, /^\d\d:\d\d:\d\d$/, s.id);
    assert.match(two(s.id).stops.db.value, /^\d\d:\d\d:\d\d$/, s.id);
    assert.equal(two(s.id).stops.bk.value, "Paid");
    assert.equal(two(s.id).stops.bk.mark, "bad");
  }
});

test("chapter 3 names the fault in one word: not saved, overwrote, rejected", () => {
  const three = (id: string) => stripScene(stories.find((s) => s.id === id)!.panel, 3, IDLE_RING).stops.sh;
  assert.deepEqual([three("refund_never_booked").value, three("late_payment_overwrites").value, three("signature_rejected").value, three("resend_not_delivered").value, three("cause_not_in_code").value], ["Not saved", "Overwrote", "Rejected", "Rejected", "Rejected"]);
  for (const s of stories) assert.equal(three(s.id).mark, "bad", s.id);
});

test("the replay forks the strip into the good build and the bad build, from the replay's own result", () => {
  for (const s of stories.filter((x) => x.panel.replay)) {
    const r = s.panel.replay!;
    const f = stripScene(s.panel, 4, IDLE_RING);
    assert.equal(f.mode, "fork", s.id);
    assert.deepEqual(STOP_KEYS.filter((k) => f.stops[k].shown), ["db", "sh", "bk", "shB", "bkB"], s.id);
    assert.equal(f.stops.sh.name, r.good.name);
    assert.equal(f.stops.shB.name, r.bad.name);
    assert.equal(f.stops.sh.value, codesGlance(r.good.statuses));
    assert.equal(f.stops.shB.value, codesGlance(r.bad.statuses));
    assert.equal(f.stops.bk.value, r.good.booksShort);
    assert.equal(f.stops.bkB.value, r.bad.booksShort);
    assert.equal(f.stops.bk.mark, r.good.ok ? "ok" : "bad");
    assert.equal(f.stops.bkB.mark, r.bad.ok ? "ok" : "bad");
    assert.deepEqual(f.lit, [...FORK_LINKS]);
    assert.match(f.label, /Good build answers .* the books say Refunded\. Bad build answers .* the books say (Paid|No entry)\./, s.id);
  }
  assert.deepEqual(stripScene(stories[0].panel, 4, IDLE_RING).stops.bkB.value, "No entry", "the bad build of the dropped refund booked nothing at all");
  assert.equal(stripScene(stories[1].panel, 4, IDLE_RING).stops.bkB.value, "Paid", "the bad build of the late payment booked the payment");
});

test("a gap that has no replay keeps the picture of the cause chapter instead of drawing a fork", () => {
  const none = stories.find((s) => s.id === "cause_not_in_code")!;
  assert.equal(none.panel.replay, null);
  const four = stripScene(none.panel, 4, IDLE_RING);
  const three = stripScene(none.panel, 3, IDLE_RING);
  assert.deepEqual(four.stops, three.stops);
  assert.equal(four.mode, "path");
});

test("Ring again: the shop waits while a resend is on its way, the books flip when it is saved, and the road fills to the books only then", () => {
  for (const s of stories) {
    const view = (phase: Phase, stage: RingView["stage"] = "running") => stripScene(s.panel, 6, at(phase, stage));
    assert.equal(view("idle", "idle").stops.pp.value, "Listed", s.id);
    assert.equal(view("idle", "idle").stops.db.value, "Ready");
    assert.equal(view("idle", "idle").stops.sh.mark, "bad", `${s.id}: before the ring the shop is what it was`);
    for (const phase of ["ask", "sent"] as Phase[]) {
      assert.equal(view(phase).stops.sh.mark, "wait", `${s.id} ${phase}`);
      assert.equal(view(phase).stops.sh.value, "Waiting");
    }
    assert.equal(view("sent").stops.pp.value, "Sent again", s.id);
    assert.match(view("sent").stops.db.value, /^\d\d:\d\d:\d\d\.\d$/, "Doorbell says when it asked, to a tenth of a second");
    const arrived = view("arrived");
    assert.equal(arrived.stops.sh.mark, "ok", s.id);
    assert.match(arrived.stops.sh.value, /^\+\d(\.\d)? s$/, "the shop says how long after the ask");
    assert.equal(arrived.stops.bk.mark, "bad");
    assert.equal(arrived.stops.bk.value, "Paid");
    const saved = view("saved", "done");
    assert.equal(saved.stops.bk.mark, "ok");
    assert.equal(saved.stops.bk.value, "Refunded");
    assert.deepEqual(saved.lit, [...PATH_LINKS], `${s.id}: the road reaches the books`);
    assert.deepEqual(view("lost", "done").lit, PATH_LINKS.slice(0, 2), `${s.id}: not when the resend did not arrive`);
    assert.equal(view("lost", "done").stops.sh.value, "Nothing came");
    assert.deepEqual(PHASES.map((p) => stripScene(s.panel, 6, at(p)).mode), PHASES.map(() => "path"));
  }
});

test("the certificate shows where Ring again left things: the picture of chapter 6 in the ring's phase, naming no stop before the ring has run", () => {
  for (const s of stories) {
    const before = stripScene(s.panel, 7, IDLE_RING);
    const idle = stripScene(s.panel, 6, IDLE_RING);
    assert.deepEqual(STOP_KEYS.map((k) => [before.stops[k].mark, before.stops[k].value]), STOP_KEYS.map((k) => [idle.stops[k].mark, idle.stops[k].value]), s.id);
    assert.ok(STOP_KEYS.every((k) => !before.stops[k].active), `${s.id}: no stop is the subject of the certificate`);
    const done = stripScene(s.panel, 7, ringed(s));
    const six = stripScene(s.panel, 6, ringed(s));
    assert.deepEqual(done.stops, six.stops, s.id);
    assert.equal(done.stops.bk.value, ringed(s).phase === "saved" ? "Refunded" : "Paid");
  }
});

test("while Ring again runs the strip draws the ring wherever the reader has scrolled", () => {
  const s = stories[0];
  for (const ch of [1, 2, 3, 4, 5, 7] as ChapterNo[]) {
    assert.deepEqual(stripView(s.panel, ch, at("sent")), { ch: 6, phase: "sent" }, `chapter ${ch}`);
    assert.deepEqual(stripScene(s.panel, ch, at("sent")).stops, stripScene(s.panel, 6, at("sent")).stops);
  }
  assert.deepEqual(stripView(s.panel, 2, IDLE_RING), { ch: 2, phase: "idle" }, "at rest it follows the chapter");
});

test("the name of a stop wears the highlighter for the stop the chapter is about", () => {
  const s = stories[0];
  const who = (ch: ChapterNo, ring = IDLE_RING) => STOP_KEYS.filter((k) => stripScene(s.panel, ch, ring).stops[k].active);
  assert.deepEqual(who(1), ["pp", "bk"]);
  assert.deepEqual(who(3), ["sh"]);
  assert.deepEqual(who(5), ["sh"]);
  assert.deepEqual(who(6), ["db"]);
  assert.deepEqual(who(6, at("saved", "done")), ["bk"]);
  assert.deepEqual(who(4), [], "the fork names no stop");
});

test("what the strip says is short, and it uses none of the ten glossary words, because it comes before the text that explains them", () => {
  const said: string[] = [];
  for (const s of stories) {
    for (const ch of [1, 2, 3, 4, 5, 6, 7] as ChapterNo[]) {
      for (const ring of [IDLE_RING, ...PHASES.map((p) => at(p)), ringed(s)]) {
        const scene = stripScene(s.panel, ch, ring);
        for (const k of STOP_KEYS) said.push(scene.stops[k].name, scene.stops[k].value);
      }
    }
  }
  const words = [...new Set(said.filter(Boolean))];
  assert.ok(words.length > 30, `${words.length} different words`);
  for (const w of words) {
    for (const [id, t] of Object.entries(TERMS)) assert.ok(!new RegExp(t.pattern.source, "i").test(w), `"${w}" is the glossary word ${id}`);
    const time = /^\d\d:\d\d:\d\d(\.\d{1,3})?$/.test(w);
    assert.ok(w.length <= (time ? 10 : 12), `"${w}" is ${w.length} characters: a quarter of a phone's width holds about 12 (a time, 10 in the mono)`);
  }
});

test("a screen reader gets one sentence for the whole strip: the stops and their words, and that it opens the full path", () => {
  for (const s of stories) {
    const label = stripScene(s.panel, 2, IDLE_RING).label;
    assert.match(label, /^Delivery path for order #2, gift set: PayPal \d\d:\d\d:\d\d, Doorbell \d\d:\d\d:\d\d, Your shop .+, Your books Paid\. Open the full path\.$/, s.id);
  }
});

test("codesGlance: one answer, the same answer twice, the same answer many times, and no answer", () => {
  assert.equal(codesGlance([200]), "200 OK");
  assert.equal(codesGlance([401]), "401");
  assert.equal(codesGlance([200, 200]), "200, 200");
  assert.equal(codesGlance([401, 401, 401]), "401 ×3");
  assert.equal(codesGlance([200, 401]), "200, 401");
  assert.equal(codesGlance([]), "No answer");
  assert.equal(codesGlance([null]), "No answer");
});
