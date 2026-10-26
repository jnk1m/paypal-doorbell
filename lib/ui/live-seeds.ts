// Three live-lane states from the real runs of 10-20 (the setting bug, and a dispute nobody was listening for, on the Sandbox), built from the recorded snapshots,
// for /dev/live and for the tests: a seeded lane probes, polls and sends nothing. The setting bug's recording is rewritten only where the live run differed:
// PayPal's own retry (the same transmission id) reached the shop after the switch to the working handler, and Doorbell sent nothing.
import { certificateOf, rowsInsideListLag } from "../cert/cert.ts";
import type { RunSnapshot } from "../run/snapshot.ts";
import type { LiveSeed } from "./live.ts";
import { DISPUTE_SCENARIO } from "../run/recorded.ts";
import { SCENARIOS } from "./source.ts";

const scenario = () => SCENARIOS.find((s) => s.id === "cause_not_in_code")!;
const live = (i: number): RunSnapshot => ({ ...structuredClone(scenario().steps[i]), mode: "LIVE", recordedAt: null, step: null });
const base = { sid: "9f3a1c52-demo", everPlanted: true };

// The moment a snapshot was read: its clock, its scan and the certificate's scope.
function readAt(s: RunSnapshot, at: number): void {
  s.session.now = at;
  s.scan!.at = at;
  if (s.certificate) s.certificate.scopeAt = at;
}

// The setting bug is on, Doorbell found the gaps and asked the AI, and the AI named no line: the cause is not proven.
export function notProvenSeed(): LiveSeed {
  const found = live(0);
  return { ...base, snap: found, diag: live(0), fixed: null };
}

// The shop answered 401 to PayPal's first two tries and the judge switched to the working handler. Before Ring again was allowed, PayPal's third try of the same
// delivery reached the fixed shop: the books say Refunded and the rows are TIED, and no resend was ever sent.
export function selfHealedSeed(): LiveSeed {
  const diag = live(0);
  const fixed = live(1);
  const snap = live(3);
  const refundOf = (s: RunSnapshot, n: number) => s.scan!.rows.find((r) => r.n === n)!.events.find((e) => e.kind === "refunded")!;
  const rejected = refundOf(diag, 2).s!.slice(0, 2); // 401, 401: the third 401 of the recording never happened
  // PayPal's own third try comes within its measured retry window (about 163 s): here at +150 s. The recording's lane read the gaps at +170 s, after a third 401
  // that did not happen here, so the lane reads them earlier: the gaps, then the switch to the working handler, then PayPal's try.
  const closeAt = rejected[0].receivedAt! + 150_000;
  readAt(diag, rejected[0].receivedAt! + 60_000);
  readAt(fixed, rejected[0].receivedAt! + 100_000);
  for (const s of [diag, fixed]) for (const row of s.scan!.rows) for (const e of row.events) if (e.kind === "refunded" && e.finding) e.s = structuredClone(rejected);
  for (const row of snap.scan!.rows) {
    const refunded = row.events.find((e) => e.kind === "refunded");
    if (!refunded || row.n < 2) continue;
    refunded.s = [...structuredClone(rejected), { tid: rejected[0].tid, attempt: `retry-${row.n}`, state: "responded", receivedAt: closeAt, status: 200, respondedAt: closeAt + 190 }];
    refunded.heal = null;
    refunded.finding = null;
    refunded.ring = null;
    row.status = "TIED";
    row.book = { state: "refunded", amount: row.amount, eid: refunded.eid!, at: closeAt + 190 };
  }
  for (const o of snap.session.orders) {
    const row = snap.scan!.rows.find((r) => r.captureId === o.captureId)!;
    o.book = row.book;
    o.books = "agree";
  }
  snap.scan!.summary = { ...snap.scan!.summary, tied: snap.scan!.rows.length, gaps: 0, unverified: 0 };
  snap.certificate = certificateOf(snap.scan!, { rowsInsideListLag: rowsInsideListLag(snap.session.orders, snap.scan!.at) }); // as buildLiveSnapshot does, after the edits
  return { ...base, snap, diag, fixed };
}

// A $48.00 dispute that PayPal lists and the books do not show, found by a live scan (the recorded run's third step: the response-due date is set, the capture shows
// PENDING). No webhook of the app subscribes to dispute events, so there is no handler to blame, no AI to ask, no replay, no fix to deploy and no event to ring.
export function disputeSeed(): LiveSeed {
  const snap: RunSnapshot = { ...structuredClone(DISPUTE_SCENARIO.steps[2]), mode: "LIVE", recordedAt: null, step: null };
  snap.certificate = certificateOf(snap.scan!, { rowsInsideListLag: rowsInsideListLag(snap.session.orders, snap.scan!.at) }); // as buildLiveSnapshot does
  return { ...base, everPlanted: false, snap, diag: null, fixed: null };
}
