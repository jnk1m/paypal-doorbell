// The verdict script, offline: the Wilson interval against known values, every tier rule on synthetic results, the twin rule, the
// reading of "H-b가 8건 이상", and the refusals. Synthetic results objects have the shape run.ts writes; nothing here reads a real result
// or the sealed folder.
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeVerdict, decideTier, parseResults, Refusal, renderText, run, wilson, type Inputs, type Options, type Results } from "./verdict.ts";

// ---- synthetic results.json ------------------------------------------------------------------------------------------------------------

type Outcome = "ok" | "wrong" | "miss" | "fail"; // right / proposed with the wrong category (shownWrong) / not proven or abstained wrongly / not diagnosed
interface CaseSpec { id: string; tags?: Record<string, unknown>; model: Outcome[]; b1?: boolean; b2?: boolean }

const runRow = (o: Outcome, j: number) => ({
  run: j,
  status: o === "ok" || o === "wrong" ? "proposed" : o === "miss" ? "not_proven" : "not_diagnosed",
  ...(o === "miss" ? { reason: "model_abstained" } : o === "fail" ? { reason: "timeout" } : {}),
  cat: o === "ok",
  pointer: o === "ok",
  both: o === "ok",
});
const base = (b: boolean) => ({ category: "X", evidence_line: "", score: { cat: b, pointer: b, both: b } });

function raw(cases: CaseSpec[], sealed = true, set = "ha"): unknown {
  const runs = cases[0].model.length;
  return {
    sealed,
    summary: { set, cases: cases.length, runsPerCase: runs, shownWrong: cases.reduce((a, c) => a + c.model.filter((o) => o === "wrong").length, 0) },
    perCase: cases.map((c) => ({
      case: c.id,
      label: "RAW_BODY_ALTERED",
      tags: c.tags ?? {},
      runs: c.model.map(runRow),
      ...(c.b1 === undefined ? {} : { B1: base(c.b1) }),
      ...(c.b2 === undefined ? {} : { B2: base(c.b2) }),
    })),
  };
}
const parse = (cases: CaseSpec[], name = "x.json", sealed = true, set = "ha"): Results => parseResults(raw(cases, sealed, set), name);

// H-b: n cases, `right` of them correct (one run each), the first `co` are marked as Claude co-authored.
function hbSpec(n: number, right: number, co = Math.min(6, n - 1)): CaseSpec[] {
  return Array.from({ length: n }, (_, i) => ({ id: `HB${i + 1}`, tags: { ai_attributed_commit: i < co }, model: [i < right ? "ok" : "miss"] as Outcome[] }));
}

// H-a: n cases of which the first kfN are keyword-free (tag keywordFree). aOK right overall, kfOK of them in KF; the first `cw` wrong answers
// are shown wrong (the rest are misses). B1/B2: right overall and within KF.
interface HaShape { n: number; kfN: number; aOK: number; kfOK: number; cw?: number; b1: [number, number]; b2: [number, number] }
function haSpec(s: HaShape): CaseSpec[] {
  const out: CaseSpec[] = [];
  let kfSeen = 0, restSeen = 0, wrongLeft = s.cw ?? 0;
  for (let i = 0; i < s.n; i++) {
    const kf = i < s.kfN;
    const idx = kf ? kfSeen++ : restSeen++;
    const ok = kf ? idx < s.kfOK : idx < s.aOK - s.kfOK;
    let model: Outcome = "ok";
    if (!ok) model = wrongLeft-- > 0 ? "wrong" : "miss";
    const b = (pair: [number, number]) => (kf ? idx < pair[1] : idx < pair[0] - pair[1]);
    out.push({ id: `HA${i + 1}`, tags: { keywordFree: kf }, model: [model], b1: b(s.b1), b2: b(s.b2) });
  }
  return out;
}
// n=40, 20 keyword-free: one case = 2.5 points overall and 5 points in KF.
const GREEN_HA: HaShape = { n: 40, kfN: 20, aOK: 36, kfOK: 18, b1: [20, 4], b2: [22, 8] };

