// The pre-registered verdict of the sealed evaluation (plan 6.6 and 6.7; docs/planning/eval/SEAL.md, "Pre-registered additions").
// It reads results.json files written by run.ts and computes, with no model call and no network:
//   per set: accuracy with a Wilson 95% interval on N cases, the confidently-wrong count, the H-b split, the original-vs-twin rule,
//   and the three-tier decision with the rule that fired.
//
//   npx tsx eval/harness/verdict.ts --hb <nocomment results.json> --hb-obfuscated <twin results.json> --ha <results.json>
//        [--hb-original <with-comments results.json>] [--b1 <results.json>] [--b2 <results.json>]
//        [--kf-tag key[=value] | --kf-ids id,id,...] [--coauthored id,id,...] [--json]
//
// Readings fixed here (each one is a place where the plan or SEAL.md leaves room; the script prints them next to its numbers):
//  1. Basis. A_b is "H-b 카테고리 정확도" (plan 6.7), so every accuracy, the baselines' included, is CATEGORY accuracy (`cat`).
//     Category-and-pointer (`both`) is printed beside it and decides nothing.
//  2. N is the number of cases. Runs of one case are averaged inside the case (each case contributes the share of its runs that were
//     right) and are not counted as extra trials (plan 6.6). A "count" of right cases can therefore be fractional.
//  3. CW is SEAL.md's `shownWrong`: runs that were "proposed" (passed C2 and C1') with the wrong category. Per case it is the share of
//     its runs, summed over the cases, so with 1 run it is the plain count and with 3 runs it is the mean over runs. The record total
//     (summary.shownWrong, the sum over all runs) is printed too. SEAL.md's sentence also says "or the wrong lines"; that is the harness's
//     `shownNotRight`, a different field, printed as information. The rule uses `shownWrong` because SEAL.md names it and plan 6.6
//     defines the miss as "카테고리가 틀린 경우". CW is taken on H-a (plan 6.6: "N=36에서 5%는 1.8건"); the H-b count is printed, and a
//     warning is raised if adding it would cross a threshold.
//  4. "H-b가 8건 이상" (plan 6.7) is a count of H-b CASES (N >= 8), as the next line says: "H-b가 8건 미만이면 GREEN은 불가". It is not "8 cases right".
//  5. "모델이 B2 이하(전체)" is the model's H-a accuracy <= B2's H-a accuracy (a tie is RED).
//  6. H-b headline (SEAL.md): the `nocomment/` run is the headline input; its obfuscated twin is made from it. If nocomment minus twin
//     is MORE than 15 points, the twin's score is A_b. The with-comments original is secondary and never decides (--hb-original).
//  7. KF is the H-a keyword-free subset, ADV = KF(model) - max(KF(B1), KF(B2)) in points, all on category accuracy.
//
// Fields the development results lack and the sealed ones have (run.ts writes them only for sealed runs or when asked):
//  - `perCase[].B2` (needs `--b2 <module>` on run.ts): a dev file has none. B2 may also come from a second file (`--b2 file`).
//    Without B2 anywhere the verdict is refused, and the refusal names it. B1 is in every file.
//  - `sealed: true` and `summary.set` = "ha" / "hb": a dev file has `sealed: false` and a folder path. Nothing is refused for it,
//    but the output carries a REHEARSAL banner, because a tier from unsealed files is not the registered verdict.
//  - tags: dev labels carry hard/tail/stack; the sealed labels carry the keyword-free and co-author marks (SEAL.md names
//    `ai_attributed_commit`). Where no tag marks a case, --kf-tag / --kf-ids / --coauthored say which cases they are. Nothing is guessed.
//  Everything is derived from `perCase[].runs` (present in every file); summary numbers are only cross-checked when present.
//
// Exit codes: 0 verdict printed, 1 refused (a required number cannot be computed or the files disagree with themselves), 2 bad command line.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isUnderRoot, sealedRootOf } from "./seal.ts";

export class Refusal extends Error {}

const Z = 1.959963984540054; // two-sided 95%
const EPS = 1e-9;
export const RULES = { redAb: 60, redAa: 70, redAdv: 10, redCw: 3, greenAb: 75, greenHbCases: 8, greenAa: 85, greenKf: 80, greenAdv: 20, greenCw: 1, twinGap: 15 } as const;
const AUTO_KF_KEYS = ["keywordFree", "keyword_free", "noKeyword", "no_keyword", "keywordless"];
const COAUTHOR_KEY = "ai_attributed_commit";

