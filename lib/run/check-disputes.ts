// The rules a RunSnapshot must obey where disputes are concerned (Track B). Same shape as lib/ui/check.ts: pure, returns the violations as sentences,
// [] when sound. It lives here, not in lib/ui/check.ts, and is meant to be called from checkSnapshot (see disputeViolations' last rule for the one
// rule of checkSnapshot that a dispute-only gap row has to be excused from).
//
//   Where a dispute sits:  ScanRow.disputes. A row holding a GAP dispute is a GAP row (its money is the disputed amount, counted in the
//   certificate's `disputes` numbers), one holding an UNVERIFIED dispute is not TIED. A dispute is never "rung again": nothing is sent for it.
import { DISPUTE_ID } from "../gaps/disputes.ts";
import type { ScanRow } from "../gaps/scan.ts";
import { fromMinor, toMinor } from "../cert/cert.ts";
import type { RecordedDisputeScenario, RunSnapshot } from "./snapshot.ts";

const hasEventFinding = (r: ScanRow): boolean => r.events.some((e) => e.finding !== null);

export function disputeViolations(s: RunSnapshot): string[] {
  const bad: string[] = [];
  const rows = s.scan?.rows ?? [];
  let open = 0;
  let gap = 0;
  let unverified = 0;
  let minor = 0;
  let noWebhook = 0;
  let unsubscribed = 0;

  for (const r of rows) {
    const ds = r.disputes ?? [];
    for (const d of ds) {
      open++;
      const at = `dispute ${d.disputeId} on row ${r.n}`;
      if (!DISPUTE_ID.test(d.disputeId)) bad.push(`${at} has an id that is not a dispute id`);
      if (toMinor(d.amount) === null) bad.push(`${at} has an amount that is not money`);
      if ((d.sellerResponseDueAt === null) !== (d.dueDateSource === "not_set_yet")) bad.push(`${at}: the due date and where it comes from disagree`);
      if (d.ring?.state === "ready") bad.push(`${at} can be rung again, and nothing is ever sent for a dispute`);
      if (d.status === "TIED") {
        if (d.finding !== null || d.ring !== null) bad.push(`${at} is TIED but has a finding or a ring`);
        continue;
      }
      if (!d.finding || !d.ring) {
        bad.push(`${at} is ${d.status} but has no finding or no ring`);
        continue;
      }
      if (d.status === "GAP") {
        gap++;
        minor += toMinor(d.amount) ?? 0;
        if (!d.finding.final || d.finding.cls === "UNVERIFIED") bad.push(`${at} is a gap without a final finding`);
        if (d.webhooks.any === false) noWebhook++;
        if (d.finding.flag === "UNSUBSCRIBED_EVENT_TYPE") unsubscribed++;
      } else {
        unverified++;
        if (d.finding.final || d.finding.cls !== "UNVERIFIED") bad.push(`${at} is unverified but carries a final finding`);
      }
      if (d.finding.flag === "UNSUBSCRIBED_EVENT_TYPE" && d.webhooks.shop !== false) bad.push(`${at} says the shop's webhook is not subscribed, but its subscription is ${String(d.webhooks.shop)}`);
    }
    if (ds.some((d) => d.status === "GAP") && r.status !== "GAP") bad.push(`row ${r.n} holds a gap dispute but is ${r.status}`);
    if (ds.some((d) => d.status === "UNVERIFIED") && r.status === "TIED") bad.push(`row ${r.n} holds an unverified dispute but is TIED`);
    // The rule of checkSnapshot that a gap row has a final finding, in its dispute-aware form.
    if (r.status === "GAP" && !r.events.some((e) => e.finding?.final) && !ds.some((d) => d.status === "GAP")) bad.push(`row ${r.n} is a gap without a final finding or a gap dispute`);
  }

  for (const c of s.causes) {
    const row = rows.find((r) => r.captureId === c.captureId);
    // only a row that holds a dispute can be a gap because of it; a row without one is the other rules' business (a sample mid-ring has no finding)
    if (row && (row.disputes ?? []).length > 0 && !hasEventFinding(row)) bad.push(`cause for ${c.captureId} belongs to a row that is a gap only because of a dispute: a dispute has no code to blame`);
  }

  const cert = s.certificate;
  const reads = s.scan?.disputeReads;
  if (cert && s.scan) {
    const n = cert.numbers.disputes;
    if (!reads && open === 0) {
      if (n) bad.push("the certificate has dispute numbers but the scan did not look for disputes");
    } else if (!n) {
      bad.push("the scan looked for disputes but the certificate has no dispute numbers");
    } else {
      const expected = { open, notInBooks: gap, unverified, moneyNotInBooks: fromMinor(minor), unreadable: reads?.unreadable ?? 0 };
      for (const [k, v] of Object.entries(expected)) if (n[k as keyof typeof expected] !== v) bad.push(`certificate disputes.${k} is ${String(n[k as keyof typeof expected])} but the rows say ${String(v)}`);
      if (n.noWebhook !== noWebhook) bad.push(`certificate disputes.noWebhook is ${n.noWebhook} but the rows say ${noWebhook}`);
      if (n.unsubscribed !== unsubscribed) bad.push(`certificate disputes.unsubscribed is ${n.unsubscribed} but the rows say ${unsubscribed}`);
      if (noWebhook > 0 && !cert.limits.some((l) => /no webhook of this app subscribes to dispute events/.test(l))) bad.push("a dispute has no webhook of the app subscribed, and the certificate does not say that whether PayPal made an event cannot be proven");
      if ((reads?.unreadable ?? 0) > 0 && !cert.limits.some((l) => /dispute list could not be read/.test(l))) bad.push("some dispute lists were not read and the certificate does not say so");
      if (open > 0 && !cert.limits.some((l) => /response-due date/.test(l))) bad.push("a Sandbox dispute is shown and the certificate does not say where its due date comes from");
    }
  }
  return bad;
}

// A recorded dispute run: the step counter and every step's dispute rules. The caller adds checkSnapshot for the rules every snapshot obeys.
export function checkDisputeScenario(sc: RecordedDisputeScenario): string[] {
  const bad: string[] = [];
  if (sc.steps.length === 0) bad.push(`${sc.id} has no steps`);
  if (sc.plantedMode !== "none") bad.push(`${sc.id} is not about a planted mode`);
  sc.steps.forEach((st, i) => {
    if (st.mode !== "RECORDED RUN") bad.push(`${sc.id} step ${i + 1} is ${st.mode}`);
    if (st.step?.index !== i + 1 || st.step.of !== sc.steps.length) bad.push(`${sc.id} step ${i + 1} has the wrong step counter`);
    for (const v of disputeViolations(st)) bad.push(`${sc.id} step ${i + 1}: ${v}`);
  });
  return bad;
}
