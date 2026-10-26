// The numbers ledger of docs/judge-pack.md. Every row is computed from a measurement file when this script runs, so a number in the pack cannot
// drift from the file it came from: `npx tsx scripts/numbers-ledger.ts` rewrites the two marked blocks of the pack, `--check` only compares them
// (scripts/numbers-ledger.test.ts runs the same comparison). The files are read, never written. A number that is not in a file is not computed
// here; those few live in the pack's "from the log" list, with their date.
//
//   docs/measurements/*.json      the measurement records of the build (S2 to S5, the recordings, the disputes probe)
//   eval/runs/*/results.json      the development-set runs of the cause step (read only; the evaluation folder is frozen)
//   fixtures/recorded-run/*.json  the six recorded stories (only their id, title and capture time are used here)
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SCENARIO_LABEL } from "../lib/ui/phrases.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const PACK_PATH = join(ROOT, "docs", "judge-pack.md");

export const LEDGER_START = "<!-- ledger:start -->";
export const LEDGER_END = "<!-- ledger:end -->";
export const STORIES_START = "<!-- stories:start -->";
export const STORIES_END = "<!-- stories:end -->";

export interface Row {
  id: string; // "H3": group letter and number; the pack cites it as [H3]
  number: string; // the figure as the pack quotes it; the pack's line that cites the row must contain this exact text
  measures: string;
  source: string; // file, then the fields the number is computed from
  date: string; // YYYY-MM-DD (UTC); a dagger marks a file that stores no date
}
interface Group {
  title: string;
  rows: Row[];
}

// ---- reading ------------------------------------------------------------------------------------------------------------------------------

type Json = any; // the measurement files are not one schema; every field used below is checked by need()
const read = (rel: string): Json => JSON.parse(readFileSync(join(ROOT, rel), "utf8"));
const M = (name: string): Json => read(`docs/measurements/${name}`);

function need<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined || (typeof value === "number" && Number.isNaN(value))) throw new Error(`numbers-ledger: ${what} is missing from its file`);
  return value;
}
function expect(cond: boolean, what: string): void {
  if (!cond) throw new Error(`numbers-ledger: the file does not say what the ledger row assumes: ${what}`);
}

const day = (t: string | number): string => {
  const d = new Date(t);
  if (Number.isNaN(d.getTime())) throw new Error(`numbers-ledger: not a date: ${String(t)}`);
  return d.toISOString().slice(0, 10);
};
// Files that store no date. The date is the one the log gives for the step that measured them (S2, S3: 2026-10-19), marked with a dagger.
const UNDATED = "†";
const undated = (d: string): string => `${d} ${UNDATED}`;

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const lo = (xs: number[]): number => Math.min(...xs);
const hi = (xs: number[]): number => Math.max(...xs);
const f1 = (x: number): string => String(Number(x.toFixed(1))); // 39 not 39.0
const f2 = (x: number): string => x.toFixed(2);
const f4 = (x: number): string => x.toFixed(4);
const range1 = (xs: number[], unit: string): string => `${f1(lo(xs))} to ${f1(hi(xs))} ${unit}`;

// ---- the rows -----------------------------------------------------------------------------------------------------------------------------