// ---- Wilson score interval ----------------------------------------------------------------------------------------------------------

// k successes of n (k may be fractional when runs are averaged). Returns proportions in [0, 1].
export function wilson(k: number, n: number): { lo: number; hi: number } {
  if (!(n > 0) || !Number.isFinite(k) || k < -EPS || k > n + EPS) throw new Refusal(`wilson: ${k} of ${n} is not a count of N cases`);
  const p = Math.min(1, Math.max(0, k / n));
  const denom = 1 + (Z * Z) / n;
  const centre = (p + (Z * Z) / (2 * n)) / denom;
  const half = (Z / denom) * Math.sqrt((p * (1 - p)) / n + (Z * Z) / (4 * n * n));
  return { lo: Math.max(0, centre - half), hi: Math.min(1, centre + half) };
}

// ---- reading a results.json -------------------------------------------------------------------------------------------------------------

export interface RunRow { run?: number; status: string; reason?: string; category?: string; cat: boolean; pointer: boolean; both: boolean }
interface BaselineRow { cat: boolean; pointer: boolean; both: boolean }
export interface CaseRow { id: string; label: string; tags: Record<string, unknown>; runs: RunRow[]; B1?: BaselineRow; B2?: BaselineRow }
export interface Results { source: string; sealed: boolean; set?: string; cases: CaseRow[]; summary: Record<string, unknown> }

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);

function parseBaseline(x: unknown, where: string): BaselineRow | undefined {
  if (x === undefined || x === null) return undefined;
  const s = isObj(x) ? x.score : undefined;
  if (!isObj(s) || typeof s.cat !== "boolean" || typeof s.pointer !== "boolean" || typeof s.both !== "boolean") throw new Refusal(`${where}: baseline has no score {cat, pointer, both}`);
  return { cat: s.cat, pointer: s.pointer, both: s.both };
}

export function parseResults(raw: unknown, source: string): Results {
  if (!isObj(raw) || !Array.isArray(raw.perCase)) throw new Refusal(`${source}: not a results.json from run.ts (no perCase list)`);
  if (raw.perCase.length === 0) throw new Refusal(`${source}: perCase is empty, there is nothing to score`);
  const seen = new Set<string>();
  const cases: CaseRow[] = raw.perCase.map((p: unknown, i: number) => {
    if (!isObj(p) || typeof p.case !== "string" || p.case === "") throw new Refusal(`${source}: perCase[${i}] has no case id`);
    const id = p.case;
    if (seen.has(id)) throw new Refusal(`${source}: case ${id} appears twice`);
    seen.add(id);
    if (!Array.isArray(p.runs) || p.runs.length === 0) throw new Refusal(`${source}: case ${id} has no runs, so it has no score`);
    const runs: RunRow[] = p.runs.map((r: unknown, j: number) => {
      if (!isObj(r) || typeof r.status !== "string" || typeof r.cat !== "boolean" || typeof r.pointer !== "boolean" || typeof r.both !== "boolean") throw new Refusal(`${source}: case ${id} run ${j} lacks status/cat/pointer/both`);
      if (r.both !== (r.cat && r.pointer)) throw new Refusal(`${source}: case ${id} run ${j} says both=${r.both} but cat=${r.cat} and pointer=${r.pointer}`);
      return { run: typeof r.run === "number" ? r.run : j, status: r.status, ...(typeof r.reason === "string" ? { reason: r.reason } : {}), ...(typeof r.category === "string" ? { category: r.category } : {}), cat: r.cat, pointer: r.pointer, both: r.both };
    });
    const row: CaseRow = { id, label: typeof p.label === "string" ? p.label : "", tags: isObj(p.tags) ? p.tags : {}, runs };
    const b1 = parseBaseline(p.B1, `${source}: case ${id} B1`);
    const b2 = parseBaseline(p.B2, `${source}: case ${id} B2`);
    if (b1) row.B1 = b1;
    if (b2) row.B2 = b2;
    return row;
  });

  const summary = isObj(raw.summary) ? raw.summary : {};
  if (typeof summary.cases === "number" && summary.cases !== cases.length) throw new Refusal(`${source}: summary says ${summary.cases} cases but perCase lists ${cases.length}`);
  if (typeof summary.runsPerCase === "number") {
    const odd = cases.filter((c) => c.runs.length !== summary.runsPerCase).map((c) => c.id);
    if (odd.length) throw new Refusal(`${source}: summary says ${summary.runsPerCase} runs per case but ${odd.slice(0, 5).join(", ")}${odd.length > 5 ? ", ..." : ""} differ`);
  }
  const res: Results = { source, sealed: raw.sealed === true, ...(typeof summary.set === "string" ? { set: summary.set } : {}), cases, summary };
  if (typeof summary.shownWrong === "number") {
    const derived = cases.reduce((a, c) => a + c.runs.filter(isShownWrong).length, 0);
    if (derived !== summary.shownWrong) throw new Refusal(`${source}: summary.shownWrong is ${summary.shownWrong} but the runs give ${derived}`);
  }
  return res;
}

