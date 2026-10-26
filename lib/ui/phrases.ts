// The words the screens use for the closed vocabularies of the product: evidence classes and flags, Waiting reasons, ring states, heal
// states, and the reasons a cause is "not proven" or "not diagnosed". Every one is a fixed phrase written here. Nothing is taken from a
// model's answer or from PayPal's text, and the product's own codes (ACKED_BUT_NOT_APPLIED ...) are shown next to the plain words.
import type { NotDiagnosedReason } from "../cause/cause.ts";
import type { NotProvenReason } from "../cause/checks.ts";
import type { EvidenceClass, Finding, Flag, Ring, RingState, Waiting } from "../gaps/classify.ts";
import type { HealState } from "../shop/types.ts";
import { duration } from "./format.ts";

// ---- evidence classes ----------------------------------------------------------------------------------------------------

export interface EvidenceWords {
  title: string; // the plain words
  explain: string; // one sentence on what it means, and what it does not
}

const BASE: Record<EvidenceClass, EvidenceWords> = {
  ACKED_BUT_NOT_APPLIED: {
    title: "Your handler said OK, but the books did not change",
    explain: "Doorbell saw the delivery reach your handler and your handler answered 2xx. PayPal's own answer still differs from your books.",
  },
  HANDLER_REJECTING: {
    title: "Your handler turned the delivery away",
    explain: "Your handler answered with an error on each attempt we saw, so the event never reached your books.",
  },
  NO_REPORT: {
    title: "Your handler never reported this event",
    explain: "The event exists, and your handler has no record of it. This does not show that PayPal did not send it: that is why the chip for Doorbell is separate.",
  },
  NO_EVENT_FOUND: {
    title: "No event found anywhere",
    explain: "Neither Doorbell nor PayPal's events list has this event after 6 minutes. We cannot prove that PayPal made it.",
  },
  UNVERIFIED: {
    title: "Not provable yet",
    explain: "Doorbell will not call this a gap, or tied, until the evidence is in.",
  },
};

const FLAGGED: Record<Flag, EvidenceWords> = {
  OUT_OF_ORDER: {
    title: "A later “paid” event overwrote the refund",
    explain: "The refund reached your handler first. A payment event that arrived after it was booked on top, so the books say paid.",
  },
  CRASHED: {
    title: "The delivery reached your handler, which never answered",
    explain: "A try arrived and no answer was recorded. Doorbell counts that as a crash, not as a delivery that never came.",
  },
  UNSUBSCRIBED_EVENT_TYPE: {
    title: "Your webhook is not subscribed to this kind of event",
    explain: "The event exists, and the shop's webhook does not ask PayPal for events of this type, so none will be sent to it.",
  },
};

export function evidenceWords(f: Pick<Finding, "cls" | "flag">): EvidenceWords {
  return f.flag ? FLAGGED[f.flag] : BASE[f.cls];
}

// ---- Waiting reasons (UNVERIFIED) ----------------------------------------------------------------------------------------

export const WAITING_PHRASE: Record<Waiting, string> = {
  requery_failed: "PayPal's answer to our re-check did not arrive, so nothing is known yet",
  status_not_modeled: "PayPal reports a state this demo shop does not book",
  settling: "Your handler just answered; its books get 10 s to show it",
  handler_working: "Your handler has the delivery and has not answered yet",
  absence_window: "Too new to call absent: a claim that something is missing waits 6 minutes",
  listing_unavailable: "PayPal's events list could not be read, so “not listed” proves nothing",
  reporter_record_missing: "Your handler noted the delivery, but its report has not landed",
};

// ---- Ring again ----------------------------------------------------------------------------------------------------------

export interface RingWords {
  label: string; // on the button
  enabled: boolean;
  reason?: string; // why it is not available, in a phrase
}

// `eventWord` ("refund" or "payment") names the event in the reason when the caller knows which one it is.
export function ringWords(ring: Ring | null | undefined, eventWord?: string): RingWords {
  if (!ring) return { label: "Ring again", enabled: false, reason: "Nothing to ring: this event is not waiting for the books." };
  const wait = ring.waitMs !== undefined && ring.waitMs > 0 ? duration(ring.waitMs) : null;
  const reasons: Record<Exclude<RingState, "ready">, string> = {
    wait: wait ? `Not provable yet. Doorbell can say more in about ${wait}.` : "Not provable yet.",
    cannot_heal: "No event found anywhere, so there is nothing PayPal could be asked to resend.",
    not_listed: `PayPal has not listed ${eventWord ? `the ${eventWord} event` : "this event"} yet, usually 1 to 3 minutes after ${eventWord ? `the ${eventWord}` : "it happens"} (median about 80 s, up to 163 s measured). A resend needs it listed, so Ring again unlocks when it is.`,
    retries_pending: wait ? `PayPal is still retrying on its own, for about ${wait} more. Ringing now could double the delivery.` : "PayPal is still retrying on its own.",
    in_progress: "A resend was just accepted. Waiting for it to arrive.",
    cap_reached: ring.label,
  };
  if (ring.state === "ready") return { label: "Ring again", enabled: true };
  return { label: "Ring again", enabled: false, reason: reasons[ring.state] };
}