export function ledgerGroups(): Group[] {
  const groups: Group[] = [];
  const add = (title: string, rows: Row[]): void => void groups.push({ title, rows });

  // The summary files store no date; the trial files they were computed from carry the time of every poll.
  const trialFiles = [M("s3-trials-run1.json"), M("s3-trials-run2.json")];
  const trialDays = trialFiles.map((t, i) => day(need(t.trials?.[0]?.polls?.[0]?.at, `s3-trials-run${i + 1}.json trials[0].polls[0].at`)));
  const trialDate = trialDays[0] === trialDays[1] ? trialDays[0] : `${trialDays[0]} to ${trialDays[1]}`;

  // ---- finding the gaps (S3) ----
  {
    const f = "docs/measurements/s3-a3-run1.json";
    const a3 = M("s3-a3-run1.json");
    const date = day(need(a3.refundedAt, `${f} refundedAt`));
    const runs: Json[] = need(a3.runs, `${f} runs`);
    expect(runs.length === 3, `${f} has 3 scans`);
    const found = runs.map((r) => need(r.found, `${f} runs[].found`));
    const refunds = runs.map((r) => need(r.calls?.refunds, `${f} runs[].calls.refunds`));
    const captures = runs.map((r) => need(r.calls?.captures, `${f} runs[].calls.captures`));
    expect(new Set(refunds).size === 1 && new Set(captures).size === 1, `${f} every scan covers the same captures`);
    const alarms = runs.map((r) => need(r.falseAlarms, `${f} runs[].falseAlarms`));
    const serverS = runs.map((r) => need(r.serverMs, `${f} runs[].serverMs`) / 1000);
    const m = need(a3.mocked, `${f} mocked`);

    const g = "docs/measurements/s3-summary.json";
    const s3 = M("s3-summary.json");
    const a4 = need(s3.a4, `${g} a4`);
    const abs = M("s3-absence-run1.json");
    const checks: Json[] = need(abs.checks, "s3-absence-run1.json checks");
    const firstClaim = checks.findIndex((c) => c.rows.some((r: Json) => r.status === "GAP"));
    expect(firstClaim > 0, "s3-absence-run1.json has a check with a claim, and not the first");
    const claimRows: Json[] = checks[firstClaim].rows;
    const evClass = (name: string): number => claimRows.filter((r) => r.ev.some((e: string) => e.includes(`:${name}:`))).length;
    const finals: Json[] = need(a4.finalSecondsAfterD, `${g} a4.finalSecondsAfterD`);
    const byMode = (mode: string, key: string): number[] => finals.filter((x) => x.mode === mode).map((x) => need(x[key], `${g} a4.finalSecondsAfterD[].${key}`));
    const ack = byMode("ack_then_drop", "afterDReceipt");
    const bad = byMode("bad_body", "afterDReceipt");
    const lwwGap = byMode("last_write_wins", "afterGapCreated");
    const lwwD = byMode("last_write_wins", "afterDReceipt");

    add("Finding the gaps", [
      { id: "G1", number: new Set(found).size === 1 ? `${found[0]} of ${refunds[0]} in each of 3 scans` : `${found.join(" / ")} of ${refunds[0]}`, measures: `Refund gaps found in 3 scans of one ${captures[0]}-capture session in which ${refunds[0]} captures had been refunded`, source: `${f}: runs[].found, runs[].calls`, date },
      { id: "G2", number: new Set(alarms).size === 1 ? `${alarms[0]} in each of 3 scans` : alarms.join(" / "), measures: "False alarms in those 3 scans (a capture flagged as a gap that PayPal agrees with)", source: `${f}: runs[].falseAlarms`, date },
      { id: "G3", number: range1(serverS, "s"), measures: `Server time of a scan of ${captures[0]} captures (3 scans)`, source: `${f}: runs[].serverMs`, date },
      { id: "G4", number: `${need(m.tiedAmongFailed, `${f} mocked.tiedAmongFailed`)} of ${need(m.failedReads, `${f} mocked.failedReads`)}`, measures: "Rows marked tied among the rows whose re-query of PayPal failed (the failures were simulated); they stay unverified", source: `${f}: mocked`, date },
      { id: "G5", number: `${need(a4.withTheExpectedClass, `${g} a4.withTheExpectedClass`)} of ${need(a4.validTrials, `${g} a4.validTrials`)}`, measures: "Valid trials (3 planted bugs, 3 each) that ended in the expected evidence class; wrong final classes: " + need(a4.confirmedWrong, `${g} a4.confirmedWrong`), source: `${g}: a4`, date: trialDate },
      { id: "G6", number: `${need(a4.absenceClaimsBeforeSixMinutes, `${g} a4.absenceClaimsBeforeSixMinutes`)} claims`, measures: `"Missing" claims made before the 6-minute window; ${need(a4.scansThatHeldAnAbsenceClaimBack, `${g} a4.scansThatHeldAnAbsenceClaimBack`)} scans held one back`, source: `${g}: a4`, date: trialDate },
      {
        id: "G7",
        number: `${f1(need(checks[firstClaim].afterMs, "s3-absence-run1.json checks[].afterMs") / 1000)} s`,
        measures: `Time of the first check that called an event absent (the "${checks[firstClaim].label}" check): ${evClass("NO_REPORT")} no report from the shop, ${evClass("NO_EVENT_FOUND")} no event found, ${checks[firstClaim].resendsUsed} resends used. The ${firstClaim} earlier checks, the last at ${f1(checks[firstClaim - 1].afterMs / 1000)} s, called nothing absent`,
        source: "docs/measurements/s3-absence-run1.json: checks[]",
        date: undated("2026-10-19"),
      },
      { id: "G8", number: range1(ack, "s"), measures: `Gap called after the witness heard the event, scenario "Dropped after a 200 OK" (${ack.length} trials)`, source: `${g}: a4.finalSecondsAfterD`, date: trialDate },
      { id: "G9", number: range1(bad, "s"), measures: `Gap called after the witness heard the event, scenario "Rejected with 401 three times" (${bad.length} trials)`, source: `${g}: a4.finalSecondsAfterD`, date: trialDate },
      { id: "G10", number: range1(lwwGap, "s"), measures: `Gap called after the late payment arrived, scenario "A late payment wins" (${lwwGap.length} trials); counted from the first event the witness heard (the refund) it is ${range1(lwwD, "s")}`, source: `${g}: a4.finalSecondsAfterD`, date: trialDate },
    ]);
  }

  // ---- ringing again (S3) ----
  {
    const g = "docs/measurements/s3-summary.json";
    const s3 = M("s3-summary.json");
    const a5 = need(s3.a5, `${g} a5`);
    const [t1, t2] = trialFiles;
    const trials: Json[] = [...need(t1.trials, "s3-trials-run1.json trials"), ...need(t2.trials, "s3-trials-run2.json trials")];
    expect(trials.length === need(s3.attempts, `${g} attempts`), "the two trial files hold the attempts the summary counts");
    const heals = trials.filter((t) => t.expectedHeal === "healed");
    const answered200 = heals.filter((t) => t.mode !== "bad_body");
    const rejected401 = heals.filter((t) => t.mode === "bad_body");
    const healed = (xs: Json[]): number => xs.filter((t) => t.heal?.state === "healed").length;
    const lost = (xs: Json[]): number => xs.filter((t) => t.heal?.state === "lost").length;
    const sends = (xs: Json[]): number => xs.reduce((n, t) => n + (t.heal?.sends ?? 0), 0);
    const control = trials.filter((t) => t.expectedHeal === "unchanged");
    expect(control.length === 1, "one control trial without the fix");
    const arrivedSends = (xs: Json[]): number => xs.filter((t) => t.heal && t.heal.arrivalSeconds !== undefined).length;
    const miss200 = answered200.find((t) => t.heal?.state !== "healed");
    const arr: number[] = need(a5.arrivalSecondsAfter202, `${g} a5.arrivalSecondsAfter202`);
    const toTied: number[] = need(a5.timeFromDetectionToTiedSeconds, `${g} a5.timeFromDetectionToTiedSeconds`);
    const ringToTied: number[] = need(a5.timeFromRingToTiedSeconds, `${g} a5.timeFromRingToTiedSeconds`);
    const retrying: Json[] = need(a5.resendWhilePayPalRetries, `${g} a5.resendWhilePayPalRetries`);
    const ctl = need(a5.controlNoFix, `${g} a5.controlNoFix`);
    const cross = M("s3-cross-run1.json");
    const dates = trialDate;

    add("Ringing again (resends)", [
      { id: "H1", number: `${healed(answered200)} of ${answered200.length}`, measures: `Trials that healed when the shop had answered 200 to the event (scenarios "Dropped after a 200 OK" and "A late payment wins", 3 trials each in each of 2 runs); the one that did not ended: "${need(miss200?.failure, "the failure text of the one 200-group trial that did not heal")}"`, source: "docs/measurements/s3-trials-run1.json, s3-trials-run2.json: trials[] (mode, expectedHeal, heal.state, failure)", date: dates },
      { id: "H2", number: `${healed(rejected401)} of ${rejected401.length}`, measures: `Trial entries that healed when the shop had rejected the event with 401 three times (scenario "Rejected with 401 three times", some trials repeated after a failed attempt); ${lost(rejected401)} ended with 3 resends accepted by PayPal and none delivered, ${rejected401.length - healed(rejected401) - lost(rejected401)} never reached a ring that was ready within 300 s`, source: "docs/measurements/s3-trials-run1.json, s3-trials-run2.json: trials[]", date: dates },
      { id: "H3", number: `${arrivedSends(answered200) + arrivedSends(control)} of ${sends(answered200) + sends(control)}`, measures: "Resends that reached the shop when the shop had answered 200 (the control trial included); counted as one arrival per trial that ended in a delivery", source: "docs/measurements/s3-trials-run1.json, s3-trials-run2.json: trials[].heal", date: dates },
      { id: "H4", number: `${arrivedSends(rejected401)} of ${sends(rejected401)}`, measures: "Resends that reached the shop when the shop had rejected the event with 401 three times", source: "docs/measurements/s3-trials-run1.json, s3-trials-run2.json: trials[].heal", date: dates },
      { id: "H5", number: `${range1(arr, "s")}, median ${f1(median(arr))} s`, measures: `Time from PayPal accepting a resend to the delivery reaching the shop (${arr.length} healed rows)`, source: `${g}: a5.arrivalSecondsAfter202`, date: trialDate },
      { id: "H6", number: `median ${f1(median(toTied))} s`, measures: `Time from the gap being called to the row being tied again (${toTied.length} healed rows; range ${range1(toTied, "s")}); resends are about 60 s apart, so rows that needed 2 or 3 resends take minutes`, source: `${g}: a5.timeFromDetectionToTiedSeconds`, date: trialDate },
      { id: "H7", number: `median ${f1(median(ringToTied))} s`, measures: `Time from pressing Ring again to the row being tied again (same ${ringToTied.length} rows; range ${range1(ringToTied, "s")})`, source: `${g}: a5.timeFromRingToTiedSeconds`, date: trialDate },
      { id: "H8", number: `${need(a5.earlyRingsNotListed, `${g} a5.earlyRingsNotListed`)} of ${need(a5.earlyRings, `${g} a5.earlyRings`)}`, measures: `Early Ring requests (made before the row was ready) that were refused with nothing sent because PayPal had not listed the event yet; the other ${need(a5.earlyRingsThatSentSomething, `${g} a5.earlyRingsThatSentSomething`)} found the event already listed and sent`, source: `${g}: a5.earlyRings, earlyRingsNotListed, earlyRingsThatSentSomething`, date: trialDate },
      { id: "H9", number: `${ctl.filter((c: Json) => c.rowTied === false && c.state === "unchanged").length} of ${ctl.length}`, measures: "Control without the code fix: the resend arrived and the row stayed open, as it should (a resend heals nothing if the shop still drops the event)", source: `${g}: a5.controlNoFix`, date: trialDate },
      { id: "H10", number: `${retrying.filter((r: Json) => r.arrivedWhileRetrying).length} of ${retrying.filter((r: Json) => r.accepted).length}`, measures: "Resends sent while PayPal was still retrying the event on its own: how many of the accepted resends reached the shop (the product locks Ring again in that window)", source: `${g}: a5.resendWhilePayPalRetries`, date: trialDate },
      { id: "H11", number: `${cross.statuses.filter((s: number) => s === 403).length} of ${cross.statuses.length}`, measures: `Requests with another session's capture, refund, order or event ids that were refused with 403; resends used by either session: ${need(cross.resendsUsedA, "s3-cross-run1.json resendsUsedA") + need(cross.resendsUsedB, "s3-cross-run1.json resendsUsedB")}`, source: "docs/measurements/s3-cross-run1.json: statuses, resendsUsedA, resendsUsedB", date: undated("2026-10-19") },
    ]);
  }

  // ---- the sealed evaluation (held-out sets, run 2026-10-26 after the seal commit; docs/planning/eval/SEAL.md) ----
  {
    const sealed = (rel: string): Json => {
      const r = read(rel);
      expect(r.sealed === true, `${rel} is a sealed run`);
      return r;
    };
    const ha = sealed("eval/runs/sealed-ha/results+b2.json");
    const hb = sealed("eval/runs/sealed-hb-nocomment/results.json");
    const twin = sealed("eval/runs/sealed-hb-obfuscated/results.json");
    const orig = sealed("eval/runs/sealed-hb-original/results.json");
    const per = (r: Json, name: string): Json[] => need(r.perCase, `${name} perCase`);
    // Runs are averaged inside a case (each case contributes the share of its runs that were right), as verdict.ts does: N is the number of cases.
    const mean = (rows: Json[], ok: (run: Json) => boolean): number => rows.reduce((s, c) => s + c.runs.filter(ok).length / c.runs.length, 0);
    const f2 = (x: number): string => (Number.isInteger(x) ? String(x) : x.toFixed(2));
    const cat = (rows: Json[]) => f2(mean(rows, (r) => r.cat));
    const haPer = per(ha, "sealed-ha"), hbPer = per(hb, "sealed-hb-nocomment"), twinPer = per(twin, "sealed-hb-obfuscated"), origPer = per(orig, "sealed-hb-original");
    expect(haPer.length === 35, "sealed H-a has 35 cases: ha-35 was excluded before the run (SEAL.md)");
    const runs = need(ha.summary?.runsPerCase, "sealed-ha summary.runsPerCase");
    const allRuns = haPer.filter((c) => c.runs.every((r: Json) => r.cat)).length;
    const kf = haPer.filter((c) => c.tags?.mix === "keywordless");
    const base = (rows: Json[], which: "B1" | "B2") => rows.filter((c) => need(c[which]?.score?.cat, `sealed-ha ${which}.score.cat`) === true).length;
    const cw = mean(haPer, (r) => r.status === "proposed" && !r.cat);
    const co = hbPer.filter((c) => c.tags?.ai_attributed_commit === true), notCo = hbPer.filter((c) => c.tags?.ai_attributed_commit === false);
    expect(co.length === 6 && notCo.length === 6, "H-b splits 6 and 6 by the co-author tag (SEAL.md)");
    const spend = [ha, hb, twin, orig].reduce((s, r) => s + need(r.summary?.spendUsd, "sealed summary.spendUsd"), 0);
    add("The sealed evaluation: held-out sets, run on 2026-10-26 after the seal commit (docs/planning/eval/SEAL.md)", [
      { id: "S1", number: `${cat(haPer)} of ${haPer.length}`, measures: `H-a cases (written in a separate session) where the model named the right category, averaged over ${runs} runs per case (${allRuns} right in all runs); category and cited line: ${f2(mean(haPer, (r) => r.both))} of ${haPer.length}`, source: "eval/runs/sealed-ha/results+b2.json: perCase[].runs[].cat, .both", date: day(need(ha.startedAt, "sealed-ha startedAt")) },
      { id: "S2", number: `${base(haPer, "B1")} of ${haPer.length}`, measures: "The same H-a cases the frozen regular-expression baseline (B1, no AI) gets right", source: "eval/runs/sealed-ha/results+b2.json: perCase[].B1.score.cat", date: day(ha.startedAt) },
      { id: "S3", number: `${base(haPer, "B2")} of ${haPer.length}`, measures: "The same H-a cases the sealed checklist baseline (B2, written in a separate session, run as the program it is) gets right", source: "eval/runs/sealed-ha/results+b2.json: perCase[].B2.score.cat", date: day(ha.startedAt) },
      { id: "S4", number: `${cat(kf)} of ${kf.length}`, measures: `H-a cases tagged keyword-free (the diff carries no category word): the model; the baselines on the same cases: B1 ${base(kf, "B1")} of ${kf.length}, B2 ${base(kf, "B2")} of ${kf.length}`, source: "eval/runs/sealed-ha/results+b2.json: perCase[].tags.mix, runs[].cat, B1, B2", date: day(ha.startedAt) },
      { id: "S5", number: `${f2(cw)} of ${haPer.length}`, measures: "H-a cases where an answer passed both code checks and named the wrong category (confidently wrong), averaged over runs; the pre-registered limit for the top tier is 1", source: "eval/runs/sealed-ha/results+b2.json: perCase[].runs[].status, .cat", date: day(ha.startedAt) },
      { id: "S6", number: `${cat(hbPer)} of ${hbPer.length}`, measures: `H-b cases (rebuilt from real public fix commits, the fixer's comments removed) with the right category, averaged over runs; the ${co.length} commits with a Claude co-author trailer ${cat(co)} of ${co.length}, the other ${notCo.length} ${cat(notCo)} of ${notCo.length}; H-b covers 3 of the 8 categories`, source: "eval/runs/sealed-hb-nocomment/results.json: perCase[].runs[].cat, tags.ai_attributed_commit", date: day(need(hb.startedAt, "sealed-hb startedAt")) },
      { id: "S7", number: `${cat(twinPer)} of ${twinPer.length}`, measures: "The obfuscated twin of H-b (identifiers renamed by the sealed script, comments removed): the contamination check; a result more than 15 points under S6 would have replaced it as the headline", source: "eval/runs/sealed-hb-obfuscated/results.json: perCase[].runs[].cat", date: day(need(twin.startedAt, "sealed-hb-obfuscated startedAt")) },
      { id: "S8", number: `${cat(origPer)} of ${origPer.length}`, measures: "H-b with the fixer's comments left in: a secondary number that decides nothing", source: "eval/runs/sealed-hb-original/results.json: perCase[].runs[].cat", date: day(need(orig.startedAt, "sealed-hb-original startedAt")) },
      { id: "S9", number: `$${spend.toFixed(2)}`, measures: "Model spend of the four sealed runs together", source: "eval/runs/sealed-ha/results.json, eval/runs/sealed-hb-nocomment/results.json, eval/runs/sealed-hb-obfuscated/results.json, eval/runs/sealed-hb-original/results.json: summary.spendUsd", date: day(ha.startedAt) },
    ]);
  }

  // ---- the AI step and the replay (S4) ----
  {
    const f = "eval/runs/dev-final-2/results.json";
    const dev = read(f);
    const sum = need(dev.summary, `${f} summary`);
    expect(dev.sealed === false, `${f} is a development run, not a sealed one`);
    const per: Json[] = need(dev.perCase, `${f} perCase`);
    const cases = need(sum.cases, `${f} summary.cases`);
    const runsPer = need(sum.runsPerCase, `${f} summary.runsPerCase`);
    const answers = cases * runsPer;
    const proposed = need(sum.outcomes?.proposed, `${f} summary.outcomes.proposed`);
    const abstained = need(sum.outcomes?.["not_proven:model_abstained"], `${f} summary.outcomes["not_proven:model_abstained"]`);
    expect(proposed + abstained === answers, `${f} outcomes add up to ${answers} answers`);
    const rightEveryRun = (c: Json): boolean => c.runs.every((r: Json) => r.both);
    expect(per.filter((c) => c.label === "NOT_IN_DIFF").length === 1 && abstained === runsPer, `${f} abstentions are the runs of the one NOT_IN_DIFF case`);
    const tail = per.filter((c) => c.tags.tail);
    const hard = per.filter((c) => c.tags.hard);
    const b1Hard = [...hard, ...tail].filter((c) => c.B1.score.cat).length;
    const inj = read("eval/runs/a8-injection-final/results.json");
    const is = need(inj.summary, "a8-injection-final summary");
    const a25 = M("s4-a25-run1.json");
    const sA25 = need(a25.summary, "s4-a25-run1.json summary");
    const rc = M("s4-record-causes.json");
    const rc2 = M("s4-record-causes-wrong_webhook_id_setting.json");
    const rcModes = Object.values(need(rc.results, "s4-record-causes.json results")) as Json[];
    const fix = M("fix-record-2026-10-20.json");
    const fixModes: Json[] = need(fix.modes, "fix-record-2026-10-20.json modes");
    const rv = M("s5-reverify-24h.json");

    add("The cause step and the replay (the AI proposes, code checks)", [
      { id: "C1", number: `${per.filter(rightEveryRun).length} of ${cases}`, measures: `Development-set cases answered correctly in all ${runsPer} runs (${answers} answers: ${proposed} proposed a cause, ${abstained} abstained). This is the set the prompt was built on, not a held-out set`, source: `${f}: summary, perCase[].runs[].both`, date: day(need(dev.startedAt, `${f} startedAt`)) },
      { id: "C2", number: `${need(sum.shownWrong, `${f} summary.shownWrong`)} wrong`, measures: "Answers shown that were wrong on the development set", source: `${f}: summary.shownWrong`, date: day(dev.startedAt) },
      { id: "C3", number: `${tail.filter(rightEveryRun).length} of ${tail.length}`, measures: `Development-set cases tagged "tail" that were right in all runs; the ${abstained} abstentions are the ${runsPer} runs of the one case whose label is "cause not in the diff"`, source: `${f}: perCase[].tags.tail`, date: day(dev.startedAt) },
      { id: "C4", number: `${need(sum.B1?.category, `${f} summary.B1.category`)} of ${cases}`, measures: `Cases a plain-code baseline (regular expressions, no AI) gets the cause category right; category and line: ${need(sum.B1?.both, `${f} summary.B1.both`)} of ${cases}`, source: `${f}: summary.B1`, date: day(dev.startedAt) },
      { id: "C5", number: `${b1Hard} of ${hard.length + tail.length}`, measures: `Development-set cases tagged "hard" or "tail" that the same baseline gets right`, source: `${f}: perCase[].tags, perCase[].B1.score.cat`, date: day(dev.startedAt) },
      { id: "C6", number: `${need(is.casesCorrectInAllRuns, "a8 casesCorrectInAllRuns")} of ${need(is.cases, "a8 cases")}`, measures: `Injection cases (instructions planted in comments of the code) answered correctly in all ${is.runsPerCase} runs, ${need(is.shownWrong, "a8 shownWrong")} wrong shown`, source: "eval/runs/a8-injection-final/results.json: summary", date: day(need(inj.startedAt, "a8 startedAt")) },
      { id: "C7", number: `$${f4(sum.spendUsd / answers)}`, measures: `Cost per cause call on the development set ($${f2(need(sum.spendUsd, `${f} summary.spendUsd`))} for ${answers} calls)`, source: `${f}: summary.spendUsd`, date: day(dev.startedAt) },
      { id: "C8", number: String(need(sA25.confirmed, "s4-a25-run1.json summary.confirmed")).replace("/", " of "), measures: "Replays of stored real signed events that confirmed the cause (3 planted bugs, 3 each): the bad build and the good build answered as the cause predicts", source: "docs/measurements/s4-a25-run1.json: summary.confirmed", date: day(need(a25.at, "s4-a25-run1.json at")) },
      { id: "C9", number: `${need(sA25.outsideWindow?.shownAsRecorded, "s4-a25 outsideWindow.shownAsRecorded")} of ${need(sA25.outsideWindow?.checked, "s4-a25 outsideWindow.checked")}`, measures: `Replays whose events were older than the replay window (${sA25.replayWindowHours} h at the time) that were shown as recorded results, with ${need(sA25.outsideWindow?.verifyCallsMade, "s4-a25 outsideWindow.verifyCallsMade")} verify calls made`, source: "docs/measurements/s4-a25-run1.json: summary.outsideWindow", date: day(a25.at) },
      { id: "C10", number: `${need(rv.result?.SUCCESS, "s5-reverify-24h.json result.SUCCESS")} of ${Object.values(rv.result as Record<string, number>).reduce((a, b) => a + b, 0)}`, measures: `Stored real signatures that PayPal's verify call still accepted, the oldest ${f2(need(rv.age?.oldestHours, "s5-reverify-24h.json age.oldestHours"))} h old (older than that is not measured)`, source: "docs/measurements/s5-reverify-24h.json: result, age", date: day(need(rv.at, "s5-reverify-24h.json at")) },
      { id: "C11", number: `${rcModes.filter((r) => r.status === "proposed").length} proposed, ${[rc2.results.wrong_webhook_id_setting].filter((r: Json) => r.status === "not_proven").length} abstained`, measures: "Recorded cause answers behind the stories: 3 code bugs got a category and cited lines; the settings bug (a wrong webhook id, no changed code line) got no cause", source: "docs/measurements/s4-record-causes.json, s4-record-causes-wrong_webhook_id_setting.json: results", date: `${day(rc.at)} and ${day(rc2.at)}` },
      { id: "C12", number: `$${f4(need(rc.usd, "s4-record-causes.json usd") + need(rc2.usd, "s4-record-causes-wrong_webhook_id_setting.json usd"))}`, measures: "Cost of the 4 recorded cause calls", source: "docs/measurements/s4-record-causes.json, s4-record-causes-wrong_webhook_id_setting.json: usd", date: `${day(rc.at)} and ${day(rc2.at)}` },
      { id: "C13", number: `${fixModes.filter((m) => m.result?.verdict === "proven").length} of ${fixModes.length}`, measures: `Recorded patch proposals, one per planted code bug, that passed the code checks and the replay; ${need(fix.verify?.liveCalls, "fix-record verify.liveCalls")} live verify calls were made (${need(fix.verify?.answeredFromStored, "fix-record verify.answeredFromStored")} answered from stored results); model cost $${f4(need(fix.spentUsdAllRuns, "fix-record spentUsdAllRuns"))}`, source: "docs/measurements/fix-record-2026-10-20.json: modes[].result.verdict, verify, spentUsdAllRuns", date: day(need(fix.at, "fix-record at")) },
    ]);
  }

  // ---- guards (S4, S5) ----
  {
    const a13 = M("s4-a13-run1.json");
    const poll = M("s5-poll-cost.json");
    const flood = need(a13.flood_scan, "s4-a13-run1.json flood_scan");
    const blocked = need(a13.blockedRequests, "s4-a13-run1.json blockedRequests");
    const tm = need(poll.tenMinutes, "s5-poll-cost.json tenMinutes");
    const s6 = M("s6-a13-redis-2026-10-21.json");
    const s6tm = need(s6.tenMinutes, "s6-a13-redis-2026-10-21.json tenMinutes");
    const s6idle = need(need(s6tm.idle, "s6 tenMinutes.idle").after, "s6 tenMinutes.idle.after");
    const s6active = need(need(s6tm.active, "s6 tenMinutes.active").after, "s6 tenMinutes.active.after");
    add("Guards on cost and abuse", [
      { id: "L1", number: `${need(flood.passed, "flood_scan.passed")} of ${need(flood.requests, "flood_scan.requests")}`, measures: `A flood of ${flood.requests} scan requests: requests that got through to the work; server-side Redis commands used by the whole flood: ${need(flood.serverCommands, "flood_scan.serverCommands")}`, source: "docs/measurements/s4-a13-run1.json: flood_scan", date: day(need(a13.at, "s4-a13-run1.json at")) },
      { id: "L2", number: `${need(blocked.extraServerCommands, "blockedRequests.extraServerCommands")} commands`, measures: `Extra Redis commands used by ${need(blocked.blockedAfterwards, "blockedRequests.blockedAfterwards")} further requests that were blocked`, source: "docs/measurements/s4-a13-run1.json: blockedRequests", date: day(a13.at) },
      { id: "L3", number: `${need(tm.serverCommands, "tenMinutes.serverCommands")} vs ${need(tm.plan, "tenMinutes.plan")}`, measures: "A miss: Redis commands used by 10 minutes of a page polling (server count) against the 60 the plan allowed", source: "docs/measurements/s5-poll-cost.json: tenMinutes", date: day(need(poll.at, "s5-poll-cost.json at")) },
      { id: "L4", number: `${need(s6idle.commands, "s6 tenMinutes.idle.after.commands")} vs ${need(s6.plan, "s6 plan")}`, measures: "After the polling change of 2026-10-21: Redis commands in 10 minutes of a page that is opened and left alone (the lane's own cadence replayed, each poll counted on an in-memory Redis running the real store code); inside the plan's 60", source: "docs/measurements/s6-a13-redis-2026-10-21.json: tenMinutes.idle.after, perPoll", date: day(need(s6.at, "s6 at")) },
      { id: "L5", number: `${need(s6active.commands, "s6 tenMinutes.active.after.commands")} vs ${need(s6.plan, "s6 plan")}`, measures: "Still a miss after that change: the same count for a page in use for 10 minutes (an order, a planted bug, a refund, the fix and a ring, on a modelled timeline of a visit)", source: "docs/measurements/s6-a13-redis-2026-10-21.json: tenMinutes.active.after", date: day(need(s6.at, "s6 at")) },
    ]);
  }

  // ---- what PayPal's Sandbox did ----
  {
    const modes: Json[] = M("s2-modes-run1.json");
    const bad = modes.filter((m) => m.mode === "bad_body");
    expect(bad.length > 0, "s2-modes-run1.json has rejected-with-401 trials");
    const threeTries = bad.filter((m) => m.observed.answers.length === 3);
    const second = threeTries.map((m) => need(m.observed.attemptSecondsAfterFirst[1], "attemptSecondsAfterFirst[1]"));
    const third = threeTries.map((m) => need(m.observed.attemptSecondsAfterFirst[2], "attemptSecondsAfterFirst[2]"));
    const xa = M("s2-cross-app-run1.result.json");
    const rows: Json[] = need(xa.rows, "s2-cross-app-run1.result.json rows");
    const apart = rows.filter((r) => (r.origin === "dev" ? r.witnessDev === 1 && r.witnessDemo === 0 && r.listedByDev && !r.listedByDemo : r.witnessDemo === 1 && r.witnessDev === 0 && r.listedByDemo && !r.listedByDev)).length;
    const d = M("disputes-probe-2026-10-20.json");
    const s = need(d.steps, "disputes-probe steps");
    const seen = [s.c_chargeback.disputesApi.firstSeenAfterS, ...s.c2_more_trials.trials.map((t: Json) => t.apiFirstSeenS), s.e2_dispute_with_no_subscribing_webhook.disputeApiFirstSeenS].map((x: number) => need(x, "a dispute's first-seen time"));
    const e2 = s.e2_dispute_with_no_subscribing_webhook;
    expect(e2.webhooksSubscribingToDisputes === 0 && Array.isArray(e2.dispute_event_in_list) && e2.dispute_event_in_list.length === 0, "disputes-probe e2 is the dispute with no subscribing webhook and no event");
    const tally = s.f_event_type_tally.listed;
    const order = need(s.order, "disputes-probe steps.order");
    const date = day(need(d.date, "disputes-probe date"));
    add("What PayPal's Sandbox did", [
      { id: "P1", number: `${threeTries.length} of ${bad.length}`, measures: `Refund events rejected with 401 that PayPal delivered 3 times and then gave up (${bad.length} trials); the second try came ${range1(second, "s")} after the first, the third ${range1(third, "s")} after the first`, source: "docs/measurements/s2-modes-run1.json: rows with mode bad_body, observed.answers, observed.attemptSecondsAfterFirst", date: undated("2026-10-19") },
      { id: "P2", number: `${apart} of ${rows.length}`, measures: "Test events of the two Sandbox apps that showed up only under the app that made them, at the witness and in PayPal's event list", source: "docs/measurements/s2-cross-app-run1.result.json: rows[]", date: day(need(xa.at, "s2-cross-app-run1.result.json at")) },
      { id: "P3", number: `${need(order.witnessHeardCompletedAfterS, "order.witnessHeardCompletedAfterS")} s vs ${need(order.eventListShowedCompletedAfterS, "order.eventListShowedCompletedAfterS")} s`, measures: "One order (n = 1): seconds until the witness heard the payment event, against seconds until PayPal's event list showed it", source: "docs/measurements/disputes-probe-2026-10-20.json: steps.order", date },
      { id: "P4", number: `${f1(lo(seen))} to ${f1(hi(seen))} s`, measures: `Seconds until PayPal's Disputes API listed a dispute made by the Sandbox test call (${seen.length} disputes)`, source: "docs/measurements/disputes-probe-2026-10-20.json: steps.c_chargeback, c2_more_trials, e2_dispute_with_no_subscribing_webhook", date },
      { id: "P5", number: `${e2.dispute_event_in_list.length} events in ${e2.watchedForS} s`, measures: "A dispute made while no webhook subscribed to dispute events (n = 1): dispute events PayPal listed while it was watched", source: "docs/measurements/disputes-probe-2026-10-20.json: steps.e2_dispute_with_no_subscribing_webhook", date },
      { id: "P6", number: `${need(tally["CUSTOMER.DISPUTE.CREATED"], "tally CREATED")} created, ${need(tally["CUSTOMER.DISPUTE.UPDATED"], "tally UPDATED")} updated`, measures: "Dispute events PayPal listed for 4 disputes made while a webhook did subscribe to dispute events", source: "docs/measurements/disputes-probe-2026-10-20.json: steps.f_event_type_tally", date },
    ]);
  }

  // ---- ids must be unique, or a citation in the pack would be ambiguous ----
  const ids = groups.flatMap((g) => g.rows.map((r) => r.id));
  expect(new Set(ids).size === ids.length, "ledger row ids are unique");
  return groups;
}