// ---- per-case numbers and set metrics ---------------------------------------------------------------------------------------------------

const isShownWrong = (r: RunRow) => r.status === "proposed" && !r.cat; // passed C2 and C1', names the wrong category (SEAL.md: CW := shownWrong)
const isShownNotRight = (r: RunRow) => r.status === "proposed" && !r.both; // plus a wrong line (the harness's shownNotRight)
const share = (runs: RunRow[], f: (r: RunRow) => boolean) => runs.filter(f).length / runs.length;

export interface Acc { k: number; n: number; pct: number; lo: number; hi: number } // pct, lo, hi in percent
function acc(k: number, n: number): Acc {
  if (n === 0) throw new Refusal("accuracy of an empty group cannot be computed");
  const w = wilson(k, n);
  return { k, n, pct: (100 * k) / n, lo: 100 * w.lo, hi: 100 * w.hi };
}

export interface SetMetrics {
  file: string;
  set?: string;
  sealed: boolean;
  n: number;
  runsPerCase: number | string;
  cat: Acc;
  both: Acc;
  cw: number; // shownWrong, mean over runs (see header, point 3)
  cwRecords: number; // shownWrong summed over all runs
  shownNotRight: number; // information only
  notDiagnosed: { case: string; runs: number; reasons: string[] }[];
  infra?: { firstAttemptFailures?: number; retriesMade?: number };
}

export function setMetrics(r: Results, cases: CaseRow[] = r.cases): SetMetrics {
  const runCounts = [...new Set(cases.map((c) => c.runs.length))];
  const nd = cases
    .map((c) => ({ case: c.id, runs: c.runs.filter((x) => x.status === "not_diagnosed").length, reasons: [...new Set(c.runs.filter((x) => x.status === "not_diagnosed").map((x) => x.reason ?? "unknown"))] }))
    .filter((x) => x.runs > 0);
  return {
    file: r.source,
    ...(r.set !== undefined ? { set: r.set } : {}),
    sealed: r.sealed,
    n: cases.length,
    runsPerCase: runCounts.length === 1 ? runCounts[0] : runCounts.join("/"),
    cat: acc(cases.reduce((a, c) => a + share(c.runs, (x) => x.cat), 0), cases.length),
    both: acc(cases.reduce((a, c) => a + share(c.runs, (x) => x.both), 0), cases.length),
    cw: cases.reduce((a, c) => a + share(c.runs, isShownWrong), 0),
    cwRecords: cases.reduce((a, c) => a + c.runs.filter(isShownWrong).length, 0),
    shownNotRight: cases.reduce((a, c) => a + share(c.runs, isShownNotRight), 0),
    notDiagnosed: nd,
    ...(typeof r.summary.infraFirstAttemptFailures === "number" || typeof r.summary.infraRetriesMade === "number"
      ? { infra: { ...(typeof r.summary.infraFirstAttemptFailures === "number" ? { firstAttemptFailures: r.summary.infraFirstAttemptFailures } : {}), ...(typeof r.summary.infraRetriesMade === "number" ? { retriesMade: r.summary.infraRetriesMade } : {}) } }
      : {}),
  };
}

// ---- subsets: keyword-free (H-a) and co-authored (H-b) ----------------------------------------------------------------------------------

export interface Options {
  kfTag?: string; // "key" or "key=value"
  kfIds?: string[];
  coauthored?: string[];
}

const truthy = (x: unknown) => x === true || x === 1 || (typeof x === "string" && /^(true|yes|1)$/i.test(x.trim()));