function inputs(hb: CaseSpec[], twin: CaseSpec[], ha: HaShape | CaseSpec[], extra: Partial<Inputs> = {}): Inputs {
  return { hb: parse(hb, "hb.json", true, "hb"), hbObfuscated: parse(twin, "twin.json", true, "hb"), ha: parse(Array.isArray(ha) ? ha : haSpec(ha), "ha.json"), ...extra };
}
const verdict = (i: Inputs, o: Options = {}) => computeVerdict(i, o);
const tierOf = (hb: CaseSpec[], ha: HaShape, twin = hb) => verdict(inputs(hb, twin, ha));
const firedReds = (r: ReturnType<typeof tierOf>) => r.tier.reds.filter((c) => c.met).map((c) => c.id);

// ---- Wilson ------------------------------------------------------------------------------------------------------------------------------

test("wilson: known values (5 of 10; 0 of 10; the plan's 6.6 examples 31/36, 21/24, 11/12)", () => {
  const close = (a: number, b: number, tol = 5e-4) => assert.ok(Math.abs(a - b) < tol, `${a} vs ${b}`);
  const w = wilson(5, 10); // centre 0.5, half-width 0.2634: 0.2366 to 0.7634
  close(w.lo, 0.2366);
  close(w.hi, 0.7634);
  const z = wilson(0, 10); // upper bound = z^2 / (n + z^2) = 0.2775
  assert.equal(z.lo, 0);
  close(z.hi, 0.2775);
  // the plan: "H-a 36건에서 31건 = 86%, 구간 약 71~94%", "N=24에서 21건이면 69~96%", "12건 중 11건 ... 구간 65~99%"
  for (const [k, n, lo, hi] of [[31, 36, 71, 94], [21, 24, 69, 96], [11, 12, 65, 99]] as const) {
    const x = wilson(k, n);
    assert.equal(Math.round(100 * x.lo), lo, `${k}/${n} lower`);
    assert.equal(Math.round(100 * x.hi), hi, `${k}/${n} upper`);
  }
  close(wilson(10, 10).hi, 1, 1e-12);
});

test("wilson: refuses a count that is not out of N", () => {
  assert.throws(() => wilson(1, 0), Refusal);
  assert.throws(() => wilson(11, 10), Refusal);
  assert.throws(() => wilson(Number.NaN, 10), Refusal);
});

// ---- the tier rules ----------------------------------------------------------------------------------------------------------------------

test("GREEN: every condition holds -> GREEN, with the numbers", () => {
  const r = tierOf(hbSpec(12, 10), GREEN_HA);
  assert.equal(r.tier.tier, "GREEN");
  assert.equal(r.numbers.Aa, 90);
  assert.equal(r.numbers.KF, 90);
  assert.equal(r.numbers.ADV, 50); // 90 - max(20, 40)
  assert.equal(r.numbers.CW, 0);
  assert.ok(Math.abs(r.numbers.Ab - (100 * 10) / 12) < 1e-9);
  assert.match(r.tier.decidedBy, /^GREEN, rule 2/);
});

test("RED by A_b < 60 (and 60.0 exactly is not RED)", () => {
  const below = tierOf(hbSpec(12, 7), GREEN_HA); // 58.3
  assert.equal(below.tier.tier, "RED");
  assert.deepEqual(firedReds(below), ["A_b"]);
  const exactly = tierOf(hbSpec(10, 6), GREEN_HA); // 60.0
  assert.equal(exactly.tier.tier, "AMBER");
  assert.deepEqual(firedReds(exactly), []);
});

test("RED by A_a < 70 (and 70.0 exactly is not RED)", () => {
  const below = tierOf(hbSpec(12, 10), { ...GREEN_HA, aOK: 27, kfOK: 18 }); // 67.5
  assert.equal(below.tier.tier, "RED");
  assert.deepEqual(firedReds(below), ["A_a"]);
  const exactly = tierOf(hbSpec(12, 10), { ...GREEN_HA, aOK: 28, kfOK: 18 }); // 70.0
  assert.deepEqual(firedReds(exactly), []);
  assert.equal(exactly.tier.tier, "AMBER");
});