// ---- the stories table --------------------------------------------------------------------------------------------------------------------

export function storyRows(): { id: string; label: string; title: string; capturedAt: string; file: string }[] {
  return Object.keys(SCENARIO_LABEL).map((id) => {
    const file = `fixtures/recorded-run/${id}.json`;
    const j = read(file);
    expect(j.id === id, `${file} holds the story ${id}`);
    const at = new Date(need(j.capturedAt, `${file} capturedAt`)).toISOString();
    return { id, label: SCENARIO_LABEL[id], title: need(j.title, `${file} title`), capturedAt: `${at.slice(0, 10)} ${at.slice(11, 16)} UTC`, file };
  });
}
// A story file that is not in SCENARIO_LABEL would be a story the pack does not list.
export function unlistedStoryFiles(): string[] {
  return readdirSync(join(ROOT, "fixtures", "recorded-run")).filter((f) => f.endsWith(".json") && !(f.slice(0, -5) in SCENARIO_LABEL));
}

// ---- rendering and splicing ---------------------------------------------------------------------------------------------------------------

const cell = (s: string): string => s.replace(/\|/g, "\\|");

export function renderLedger(groups: Group[] = ledgerGroups()): string {
  const out: string[] = [];
  for (const g of groups) {
    out.push(`#### ${g.title}`, "", "| ID | Number | What it measures | Source | Measured |", "| --- | --- | --- | --- | --- |");
    for (const r of g.rows) out.push(`| ${r.id} | ${cell(r.number)} | ${cell(r.measures)} | ${cell(r.source)} | ${r.date} |`);
    out.push("");
  }
  out.push(`${UNDATED} The file stores no date; the date is the one the log gives for the step that measured it.`);
  return out.join("\n");
}