// What happened after a ring. The word "healed" is used only when the row itself is TIED (the books changed and agree with PayPal).
export interface HealWords {
  title: string;
  detail: string;
  tied: boolean;
}

export function healWords(heal: { state: HealState; sends: number; arrivalSeconds?: number; answer?: number }, rowTied: boolean): HealWords {
  const sent = `${heal.sends} resend${heal.sends === 1 ? "" : "s"}`;
  const arrived = heal.arrivalSeconds !== undefined ? `arrived ${heal.arrivalSeconds} s after it was accepted` : "arrived";
  const answered = heal.answer !== undefined ? `, and your handler answered ${heal.answer}` : "";
  switch (heal.state) {
    case "healed":
      return rowTied
        ? { title: "Healed", detail: `The resent delivery ${arrived}${answered}. The books changed and now match PayPal's own answer.`, tied: true }
        : { title: "Resend delivered, books being checked", detail: `The resent delivery ${arrived}${answered}. This row is not marked TIED yet.`, tied: false };
    case "arrived":
      return { title: "Resend delivered, books being checked", detail: `The resent delivery ${arrived}${answered}. The books do not match PayPal's answer yet.`, tied: false };
    case "unchanged":
      return { title: "Resend delivered, books still differ", detail: `The resent delivery ${arrived}${answered}, and the books still differ from PayPal's answer.`, tied: false };
    case "lost":
      return { title: "Resend accepted, not delivered", detail: `PayPal accepted ${sent} and nothing reached your handler within 60 s of the last one. A resend that does not arrive repairs nothing.`, tied: false };
    case "sent":
      return { title: "Resend accepted, waiting for it to arrive", detail: `PayPal accepted ${sent}. Doorbell looks for the delivery for up to 60 s and does not call this healed until the books change.`, tied: false };
  }
}

// ---- the cause card: closed reasons --------------------------------------------------------------------------------------

export const NOT_PROVEN_PHRASE: Record<NotProvenReason, string> = {
  model_abstained: "The AI found no changed line that explains this gap.",
  inconsistent_with_symptom: "The AI's answer did not fit what your handler actually answered.",
  no_citation: "The AI's answer pointed at no line.",
  too_many_lines: "The AI's answer pointed at too many lines to be useful.",
  unknown_id: "The AI's answer pointed at a line that is not in the diff.",
  not_a_changed_line: "The AI's answer pointed at a line that did not change.",
  comment_line: "The AI's answer pointed at a comment, and a comment is not evidence.",
  blank_line: "The AI's answer pointed at a blank line.",
  string_line: "The AI's answer pointed at a line that is only text.",
  mixed_script: "The AI's answer pointed at a line with look-alike letters from another alphabet.",
  file_mismatch: "The AI's answer named a different file than the line it pointed at.",
};

export const NOT_DIAGNOSED_PHRASE: Record<NotDiagnosedReason, string> = {
  timeout: "The AI step took too long.",
  network: "The AI step could not be reached.",
  bad_json: "The AI step gave an answer the code could not read.",
  empty: "The AI step gave no answer.",
  rate_limited: "The AI step was refused for now (too many calls).",
  upstream_error: "The AI service had an error.",
  auth_or_billing: "The AI step is not available on this deployment.",
  no_key: "The AI step is not set up on this deployment.",
  no_recording: "There is no recorded AI answer for this case.",
  input_rejected: "The input for the AI step was refused by the safety checks.",
  budget: "The AI step is paused to stay inside its budget.",
  call_cap: "The AI step reached its limit of calls for this scan.",
  error: "The AI step failed.",
};

// ---- the recorded scenarios ----------------------------------------------------------------------------------------
// Their labels sit on radio buttons, where an explained word cannot go, so they use none of the ten glossary words.

export const SCENARIO_LABEL: Record<string, string> = {
  refund_never_booked: "Dropped after a 200 OK",
  late_payment_overwrites: "A late payment wins",
  signature_rejected: "Rejected with 401 three times",
  resend_not_delivered: "Ring again, one never arrived",
  cause_not_in_code: "Rejected after a settings change",
  dispute_never_heard: "A dispute nobody heard",
};