test("RED by ADV < +10 (and +10 exactly is not RED; +20 exactly is enough for GREEN)", () => {
  // model KF 18/20 = 90; B2 KF 17/20 = 85 -> ADV +5
  const small = tierOf(hbSpec(12, 10), { ...GREEN_HA, b2: [22, 17] });
  assert.equal(small.numbers.ADV, 5);
  assert.equal(small.tier.tier, "RED");
  assert.deepEqual(firedReds(small), ["ADV"]);
  const ten = tierOf(hbSpec(12, 10), { ...GREEN_HA, b2: [22, 16] }); // 90 - 80
  assert.equal(ten.numbers.ADV, 10);
  assert.equal(ten.tier.tier, "AMBER");
  const twenty = tierOf(hbSpec(12, 10), { ...GREEN_HA, b2: [22, 14] }); // 90 - 70
  assert.equal(twenty.numbers.ADV, 20);
  assert.equal(twenty.tier.tier, "GREEN");
});

test("ADV is measured against the LARGER of B1 and B2", () => {
  const r = tierOf(hbSpec(12, 10), { ...GREEN_HA, b1: [25, 17], b2: [22, 8] }); // B1 KF 85 beats B2 KF 40
  assert.equal(r.numbers.ADV, 5);
  assert.equal(r.tier.tier, "RED");
});

test("RED when the model is not above B2 overall: a tie is RED, a loss is RED, a lead is not", () => {
  // model 30/40 = 75% (all 20 keyword-free right); B2 is built to have the same, one more, one fewer right overall, with a low KF so that ADV stays large
  const shape = { ...GREEN_HA, aOK: 30, kfOK: 20 };
  const tie = tierOf(hbSpec(12, 10), { ...shape, b2: [30, 10] });
  assert.equal(tie.tier.tier, "RED");
  assert.deepEqual(firedReds(tie), ["model<=B2"]);
  const loss = tierOf(hbSpec(12, 10), { ...shape, b2: [31, 11] });
  assert.deepEqual(firedReds(loss), ["model<=B2"]);
  const lead = tierOf(hbSpec(12, 10), { ...shape, b2: [29, 9] });
  assert.deepEqual(firedReds(lead), []);
  assert.equal(lead.tier.tier, "AMBER");
});

test("RED by CW >= 3; CW 2 is not RED but is not GREEN either; CW 1 is allowed in GREEN", () => {
  const three = tierOf(hbSpec(12, 10), { ...GREEN_HA, cw: 3 });
  assert.equal(three.tier.tier, "RED");
  assert.deepEqual(firedReds(three), ["CW"]);
  assert.equal(three.numbers.CW, 3);
  const two = tierOf(hbSpec(12, 10), { ...GREEN_HA, cw: 2 });
  assert.equal(two.tier.tier, "AMBER");
  assert.match(two.tier.decidedBy, /CW <= 1/);
  const one = tierOf(hbSpec(12, 10), { ...GREEN_HA, cw: 1 });
  assert.equal(one.tier.tier, "GREEN");
});

test("CW counts only runs that were shown with the wrong category, not misses or failures; with 3 runs it is the mean over runs", () => {
  // 3 runs per case. HA39 and HA40 are the two wrong cases of GREEN_HA (non-keyword-free).
  const three = haSpec(GREEN_HA).map((c) => ({ ...c, model: [c.model[0], c.model[0], c.model[0]] }));
  three[38].model = ["wrong", "wrong", "wrong"]; // shown wrong in every run: share 1
  three[39].model = ["wrong", "miss", "fail"]; // shown wrong once, then a miss and a failure: share 1/3
  const two = verdict({ ...inputs(hbSpec(12, 10), hbSpec(12, 10), GREEN_HA), ha: parse(three, "ha3.json") });
  assert.ok(Math.abs(two.numbers.CW - (1 + 1 / 3)) < 1e-9, String(two.numbers.CW));
  assert.equal(two.ha.metrics.cwRecords, 4);
});

test("AMBER: no RED trigger, GREEN missed on one condition each", () => {
  const cases: [string, ReturnType<typeof tierOf>, RegExp][] = [
    ["A_b 66.7", tierOf(hbSpec(12, 8), GREEN_HA), /A_b >= 75/],
    ["A_a 82.5", tierOf(hbSpec(12, 10), { ...GREEN_HA, aOK: 33 }), /A_a >= 85/],
    ["KF 75", tierOf(hbSpec(12, 10), { ...GREEN_HA, kfOK: 15, aOK: 36 }), /KF >= 80/],
    ["ADV +15", tierOf(hbSpec(12, 10), { ...GREEN_HA, b2: [22, 15] }), /ADV >= \+20/],
  ];
  for (const [name, r, why] of cases) {
    assert.equal(r.tier.tier, "AMBER", name);
    assert.match(r.tier.decidedBy, /^AMBER, rule 3/, name);
    assert.match(r.tier.decidedBy, why, name);
  }
});

