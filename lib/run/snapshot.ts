// The one shape every Doorbell screen renders (S5 contract). A live judge-lane session, a recorded run and a case file all become a
// RunSnapshot, so the screen has one code path and a recorded run cannot show something the live product would not.
//
// Who fills what:
//   session, scan     from the shop view (lib/shop/view.ts) and the gap finder (lib/gaps/scan.ts), unchanged
//   causes            lib/cause: diagnose (recorded by default) + replay + confirmationOf, keyed by the gap row's captureId; lib/fix: the
//                     recorded, checked and replayed fix, only beside a cause that is proposed AND confirmed by the replay
//   certificate       lib/cert: computed from scan only (plan 5.5, R9); no model text
//   heartbeat         lib/witness/heartbeat: the witness checked against PayPal's event list (plan 10.1 #2, R26)
// Every string a screen shows comes from fixed templates or from these numbers; nothing here carries model or PayPal free text. The one
// exception is the patch of a fix (GapCause.fix.patch): lines of a diff that Claude proposed, shown only as a labelled diff, only after every
// check and control passed, and only after the owner read them (DO NOT CHANGE 1, amended 10-20).
import type { CauseResult } from "../cause/cause.ts";
import type { Confirmation } from "../cause/confirm.ts";
import type { ReplayResult } from "../cause/replay.ts";
import type { FixResult } from "../fix/types.ts";
import type { ScanResult } from "../gaps/scan.ts";
import type { BrokenMode } from "../shop/types.ts";
import type { SessionView } from "../shop/view.ts";

export type RunMode = "RECORDED RUN" | "LIVE" | "CASE FILE";

// Plan 5.5: green only at full coverage, no unverified rows and no gaps; amber when there are no gaps but something is unchecked; red at a gap.
export type StampState = "green" | "amber" | "red";

export interface DisputeNumbers {
  open: number; // open disputes PayPal lists on the checked captures
  notInBooks: number; // of those: the shop's books have none (a gap)
  unverified: number; // of those: not provable yet
  unsubscribed: number; // of the gaps: the shop's own webhook is not subscribed to dispute events
  noWebhook: number; // of the gaps: no webhook of the app is
  moneyNotInBooks: string; // "48.00": the disputed amounts of the gaps, summed in minor units
  unreadable: number; // captures whose dispute list could not be read
}

export interface Certificate {
  stamp: StampState;
  stampText: string; // "Tied on 41/41 of what we can see" | "Tied on 38/41 · 3 unverified" | "1 gap · ..."
  header: string; // computed sentence, e.g. "2 of 41 captures did not match PayPal · $96.00 across 2 refunds not in books · checked 41 of 41 captures."
  numbers: {
    rows: number;
    checked: number; // rows PayPal answered for (TIED + GAP)
    tied: number;
    gaps: number;
    unverified: number;
    healed: number; // rows tied now whose heal record says healed and whose resend arrived: a gap that Ring again closed (the gaps still open are `gaps`)
    // Rows tied now whose books were last written by PayPal's OWN retry (same transmission id) after the shop did not take the earlier tries, with no
    // resend of ours on record (lib/gaps/closure.ts). Disjoint from `healed`. Present only when there is at least one, so older recordings are unchanged.
    closedByPaypalRetry?: number;
    coveragePct: number; // checked / rows, rounded down
    moneyNotInBooks: string; // "96.00", summed in minor units
    refundsNotInBooks: number;
    byClass: Record<string, number>;
    // Present when the scan looked for disputes (or found one). A dispute the books do not show is a GAP row, so it is also inside `gaps` and
    // `checked`; these numbers say how many of the gaps are disputes. Counted from ScanRow.disputes, never from text.
    disputes?: DisputeNumbers;
  };
  limits: string[]; // the limits that apply to THIS run, each with its number (NO_EVENT_FOUND count, rows inside the list lag, failed re-queries)
  footnote: string; // the standing one-line footnote (plan 5.5)
  ownerView: string[]; // the print view for a shop owner: plain sentences, no jargon (plan 5.5, video 2:10)
  scopeAt: number; // when the scan behind this certificate ran
  signed: false; // the certificate is not signed (README says so)
}

export interface Heartbeat {
  lastDeliveryAt: number | null; // the witness's latest verified delivery
  listedMissedByWitness: number | null; // events in PayPal's list the witness never heard (F6 kind); null = list not read
  state: "ok" | "missed" | "silent"; // silent: last delivery > 30 min ago, "nothing to compare" (silence is not health)
  text: string; // "Witness: last delivery 12 s ago · events list shows 0 the witness missed"
}

export interface GapCause {
  captureId: string; // the scan row this belongs to
  mode: BrokenMode; // the broken mode of THIS session; a cause is never paired with another mode's replay
  cause: CauseResult;
  replay: ReplayResult | null;
  confirmation: Confirmation | null; // confirmationOf(cause, replay) when the cause is proposed
  // "Prove the fix" (lib/fix): the patch Claude proposed for this cause, the result of each code check and each replay control, and a verdict.
  // Present only when the cause is proposed AND the replay confirmed it, and only for a patch the owner has reviewed (lib/fix/recorded.ts);
  // absent otherwise, and absent in recordings made before this existed. The edits come from a recorded model answer, never a live call.
  fix?: FixResult;
}

export interface RunSnapshot {
  mode: RunMode;
  recordedAt: number | null; // for RECORDED RUN and CASE FILE: when the real run happened
  step: { index: number; of: number; title: string } | null; // recorded run: which step of the walkthrough this is
  session: SessionView;
  scan: ScanResult | null; // null before the first scan
  causes: GapCause[];
  certificate: Certificate | null; // null before the first scan
  heartbeat: Heartbeat | null;
}

// A recorded run: the real steps of one scenario, captured from the deployed site, played back with no network call (R12).
export interface RecordedScenario {
  id: "refund_never_booked" | "late_payment_overwrites" | "signature_rejected" | "resend_not_delivered" | "cause_not_in_code";
  title: string;
  plantedMode: GapCause["mode"];
  capturedAt: number;
  steps: RunSnapshot[];
  paypalIds: string[]; // ids a judge can look up in the PayPal Sandbox dashboard
}

// The fifth recorded run is not about a broken handler: no code or setting is broken (the session runs the good handler) and a customer's bank
// disputed one order at PayPal. Its own type, so that nothing keyed by the four planted modes has to learn a mode that is not one.
export interface RecordedDisputeScenario extends Omit<RecordedScenario, "id" | "plantedMode"> {
  id: "dispute_never_heard";
  plantedMode: "none";
}