function selectKf(ha: Results, o: Options, problems: string[]): { ids: Set<string>; how: string } | undefined {
  if (o.kfIds) {
    const known = new Set(ha.cases.map((c) => c.id));
    const unknown = o.kfIds.filter((i) => !known.has(i));
    if (unknown.length) return void problems.push(`--kf-ids names ${unknown.join(", ")}, which are not cases of ${ha.source}`);
    return { ids: new Set(o.kfIds), how: `--kf-ids list (${o.kfIds.length})` };
  }
  const spec = o.kfTag;
  const keys = spec ? [spec.split("=")[0]] : AUTO_KF_KEYS;
  const value = spec?.includes("=") ? spec.slice(spec.indexOf("=") + 1) : undefined;
  const key = keys.find((k) => ha.cases.some((c) => k in c.tags));
  if (!key) {
    return void problems.push(
      `the H-a keyword-free subset (KF) cannot be found: no case in ${ha.source} carries ${spec ? `the tag ${spec.split("=")[0]}` : `one of the tags ${AUTO_KF_KEYS.join(", ")}`}; pass --kf-tag key[=value] or --kf-ids id,id,...`,
    );
  }
  const ids = new Set(ha.cases.filter((c) => (value === undefined ? truthy(c.tags[key]) : String(c.tags[key]) === value)).map((c) => c.id));
  if (ids.size === 0) return void problems.push(`the tag ${key}${value !== undefined ? `=${value}` : ""} selects no H-a case, so KF cannot be computed`);
  return { ids, how: `tag ${key}${value !== undefined ? `=${value}` : ""}` };
}

function selectCoauthored(files: Results[], o: Options, problems: string[]): { ids: Set<string>; how: string } | undefined {
  if (o.coauthored) {
    const known = new Set(files[0].cases.map((c) => c.id));
    const unknown = o.coauthored.filter((i) => !known.has(i));
    if (unknown.length) return void problems.push(`--coauthored names ${unknown.join(", ")}, which are not cases of ${files[0].source}`);
    return { ids: new Set(o.coauthored), how: `--coauthored list (${o.coauthored.length})` };
  }
  const f = files.find((x) => x.cases.some((c) => COAUTHOR_KEY in c.tags));
  if (!f) return void problems.push(`the H-b split (Claude co-authored commits vs the others) cannot be made: no case carries the tag ${COAUTHOR_KEY}; pass --coauthored id,id,...`);
  return { ids: new Set(f.cases.filter((c) => truthy(c.tags[COAUTHOR_KEY])).map((c) => c.id)), how: `tag ${COAUTHOR_KEY} in ${f.source}` };
}

// ---- the three tiers --------------------------------------------------------------------------------------------------------------------

export interface TierInput { Ab: number; nHb: number; Aa: number; B2a: number; KF: number; ADV: number; CW: number }
export interface Check { id: string; rule: string; value: string; met: boolean }
export interface TierOut { tier: "RED" | "AMBER" | "GREEN"; reds: Check[]; greens: Check[]; decidedBy: string }

const lt = (a: number, b: number) => a < b - EPS;
const le = (a: number, b: number) => a <= b + EPS;
const ge = (a: number, b: number) => a >= b - EPS;
const f1 = (x: number) => (Math.round(x * 10) / 10).toFixed(1);
const num = (x: number) => (Number.isInteger(Math.round(x * 100) / 100) ? String(Math.round(x * 100) / 100) : (Math.round(x * 100) / 100).toFixed(2));

