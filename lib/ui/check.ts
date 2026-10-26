// The rules a RunSnapshot must obey for the screens to tell the truth (plan 5.5, 14). Pure; returns the violations as sentences, [] when it
// is sound. The tests run it on the sample snapshots, and it is meant to be run on the real recorded run too (lib/run/recorded.ts).
import { closureOf } from "../gaps/closure.ts";
import { fixViolations } from "../fix/rules.ts";
import { disputeViolations } from "../run/check-disputes.ts";
import type { RecordedScenario, RunSnapshot } from "../run/snapshot.ts";

export function checkSnapshot(s: RunSnapshot): string[] {
  const bad: string[] = [];
  const rows = s.scan?.rows ?? [];
  const byId = new Set(rows.map((r) => r.captureId));

  if (s.mode !== "LIVE" && s.recordedAt === null) bad.push(`${s.mode} has no recording date`);
  if (s.mode === "LIVE" && s.recordedAt !== null) bad.push("LIVE carries a recording date");
  if ((s.scan === null) !== (s.certificate === null)) bad.push("scan and certificate must both be null (before the first scan) or both present");
  for (const c of s.causes) {
    if (!byId.has(c.captureId)) bad.push(`cause for ${c.captureId} matches no scan row`);
    if (c.cause.status === "proposed" && c.confirmation === null) bad.push(`cause for ${c.captureId} is proposed but has no confirmation`);
    if (c.cause.status !== "proposed" && (c.confirmation !== null || c.replay !== null)) bad.push(`cause for ${c.captureId} is ${c.cause.status} but carries a replay or a confirmation`);
    bad.push(...fixViolations(c));
  }

  const cert = s.certificate;
  if (cert && s.scan) {
    const n = cert.numbers;
    const sum = s.scan.summary;
    if (cert.signed !== false) bad.push("the certificate must say it is not signed");
    if (n.rows !== rows.length || n.tied !== sum.tied || n.gaps !== sum.gaps || n.unverified !== sum.unverified) bad.push("certificate numbers differ from the scan summary");
    if (n.checked !== n.tied + n.gaps) bad.push("checked must be tied + gaps");
    if (n.coveragePct !== Math.floor((n.checked / Math.max(1, n.rows)) * 100)) bad.push("coverage is not checked/rows rounded down");
    // Plan 5.5: green only at full coverage, nothing unverified and no gap; amber when there is no gap but something is unchecked; red at a gap.
    const expected = n.gaps > 0 ? "red" : n.unverified > 0 || n.checked < n.rows ? "amber" : "green";
    if (cert.stamp !== expected) bad.push(`stamp is ${cert.stamp} but the numbers say ${expected}`);
    if (cert.scopeAt !== s.scan.at) bad.push("certificate scope is not the scan time");
    // Rows PayPal's own retry closed (lib/gaps/closure.ts, which reads only TIED rows) are counted from the rows' tries, and never as healed: the two share the tied rows.
    const retryClosed = rows.filter((r) => closureOf(r)?.kind === "paypal_retry").length;
    if ((n.closedByPaypalRetry ?? 0) !== retryClosed) bad.push(`certificate says ${n.closedByPaypalRetry ?? 0} tied rows were booked on PayPal's own retry but the scan shows ${retryClosed}`);
    if (n.healed + (n.closedByPaypalRetry ?? 0) > n.tied) bad.push("healed plus booked-on-PayPal's-retry is more than the tied rows");
  }

  for (const r of rows) {
    for (const e of r.events) {
      if (e.heal?.state === "healed" && r.status !== "TIED") bad.push(`row ${r.n} has a healed ring but is ${r.status}`);
      if (e.finding && r.status === "TIED") bad.push(`row ${r.n} is TIED but has a finding`);
    }
    // a dispute gap's finding sits on the dispute, not on an event (lib/run/check-disputes.ts checks it)
    if (r.status === "GAP" && !r.events.some((e) => e.finding && e.finding.final) && !(r.disputes ?? []).some((d) => d.status === "GAP")) bad.push(`row ${r.n} is a gap without a final finding`);
  }
  return [...bad, ...disputeViolations(s)];
}

export function checkScenario(sc: RecordedScenario): string[] {
  const bad: string[] = [];
  if (sc.steps.length === 0) bad.push(`${sc.id} has no steps`);
  sc.steps.forEach((st, i) => {
    if (st.mode !== "RECORDED RUN" && st.mode !== "CASE FILE") bad.push(`${sc.id} step ${i + 1} is ${st.mode}`);
    if (st.step?.index !== i + 1 || st.step.of !== sc.steps.length) bad.push(`${sc.id} step ${i + 1} has the wrong step counter`);
    for (const v of checkSnapshot(st)) bad.push(`${sc.id} step ${i + 1}: ${v}`);
  });
  return bad;
}