test("RED is checked first: a case that is both RED and not GREEN is RED", () => {
  const r = tierOf(hbSpec(12, 6), { ...GREEN_HA, aOK: 20, kfOK: 10 });
  assert.equal(r.tier.tier, "RED");
  assert.ok(firedReds(r).length >= 2);
  assert.match(r.tier.decidedBy, /^RED, rule 1/);
});

test("decideTier on the boundaries of the table (75 / 85 / 80 / +20 / <=1 / 8 cases)", () => {
  const g = { Ab: 75, nHb: 8, Aa: 85, B2a: 60, KF: 80, ADV: 20, CW: 1 };
  assert.equal(decideTier(g).tier, "GREEN");
  for (const bad of [{ Ab: 74.9 }, { nHb: 7 }, { Aa: 84.9 }, { KF: 79.9 }, { ADV: 19.9 }, { CW: 1.01 }]) assert.equal(decideTier({ ...g, ...bad }).tier, "AMBER", JSON.stringify(bad));
  assert.throws(() => decideTier({ ...g, KF: Number.NaN }), Refusal);
});

// ---- "H-b가 8건 이상" is a count of cases ------------------------------------------------------------------------------------------------

test("GREEN needs H-b to have 8 or more CASES (plan 6.7), not 8 cases right", () => {
  // 8 cases, 6 right = 75%: enough cases, and A_b is 75 -> GREEN. A reading of "8 right" would call this AMBER.
  const eightCases = tierOf(hbSpec(8, 6, 3), GREEN_HA);
  assert.equal(eightCases.numbers.nHb, 8);
  assert.equal(eightCases.tier.tier, "GREEN");
  // 7 cases, all right = 100%, but fewer than 8 cases -> at most AMBER
  const sevenCases = tierOf(hbSpec(7, 7, 3), GREEN_HA);
  assert.equal(sevenCases.tier.tier, "AMBER");
  assert.match(sevenCases.tier.decidedBy, /H-b has >= 8 cases \(7\)/);
  assert.ok(sevenCases.warnings.some((w) => /GREEN is not possible/.test(w)));
});

// ---- the original-vs-twin rule -----------------------------------------------------------------------------------------------------------

test("twin rule: a gap of exactly 15 points keeps nocomment; more than 15 makes the twin the headline", () => {
  const nocomment = hbSpec(20, 18, 10); // 90.0
  const equal15 = verdict(inputs(nocomment, hbSpec(20, 15, 10), GREEN_HA)); // 75.0 -> gap 15.0
  assert.equal(equal15.hb.gapPoints, 15);
  assert.equal(equal15.hb.twinRuleFires, false);
  assert.equal(equal15.hb.headline, "nocomment");
  assert.equal(equal15.numbers.Ab, 90);
  const over = verdict(inputs(nocomment, hbSpec(20, 14, 10), GREEN_HA)); // 70.0 -> gap 20
  assert.equal(over.hb.twinRuleFires, true);
  assert.equal(over.hb.headline, "obfuscated twin");
  assert.equal(over.numbers.Ab, 70);
  assert.equal(over.tier.tier, "AMBER"); // A_b 70 is under 75
  assert.match(renderText(over), /TWIN IS THE HEADLINE/);
});

test("twin rule: when the twin is the headline its low score can make the verdict RED; a twin that scores higher changes nothing", () => {
  const red = verdict(inputs(hbSpec(20, 18, 10), hbSpec(20, 10, 10), GREEN_HA)); // twin 50
  assert.equal(red.numbers.Ab, 50);
  assert.equal(red.tier.tier, "RED");
  const higher = verdict(inputs(hbSpec(20, 15, 10), hbSpec(20, 18, 10), GREEN_HA));
  assert.equal(higher.hb.gapPoints, -15);
  assert.equal(higher.hb.twinRuleFires, false);
  assert.equal(higher.numbers.Ab, 75);
});