export function decideTier(i: TierInput): TierOut {
  for (const [k, v] of Object.entries(i)) if (!Number.isFinite(v)) throw new Refusal(`the tier cannot be decided: ${k} is not a number`);
  const reds: Check[] = [
    { id: "A_b", rule: `A_b < ${RULES.redAb}%`, value: `${f1(i.Ab)}%`, met: lt(i.Ab, RULES.redAb) },
    { id: "A_a", rule: `A_a < ${RULES.redAa}%`, value: `${f1(i.Aa)}%`, met: lt(i.Aa, RULES.redAa) },
    { id: "ADV", rule: `ADV < +${RULES.redAdv} points`, value: `${i.ADV >= 0 ? "+" : ""}${f1(i.ADV)}`, met: lt(i.ADV, RULES.redAdv) },
    { id: "model<=B2", rule: "model <= B2 (H-a overall)", value: `model ${f1(i.Aa)}% vs B2 ${f1(i.B2a)}%`, met: le(i.Aa, i.B2a) },
    { id: "CW", rule: `CW >= ${RULES.redCw}`, value: num(i.CW), met: ge(i.CW, RULES.redCw) },
  ];
  const greens: Check[] = [
    { id: "A_b", rule: `A_b >= ${RULES.greenAb}%`, value: `${f1(i.Ab)}%`, met: ge(i.Ab, RULES.greenAb) },
    { id: "H-b cases", rule: `H-b has >= ${RULES.greenHbCases} cases`, value: String(i.nHb), met: i.nHb >= RULES.greenHbCases },
    { id: "A_a", rule: `A_a >= ${RULES.greenAa}%`, value: `${f1(i.Aa)}%`, met: ge(i.Aa, RULES.greenAa) },
    { id: "KF", rule: `KF >= ${RULES.greenKf}%`, value: `${f1(i.KF)}%`, met: ge(i.KF, RULES.greenKf) },
    { id: "ADV", rule: `ADV >= +${RULES.greenAdv} points`, value: `${i.ADV >= 0 ? "+" : ""}${f1(i.ADV)}`, met: ge(i.ADV, RULES.greenAdv) },
    { id: "CW", rule: `CW <= ${RULES.greenCw}`, value: num(i.CW), met: le(i.CW, RULES.greenCw) },
  ];
  const fired = reds.filter((c) => c.met);
  if (fired.length) return { tier: "RED", reds, greens, decidedBy: `RED, rule 1: ${fired.map((c) => `${c.rule} (${c.value})`).join("; ")}` };
  const unmet = greens.filter((c) => !c.met);
  if (unmet.length === 0) return { tier: "GREEN", reds, greens, decidedBy: "GREEN, rule 2: no RED trigger, and all six GREEN conditions hold" };
  return { tier: "AMBER", reds, greens, decidedBy: `AMBER, rule 3: no RED trigger, GREEN not reached: ${unmet.map((c) => `${c.rule} (${c.value})`).join("; ")}` };
}

// ---- the whole verdict -----------------------------------------------------------------------------------------------------------------

export interface Inputs { hb: Results; hbObfuscated?: Results; hbOriginal?: Results; ha: Results; b1?: Results; b2?: Results }

export interface Report {
  rehearsal: boolean; // true when any input is not a sealed run: the tier is then not the registered verdict
  tier: TierOut;
  numbers: { Ab: number; nHb: number; Aa: number; KF: number; ADV: number; CW: number; B1a: number; B2a: number };
  hb: {
    headline: "nocomment" | "obfuscated twin";
    headlineMetrics: SetMetrics;
    nocomment: SetMetrics;
    obfuscated: SetMetrics;
    originalWithComments?: SetMetrics;
    gapPoints: number; // nocomment minus twin, accuracy points
    twinRuleFires: boolean;
    coauthored: { how: string; withCoauthor: SetMetrics; others: SetMetrics };
    coverageNote: string;
  };
  ha: {
    metrics: SetMetrics;
    kf: { how: string; n: number; ids: string[]; model: Acc; B1: Acc; B2: Acc };
    B1: Acc;
    B2: Acc;
  };
  warnings: string[];
}