export function renderStories(): string {
  const out = ["| On screen | Link | What the run shows | Recorded (UTC) | File |", "| --- | --- | --- | --- | --- |"];
  for (const s of storyRows()) out.push(`| ${cell(s.label)} | \`/?s=${s.id}\` | ${cell(s.title)} | ${s.capturedAt} | \`${s.file}\` |`);
  return out.join("\n");
}

export function blockOf(doc: string, start: string, end: string): string {
  const a = doc.indexOf(start);
  const b = doc.indexOf(end);
  if (a < 0 || b < 0 || b < a) throw new Error(`numbers-ledger: the pack has no ${start} ... ${end} block`);
  return doc.slice(a + start.length, b).replace(/^\n+|\n+$/g, "");
}
function splice(doc: string, start: string, end: string, body: string): string {
  const a = doc.indexOf(start);
  const b = doc.indexOf(end);
  if (a < 0 || b < 0 || b < a) throw new Error(`numbers-ledger: the pack has no ${start} ... ${end} block`);
  return `${doc.slice(0, a + start.length)}\n${body}\n${doc.slice(b)}`;
}
export function spliceAll(doc: string): string {
  return splice(splice(doc, LEDGER_START, LEDGER_END, renderLedger()), STORIES_START, STORIES_END, renderStories());
}

// ---- command line -------------------------------------------------------------------------------------------------------------------------

if (process.argv[1] && process.argv[1].endsWith("numbers-ledger.ts")) {
  const doc = readFileSync(PACK_PATH, "utf8");
  const next = spliceAll(doc);
  if (process.argv.includes("--check")) {
    if (next !== doc) {
      console.error("docs/judge-pack.md: the numbers ledger or the stories table is out of date; run `npx tsx scripts/numbers-ledger.ts`");
      process.exit(1);
    }
    console.log("docs/judge-pack.md: ledger and stories table match the files");
  } else if (next === doc) {
    console.log("docs/judge-pack.md: already up to date");
  } else {
    writeFileSync(PACK_PATH, next);
    console.log("docs/judge-pack.md: ledger and stories table rewritten");
  }
}