test("the with-comments original is reported but decides nothing", () => {
  const withComments = parse(hbSpec(12, 12), "orig.json", true, "hb");
  const r = verdict(inputs(hbSpec(12, 10), hbSpec(12, 10), GREEN_HA, { hbOriginal: withComments }));
  assert.equal(r.hb.originalWithComments?.cat.pct, 100);
  assert.equal(r.numbers.Ab, (100 * 10) / 12);
});

test("H-b split: co-authored vs other, by the tag ai_attributed_commit or by --coauthored", () => {
  // cases 0-2 right and 3-5 wrong (co-authored); 6-11 right (others)
  const hb = hbSpec(12, 0, 6).map((c, i) => ({ ...c, model: [i < 3 || i >= 6 ? "ok" : "miss"] as Outcome[] }));
  const r = verdict(inputs(hb, hb, GREEN_HA));
  assert.equal(r.hb.coauthored.withCoauthor.n, 6);
  assert.equal(r.hb.coauthored.others.n, 6);
  assert.equal(r.hb.coauthored.withCoauthor.cat.pct, 50);
  assert.equal(r.hb.coauthored.others.cat.pct, 100);
  // without the tag, a list does the same
  const untagged = hb.map(({ tags: _t, ...c }) => c);
  const byList = verdict(inputs(untagged, untagged, GREEN_HA), { coauthored: ["HB1", "HB2", "HB3", "HB4", "HB5", "HB6"] });
  assert.equal(byList.hb.coauthored.withCoauthor.cat.pct, 50);
  assert.match(byList.hb.coauthored.how, /--coauthored/);
});

// ---- refusals: a number that cannot be computed is never invented ----------------------------------------------------------------------

const refusal = (f: () => unknown) => {
  try {
    f();
  } catch (e) {
    assert.ok(e instanceof Refusal, `expected a Refusal, got ${e}`);
    return (e as Error).message;
  }
  assert.fail("expected a refusal");
};

test("refuses without B2 (dev-style results have only B1), and says where B2 comes from", () => {
  const ha = haSpec(GREEN_HA).map(({ b2: _b, ...c }) => c);
  const msg = refusal(() => verdict(inputs(hbSpec(12, 10), hbSpec(12, 10), ha)));
  assert.match(msg, /B2 results are missing for 40 of 40 H-a cases/);
  assert.match(msg, /--b2/);
  assert.doesNotMatch(msg, /B1 results are missing/);
});