export function computeVerdict(inp: Inputs, o: Options = {}): Report {
  const problems: string[] = [];
  const warnings: string[] = [];
  const { hb, hbObfuscated, hbOriginal, ha } = inp;

  if (!hbObfuscated) problems.push("the obfuscated twin of the H-b run is missing (--hb-obfuscated): without it the 15-point original-vs-twin rule (SEAL.md) cannot be applied, so A_b is not known");

  // baselines for the H-a cases
  const bMap = (which: "B1" | "B2"): Map<string, BaselineRow> | undefined => {
    const src = inp[which === "B1" ? "b1" : "b2"] ?? ha;
    const m = new Map<string, BaselineRow>();
    for (const c of src.cases) if (c[which]) m.set(c.id, c[which]!);
    const missing = ha.cases.filter((c) => !m.has(c.id)).map((c) => c.id);
    if (missing.length) {
      problems.push(
        `${which} results are missing for ${missing.length} of ${ha.cases.length} H-a cases (${missing.slice(0, 6).join(", ")}${missing.length > 6 ? ", ..." : ""}) in ${src.source}; ` +
          (which === "B2" ? "run the harness on the set with --b2 <module> (sealed: --sealed ha,b2), or pass --b2 <results.json> that has perCase B2" : "pass --b1 <results.json> that has perCase B1"),
      );
      return undefined;
    }
    if (src !== ha) {
      const extra = src.cases.filter((c) => !ha.cases.some((h) => h.id === c.id)).length;
      if (extra) warnings.push(`${src.source} has ${extra} cases that are not in the H-a file; they are ignored`);
    }
    return m;
  };
  const b1 = bMap("B1");
  const b2 = bMap("B2");
  const kf = selectKf(ha, o, problems);
  const co = selectCoauthored([hb, ...(hbOriginal ? [hbOriginal] : []), ...(hbObfuscated ? [hbObfuscated] : [])], o, problems);
  if (problems.length) throw new Refusal(`refused, a required number cannot be computed:\n  - ${problems.join("\n  - ")}`);
  const B1 = b1!, B2 = b2!;

  // ---- H-b: headline and the twin rule
  const nocomment = setMetrics(hb);
  const obfuscated = setMetrics(hbObfuscated!);
  const gap = nocomment.cat.pct - obfuscated.cat.pct;
  const twinFires = gap > RULES.twinGap + EPS;
  const headlineRes = twinFires ? hbObfuscated! : hb;
  const headline = twinFires ? obfuscated : nocomment;
  const idsOf = (r: Results) => new Set(r.cases.map((c) => c.id));
  const a = idsOf(hb), b = idsOf(hbObfuscated!);
  if (a.size !== b.size || [...a].some((i) => !b.has(i))) warnings.push(`the H-b run and its twin do not list the same case ids (${a.size} vs ${b.size}); the 15-point gap compares their overall accuracies`);
  if (hb.cases.length !== 12) warnings.push(`H-b has ${hb.cases.length} cases (plan target 12, floor 8)`);
  if (headline.n < RULES.greenHbCases) warnings.push(`H-b has ${headline.n} cases, fewer than ${RULES.greenHbCases}: GREEN is not possible (plan 6.7)`);

  const coRows = headlineRes.cases.filter((c) => co!.ids.has(c.id));
  const otherRows = headlineRes.cases.filter((c) => !co!.ids.has(c.id));
  const stray = [...co!.ids].filter((i) => !headlineRes.cases.some((c) => c.id === i));
  if (stray.length) warnings.push(`co-author marks for ${stray.join(", ")} have no case in ${headlineRes.source}`);
  if (coRows.length === 0 || otherRows.length === 0) {
    throw new Refusal(`refused, a required number cannot be computed:\n  - the H-b split has ${coRows.length} co-authored and ${otherRows.length} other cases in ${headlineRes.source} (${co!.how}); both groups must be non-empty`);
  }
  if (coRows.length !== 6 || otherRows.length !== 6) warnings.push(`the H-b split is ${coRows.length} co-authored and ${otherRows.length} other (plan and SEAL.md say 6 and 6)`);

  // ---- H-a
  const haMet = setMetrics(ha);
  const kfRows = ha.cases.filter((c) => kf!.ids.has(c.id));
  const kfModel = acc(kfRows.reduce((s, c) => s + share(c.runs, (x) => x.cat), 0), kfRows.length);
  const kfB1 = acc(kfRows.reduce((s, c) => s + (B1.get(c.id)!.cat ? 1 : 0), 0), kfRows.length);
  const kfB2 = acc(kfRows.reduce((s, c) => s + (B2.get(c.id)!.cat ? 1 : 0), 0), kfRows.length);
  const B1a = acc(ha.cases.reduce((s, c) => s + (B1.get(c.id)!.cat ? 1 : 0), 0), ha.cases.length);
  const B2a = acc(ha.cases.reduce((s, c) => s + (B2.get(c.id)!.cat ? 1 : 0), 0), ha.cases.length);
  const ADV = kfModel.pct - Math.max(kfB1.pct, kfB2.pct);
  if (![36, 24].includes(ha.cases.length)) warnings.push(`H-a has ${ha.cases.length} cases (plan: 36, or 24 if cut)`);
  if (![15, 12].includes(kfRows.length)) warnings.push(`the keyword-free subset has ${kfRows.length} cases (plan: 15, or 12 if cut): check ${kf!.how}`);

  const numbers = { Ab: headline.cat.pct, nHb: headline.n, Aa: haMet.cat.pct, KF: kfModel.pct, ADV, CW: haMet.cw, B1a: B1a.pct, B2a: B2a.pct };
  const tier = decideTier({ Ab: numbers.Ab, nHb: numbers.nHb, Aa: numbers.Aa, B2a: numbers.B2a, KF: numbers.KF, ADV, CW: numbers.CW });

  // CW on H-b: would the other reading change the tier?
  const cwBoth = haMet.cw + headline.cw;
  if (headline.cw > 0) {
    const alt = decideTier({ ...numbers, CW: cwBoth });
    if (alt.tier !== tier.tier) warnings.push(`CW is taken on H-a (${num(haMet.cw)}); counting H-b's ${num(headline.cw)} as well (${num(cwBoth)}) would give ${alt.tier}, not ${tier.tier}`);
  }
  const checked: [string, SetMetrics][] = [["H-b nocomment", nocomment], ["H-b twin", obfuscated], ["H-a", haMet]];
  if (hbOriginal) checked.push(["H-b with comments", setMetrics(hbOriginal)]);
  for (const [name, m] of checked) {
    if (!m.sealed) warnings.push(`REHEARSAL: ${name} (${m.file}) is not a sealed run (sealed=false), so this is not the registered verdict`);
    if (m.notDiagnosed.length) warnings.push(`${name}: ${m.notDiagnosed.length} case(s) not diagnosed (${m.notDiagnosed.slice(0, 5).map((x) => `${x.case}: ${x.reasons.join("/")}`).join("; ")}); they are scored as misses`);
  }

  return {
    rehearsal: warnings.some((w) => w.startsWith("REHEARSAL")),
    tier,
    numbers,
    hb: {
      headline: twinFires ? "obfuscated twin" : "nocomment",
      headlineMetrics: headline,
      nocomment,
      obfuscated,
      ...(hbOriginal ? { originalWithComments: setMetrics(hbOriginal) } : {}),
      gapPoints: gap,
      twinRuleFires: twinFires,
      coauthored: { how: co!.how, withCoauthor: setMetrics(headlineRes, coRows), others: setMetrics(headlineRes, otherRows) },
      coverageNote: "H-b covers 3 of the 8 categories (SEAL.md): A_b is accuracy on those, not on all categories",
    },
    ha: { metrics: haMet, kf: { how: kf!.how, n: kfRows.length, ids: kfRows.map((c) => c.id), model: kfModel, B1: kfB1, B2: kfB2 }, B1: B1a, B2: B2a },
    warnings,
  };
}

// ---- text report -----------------------------------------------------------------------------------------------------------------------

const accStr = (a: Acc) => `${f1(a.pct)}% (${num(a.k)}/${a.n}) 95% CI ${f1(a.lo)} to ${f1(a.hi)}`;
const sign = (x: number) => `${x >= 0 ? "+" : ""}${f1(x)}`;

export function renderText(r: Report): string {
  const L: string[] = [];
  if (r.rehearsal) L.push("*** REHEARSAL: at least one input is not a sealed run; this is not the registered verdict ***", "");
  L.push("Doorbell sealed evaluation: three-tier verdict (plan 6.6, 6.7)");
  L.push("Basis: category accuracy. N = cases; runs of one case are averaged inside it, not counted as extra trials. Wilson 95% interval on N.", "");

  const h = r.hb;
  L.push(`H-b  headline = ${h.headline}${h.twinRuleFires ? " (original minus twin > 15 points: the twin's score is A_b)" : ""}`);
  L.push(`  nocomment (headline input)  N=${h.nocomment.n}, runs/case ${h.nocomment.runsPerCase}  ${accStr(h.nocomment.cat)}   [category+pointer ${f1(h.nocomment.both.pct)}%]  CW ${num(h.nocomment.cw)}`);
  L.push(`  obfuscated twin             N=${h.obfuscated.n}, runs/case ${h.obfuscated.runsPerCase}  ${accStr(h.obfuscated.cat)}   [category+pointer ${f1(h.obfuscated.both.pct)}%]  CW ${num(h.obfuscated.cw)}`);
  L.push(`  gap nocomment - twin = ${sign(h.gapPoints)} points (rule: more than ${RULES.twinGap} makes the twin the headline) -> ${h.twinRuleFires ? "TWIN IS THE HEADLINE" : "nocomment stays the headline"}`);
  if (h.originalWithComments) L.push(`  with comments (secondary, decides nothing)  N=${h.originalWithComments.n}  ${accStr(h.originalWithComments.cat)}`);
  L.push(`  split of the headline (${h.coauthored.how}):`);
  L.push(`    Claude co-authored commits  N=${h.coauthored.withCoauthor.n}  ${accStr(h.coauthored.withCoauthor.cat)}`);
  L.push(`    the other commits           N=${h.coauthored.others.n}  ${accStr(h.coauthored.others.cat)}`);
  L.push(`  ${h.coverageNote}`, "");

  const a = r.ha;
  L.push(`H-a  N=${a.metrics.n}, runs/case ${a.metrics.runsPerCase}`);
  L.push(`  model             ${accStr(a.metrics.cat)}   [category+pointer ${f1(a.metrics.both.pct)}%]`);
  L.push(`  B1 (frozen regex) ${accStr(a.B1)}`);
  L.push(`  B2 (checklist)    ${accStr(a.B2)}`);
  L.push(`  keyword-free subset KF (${a.kf.how}), n=${a.kf.n}:`);
  L.push(`    model ${accStr(a.kf.model)}`);
  L.push(`    B1    ${accStr(a.kf.B1)}`);
  L.push(`    B2    ${accStr(a.kf.B2)}`);
  L.push(`  ADV = KF(model) - max(KF(B1), KF(B2)) = ${sign(r.numbers.ADV)} points`);
  L.push(`  CW (shown wrong, passed C2 and C1') = ${num(a.metrics.cw)}   [run records ${a.metrics.cwRecords}; shown with a wrong line too ${num(a.metrics.shownNotRight)}]`, "");

  L.push(`TIER: ${r.tier.tier}`);
  L.push(`  decided by ${r.tier.decidedBy}`);
  L.push("  RED triggers   " + r.tier.reds.map((c) => `${c.met ? "FIRED " : "no    "}${c.rule} (${c.value})`).join("\n                 "));
  L.push("  GREEN needs    " + r.tier.greens.map((c) => `${c.met ? "met   " : "unmet "}${c.rule} (${c.value})`).join("\n                 "));
  if (r.warnings.length) L.push("", "Warnings:", ...r.warnings.map((w) => `  - ${w}`));
  return L.join("\n");
}