test("B2 can come from a second results file, matched by case id", () => {
  const ha = haSpec(GREEN_HA).map(({ b2: _b, ...c }) => c);
  const b2file = parse(haSpec(GREEN_HA).map((c) => ({ ...c, b1: undefined })), "b2.json");
  const r = verdict(inputs(hbSpec(12, 10), hbSpec(12, 10), ha, { b2: b2file }));
  assert.equal(r.tier.tier, "GREEN");
  // a B2 file that lacks some of the H-a cases is refused, naming them
  const partial = parse(haSpec(GREEN_HA).slice(0, 30), "b2-partial.json");
  assert.match(refusal(() => verdict(inputs(hbSpec(12, 10), hbSpec(12, 10), ha, { b2: partial }))), /B2 results are missing for 10 of 40 H-a cases \(HA31/);
});

test("refuses without the obfuscated twin: the 15-point rule is part of the registered verdict", () => {
  const i = inputs(hbSpec(12, 10), hbSpec(12, 10), GREEN_HA);
  delete i.hbObfuscated;
  assert.match(refusal(() => verdict(i)), /--hb-obfuscated/);
});

test("refuses when no tag marks the keyword-free subset, or the tag selects nothing, or an id is unknown", () => {
  const noTag = haSpec(GREEN_HA).map(({ tags: _t, ...c }) => c);
  assert.match(refusal(() => verdict(inputs(hbSpec(12, 10), hbSpec(12, 10), noTag))), /keyword-free subset \(KF\) cannot be found/);
  assert.match(refusal(() => verdict(inputs(hbSpec(12, 10), hbSpec(12, 10), noTag), { kfTag: "hard" })), /no case in ha.json carries the tag hard/);
  const none = haSpec(GREEN_HA).map((c) => ({ ...c, tags: { keywordFree: false } }));
  assert.match(refusal(() => verdict(inputs(hbSpec(12, 10), hbSpec(12, 10), none))), /selects no H-a case/);
  assert.match(refusal(() => verdict(inputs(hbSpec(12, 10), hbSpec(12, 10), noTag), { kfIds: ["HA1", "nope"] })), /nope/);
  // and the same data works once the subset is named
  const named = verdict(inputs(hbSpec(12, 10), hbSpec(12, 10), noTag), { kfIds: Array.from({ length: 20 }, (_, i) => `HA${i + 1}`) });
  assert.equal(named.numbers.KF, 90);
  assert.match(named.ha.kf.how, /--kf-ids/);
  // a tag with a value
  const staged = haSpec(GREEN_HA).map((c) => ({ ...c, tags: { stratum: c.tags?.keywordFree ? "keyword_free" : "easy" } }));
  assert.equal(verdict(inputs(hbSpec(12, 10), hbSpec(12, 10), staged), { kfTag: "stratum=keyword_free" }).ha.kf.n, 20);
});

test("refuses when nothing marks the co-authored commits, or the mark leaves a group empty", () => {
  const untagged = hbSpec(12, 10).map(({ tags: _t, ...c }) => c);
  assert.match(refusal(() => verdict(inputs(untagged, untagged, GREEN_HA))), /no case carries the tag ai_attributed_commit/);
  const allMarked = hbSpec(12, 10, 12);
  assert.match(refusal(() => verdict(inputs(allMarked, allMarked, GREEN_HA))), /12 co-authored and 0 other/);
});

test("refuses a results file that disagrees with itself or has nothing to score", () => {
  assert.throws(() => parseResults({ perCase: [] }, "e.json"), /empty/);
  assert.throws(() => parseResults({}, "e.json"), /perCase/);
  const good = raw(hbSpec(3, 2, 1)) as { summary: { shownWrong: number }; perCase: { runs: unknown[]; case: string }[] };
  assert.throws(() => parseResults({ ...good, summary: { ...good.summary, shownWrong: 5 } }, "e.json"), /shownWrong is 5/);
  assert.throws(() => parseResults({ ...good, summary: { ...good.summary, cases: 9 } }, "e.json"), /9 cases/);
  assert.throws(() => parseResults({ perCase: [{ ...good.perCase[0], runs: [] }] }, "e.json"), /no runs/);
  assert.throws(() => parseResults({ perCase: [good.perCase[0], good.perCase[0]] }, "e.json"), /twice/);
  const bad = structuredClone(good) as typeof good & { perCase: { runs: { both: boolean; cat: boolean }[] }[] };
  bad.perCase[0].runs[0].both = true;
  bad.perCase[0].runs[0].cat = false;
  assert.throws(() => parseResults(bad, "e.json"), /both=true but cat=false/);
});

test("a development-style result (sealed=false) is read, and the report carries a REHEARSAL banner", () => {
  const i = inputs(hbSpec(12, 10), hbSpec(12, 10), GREEN_HA);
  i.ha = parse(haSpec(GREEN_HA), "dev.json", false, "eval/dev");
  const r = verdict(i);
  assert.ok(r.warnings.some((w) => /^REHEARSAL: H-a/.test(w)));
  assert.equal(r.rehearsal, true);
  assert.match(renderText(r), /^\*\*\* REHEARSAL/);
});

test("not-diagnosed cases are scored as misses and listed", () => {
  const ha = haSpec(GREEN_HA);
  ha[0] = { ...ha[0], model: ["fail"] };
  const r = verdict(inputs(hbSpec(12, 10), hbSpec(12, 10), ha));
  assert.equal(r.ha.metrics.notDiagnosed[0].case, "HA1");
  assert.ok(r.warnings.some((w) => /not diagnosed \(HA1: timeout\)/.test(w)));
  assert.equal(r.ha.metrics.cat.k, 35);
});

test("CW on H-b is reported with a warning only when counting it would change the tier", () => {
  const hb = hbSpec(12, 10).map((c, i) => (i >= 10 ? { ...c, model: ["wrong"] as Outcome[] } : c)); // two shown wrong on H-b
  const r = verdict(inputs(hb, hb, { ...GREEN_HA, cw: 1 }));
  assert.equal(r.tier.tier, "GREEN"); // H-a CW is 1
  assert.ok(r.warnings.some((w) => /would give RED, not GREEN/.test(w)));
  const quiet = verdict(inputs(hbSpec(12, 10), hbSpec(12, 10), GREEN_HA));
  assert.ok(!quiet.warnings.some((w) => /CW is taken on H-a/.test(w)));
});

// ---- command line --------------------------------------------------------------------------------------------------------------------------

function cli(args: string[], files: Record<string, unknown>) {
  const out: string[] = [];
  const err: string[] = [];
  const code = run(args, {
    out: (s) => out.push(s),
    err: (s) => err.push(s),
    read: (p) => {
      const hit = Object.keys(files).find((k) => p.endsWith(k));
      if (!hit) throw new Error(`ENOENT ${p}`);
      return JSON.stringify(files[hit]);
    },
    sealedRoot: "/nonexistent-sealed-root-for-test",
  });
  return { code, out: out.join("\n"), err: err.join("\n") };
}
const FILES = () => ({
  "hb.json": raw(hbSpec(12, 10), true, "hb"),
  "twin.json": raw(hbSpec(12, 10), true, "hb"),
  "ha.json": raw(haSpec(GREEN_HA), true, "ha,b2"),
});
const ARGS = ["--hb", "hb.json", "--hb-obfuscated", "twin.json", "--ha", "ha.json"];

test("cli: exit 0 and a text report; --json prints a parseable object with the same tier", () => {
  const text = cli(ARGS, FILES());
  assert.equal(text.code, 0);
  assert.match(text.out, /TIER: GREEN/);
  assert.match(text.out, /95% CI/);
  assert.doesNotMatch(text.out, /REHEARSAL/);
  const json = cli([...ARGS, "--json"], FILES());
  assert.equal(json.code, 0);
  const parsed = JSON.parse(json.out);
  assert.equal(parsed.tier.tier, "GREEN");
  assert.equal(parsed.rehearsal, false);
  assert.equal(parsed.numbers.nHb, 12);
  assert.equal(typeof parsed.ha.kf.model.lo, "number");
});

test("cli: exit 1 with the missing thing named; exit 2 for a bad command line", () => {
  const noTwin = cli(["--hb", "hb.json", "--ha", "ha.json"], FILES());
  assert.equal(noTwin.code, 1);
  assert.match(noTwin.err, /--hb-obfuscated/);
  assert.equal(noTwin.out, "");
  const noHa = cli(["--hb", "hb.json", "--hb-obfuscated", "twin.json"], FILES());
  assert.equal(noHa.code, 1);
  assert.match(noHa.err, /--ha <results.json> is missing/);
  const unreadable = cli([...ARGS.slice(0, 5), "missing.json"], FILES());
  assert.equal(unreadable.code, 1);
  assert.match(unreadable.err, /--ha missing.json: cannot read it as JSON/);
  assert.equal(cli([...ARGS, "--bogus"], FILES()).code, 2);
  assert.equal(cli(["--hb"], FILES()).code, 2);
});

test("cli: --kf-ids and --coauthored reach the computation; a path inside the sealed folder is refused", () => {
  const files = FILES();
  const stripKf = raw(haSpec(GREEN_HA).map(({ tags: _t, ...c }) => c), true, "ha");
  const needsKf = cli(ARGS, { ...files, "ha.json": stripKf });
  assert.equal(needsKf.code, 1);
  assert.match(needsKf.err, /--kf-tag/);
  const named = cli([...ARGS, "--kf-ids", Array.from({ length: 20 }, (_, i) => `HA${i + 1}`).join(",")], { ...files, "ha.json": stripKf });
  assert.equal(named.code, 0, named.err);
  const stripCo = raw(hbSpec(12, 10).map(({ tags: _t, ...c }) => c), true, "hb");
  assert.equal(cli(ARGS, { ...files, "hb.json": stripCo, "twin.json": stripCo }).code, 1);
  assert.equal(cli([...ARGS, "--coauthored", "HB1,HB2,HB3,HB4,HB5,HB6"], { ...files, "hb.json": stripCo, "twin.json": stripCo }).code, 0);

  const out: string[] = [];
  const err: string[] = [];
  const code = run(["--hb", "/tmp/sealed-root/hb/label.json", "--ha", "ha.json"], { out: (s) => out.push(s), err: (s) => err.push(s), read: () => "{}", sealedRoot: "/tmp/sealed-root" });
  assert.equal(code, 1);
  assert.match(err.join(""), /inside the sealed folder/);
});