// ---- command line ----------------------------------------------------------------------------------------------------------------------

const VALUE_FLAGS = ["hb", "hb-original", "hb-obfuscated", "ha", "b1", "b2", "kf-tag", "kf-ids", "coauthored"] as const;

export interface Io { out: (s: string) => void; err: (s: string) => void; read?: (path: string) => string; sealedRoot?: string }

export function run(argv: string[], io: Io): number {
  const read = io.read ?? ((p: string) => readFileSync(p, "utf8"));
  const sealedRoot = io.sealedRoot ?? sealedRootOf(process.env.HOME ?? homedir());
  const flags = new Map<string, string>();
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") json = true;
    else if (a.startsWith("--") && (VALUE_FLAGS as readonly string[]).includes(a.slice(2))) {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) {
        io.err(`${a} needs a value`);
        return 2;
      }
      flags.set(a.slice(2), v);
    } else {
      io.err(`unknown argument ${a}\nusage: verdict.ts --hb <results.json> --hb-obfuscated <results.json> --ha <results.json> [--hb-original f] [--b1 f] [--b2 f] [--kf-tag key[=value] | --kf-ids a,b] [--coauthored a,b] [--json]`);
      return 2;
    }
  }
  try {
    for (const need of ["hb", "ha"]) if (!flags.has(need)) throw new Refusal(`refused, a required number cannot be computed: --${need} <results.json> is missing`);
    const load = (flag: string): Results | undefined => {
      const p = flags.get(flag);
      if (p === undefined) return undefined;
      if (isUnderRoot(p, sealedRoot)) throw new Refusal(`refusing to read ${p}: it is inside the sealed folder; this script reads results.json files only`);
      let raw: unknown;
      try {
        raw = JSON.parse(read(resolve(p)));
      } catch (e) {
        throw new Refusal(`--${flag} ${p}: cannot read it as JSON (${(e as Error).message.slice(0, 120)})`);
      }
      return parseResults(raw, p);
    };
    const list = (flag: string) => flags.get(flag)?.split(",").map((s) => s.trim()).filter(Boolean);
    const report = computeVerdict(
      { hb: load("hb")!, hbObfuscated: load("hb-obfuscated"), hbOriginal: load("hb-original"), ha: load("ha")!, b1: load("b1"), b2: load("b2") },
      { kfTag: flags.get("kf-tag"), kfIds: list("kf-ids"), coauthored: list("coauthored") },
    );
    io.out(json ? JSON.stringify(report, null, 2) : renderText(report));
    return 0;
  } catch (e) {
    if (e instanceof Refusal) {
      io.err(e.message);
      return 1;
    }
    throw e;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(run(process.argv.slice(2), { out: (s) => console.log(s), err: (s) => console.error(s) }));
}
