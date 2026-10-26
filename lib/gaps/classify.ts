// The five evidence classes (R4, plan 5.3) and the state of the "Ring again" button (R5). Pure functions: no I/O, no clock, so that
// the recorded probe logs can be replayed through them (classify.test.ts).
//
//   ACKED_BUT_NOT_APPLIED  S answered 2xx and the books still differ      (+ OUT_OF_ORDER: the refund came first, a later "paid" overwrote it)
//   HANDLER_REJECTING      S answered non-2xx, or never answered           (+ CRASHED: reached the handler, never answered)
//   NO_REPORT              the event exists (D or PayPal's list) and S has no record of it   (+ UNSUBSCRIBED_EVENT_TYPE: S's webhook lacks the type)
//   NO_EVENT_FOUND         neither D nor PayPal's list has it: whether PayPal made it cannot be proven from here
//   UNVERIFIED             not provable yet, or the re-query failed
//
// The 6-minute window applies to ABSENCE claims only (NO_REPORT, NO_EVENT_FOUND). What D heard, what S reported and what S's
// subscription says are facts that are final the moment they are read.
import type { AttemptReport } from "../shop/reporter.ts";
import type { BookEntry } from "../shop/types.ts";

export type EvidenceClass = "ACKED_BUT_NOT_APPLIED" | "HANDLER_REJECTING" | "NO_REPORT" | "NO_EVENT_FOUND" | "UNVERIFIED";
export type Flag = "OUT_OF_ORDER" | "CRASHED" | "UNSUBSCRIBED_EVENT_TYPE";
// "dispute": a CUSTOMER.DISPUTE.CREATED event (disputes.ts). Its actionAt is the time the event can first exist, not the time of the chargeback.
export type EventKind = "completed" | "refunded" | "dispute";

// Why a finding is UNVERIFIED (not final). Fixed vocabulary: the screen turns each into a phrase.
export type Waiting =
  | "requery_failed" // the ID re-query failed, so nothing is known (F9)
  | "status_not_modeled" // PayPal reports a state the demo shop does not book
  | "settling" // S has just answered; the books get 10 s to show it
  | "handler_working" // S has the delivery and has not answered yet
  | "absence_window" // an absence claim needs 6 minutes
  | "listing_unavailable" // PayPal's event list could not be read, so "not listed" proves nothing
  | "reporter_record_missing"; // S noted the delivery but the reporter has no record of it

export interface Finding {
  cls: EvidenceClass;
  flag?: Flag;
  final: boolean; // false exactly when cls is UNVERIFIED
  why: string; // a phrase built here from numbers and fixed words only; nothing from PayPal's text or the shop's data
  waiting?: Waiting;
  untilMs?: number; // when an absence claim becomes available
}

export const ABSENCE_WINDOW_MS = 6 * 60_000;
export const BOOKS_SETTLE_MS = 10_000;

export interface EventEvidence {
  kind: EventKind;
  now: number;
  actionAt: number; // when the shop made the payment or the refund at PayPal
  eid: string | null; // the event id as far as S, D or the list tell
  d: { at: number } | null; // the witness heard it
  listed: { createTime: number } | null; // PayPal's list has it
  listingRead: boolean; // the list was read successfully (so "not in it" is a finding)
  attempts: AttemptReport[] | null; // S's reporter; null = no record at all
  sNoted: boolean; // S's webhook wrapper noted that it received this event
  subscribed: boolean | undefined; // S's webhook subscribes to this event type; undefined = not looked up
  books: BookEntry | null;
}

const ok2xx = (a: AttemptReport) => a.state === "responded" && a.status !== undefined && a.status >= 200 && a.status < 300;
const secs = (ms: number) => Math.max(0, Math.round(ms / 1000));

const unverified = (waiting: Waiting, why: string, untilMs?: number): Finding => ({ cls: "UNVERIFIED", final: false, waiting, why, ...(untilMs !== undefined ? { untilMs } : {}) });

export function classify(e: EventEvidence): Finding {
  const attempts = e.attempts ?? [];

  if (attempts.length > 0) {
    const acked = attempts.filter(ok2xx);
    if (acked.length > 0) {
      const lastAck = Math.max(...acked.map((a) => a.respondedAt ?? 0));
      const settledAt = Math.max(lastAck, e.books?.at ?? 0) + BOOKS_SETTLE_MS;
      if (e.now < settledAt) return unverified("settling", "The shop just answered 2xx; its books get 10 seconds to show it.", settledAt);
      const firstReached = Math.min(...attempts.map((a) => a.receivedAt ?? a.respondedAt ?? Infinity));
      // The books say "paid", written by another event after the refund had already reached the shop: a late "paid" overwrote "refunded".
      const outOfOrder = e.kind === "refunded" && e.books?.state === "paid" && e.books.eid !== e.eid && firstReached <= e.books.at;
      return {
        cls: "ACKED_BUT_NOT_APPLIED",
        ...(outOfOrder ? { flag: "OUT_OF_ORDER" as const } : {}),
        final: true,
        why: outOfOrder
          ? "The shop answered 2xx to the refund, then a later 'paid' event overwrote it. The books say paid."
          : `The shop answered ${acked.map((a) => a.status).join(", ")} and the books still differ from PayPal.`,
      };
    }
    const failed = attempts.filter((a) => a.state === "responded");
    const crashed = attempts.filter((a) => a.state === "crashed");
    if (failed.length > 0 || crashed.length > 0) {
      const codes = failed.map((a) => a.status).join(", ");
      return {
        cls: "HANDLER_REJECTING",
        ...(crashed.length > 0 ? { flag: "CRASHED" as const } : {}),
        final: true,
        why: [failed.length ? `The shop answered ${codes} (${failed.length} attempt${failed.length > 1 ? "s" : ""}, none 2xx).` : "", crashed.length ? `${crashed.length} attempt${crashed.length > 1 ? "s" : ""} reached the handler and never answered.` : ""].filter(Boolean).join(" "),
      };
    }
    return unverified("handler_working", "The delivery reached the shop and it has not answered yet.");
  }

  if (e.sNoted) return unverified("reporter_record_missing", "The shop noted receiving this event but the reporter has no record of it.");

  if (e.d !== null || e.listed !== null) {
    // The event exists. If the shop's webhook does not subscribe to its type, that is a fact and it is final at once.
    if (e.subscribed === false) return { cls: "NO_REPORT", flag: "UNSUBSCRIBED_EVENT_TYPE", final: true, why: "The event exists and the shop's webhook is not subscribed to its type." };
    const since = e.listed?.createTime ?? e.d!.at;
    const claimAt = since + ABSENCE_WINDOW_MS;
    if (e.now < claimAt) return unverified("absence_window", `The shop has not reported this event; an absence claim waits 6 minutes (${secs(claimAt - e.now)} s left).`, claimAt);
    return { cls: "NO_REPORT", final: true, why: "The event exists and the shop has no record of receiving it for over 6 minutes." };
  }

  if (!e.listingRead) return unverified("listing_unavailable", "PayPal's event list could not be read, so 'not listed' proves nothing.");
  const claimAt = e.actionAt + ABSENCE_WINDOW_MS;
  if (e.now < claimAt) return unverified("absence_window", `No event found anywhere yet; an absence claim waits 6 minutes (${secs(claimAt - e.now)} s left).`, claimAt);
  return { cls: "NO_EVENT_FOUND", final: true, why: "Neither the witness nor PayPal's event list has this event after 6 minutes: PayPal making it cannot be proven from here." };
}

// ---- Ring again (R5) ------------------------------------------------------------------------------------------------

// PayPal's own retries of a failed delivery (Sandbox: 3 attempts, the last at about 160 s, F5). A group is one transmission id.
export const RETRY_WINDOW_MS = 180_000;
export const SANDBOX_ATTEMPTS = 3;

// The time until which PayPal may still be retrying a failed delivery of this event; 0 when no retry can be pending.
export function retriesPendingUntil(attempts: AttemptReport[] | null, now: number): number {
  const byTid = new Map<string, AttemptReport[]>();
  for (const a of attempts ?? []) byTid.set(a.tid, [...(byTid.get(a.tid) ?? []), a]);
  let until = 0;
  for (const group of byTid.values()) {
    if (group.some(ok2xx) || group.length >= SANDBOX_ATTEMPTS) continue;
    const first = Math.min(...group.map((a) => a.receivedAt ?? a.respondedAt ?? Infinity));
    if (now < first + RETRY_WINDOW_MS) until = Math.max(until, first + RETRY_WINDOW_MS);
  }
  return until;
}

export type RingState = "ready" | "wait" | "cannot_heal" | "not_listed" | "retries_pending" | "in_progress" | "cap_reached";
export interface Ring {
  state: RingState;
  label: string;
  waitMs?: number;
}

export const RESEND_CAP = 5;

export function ringState(i: { finding: Finding; eid: string | null; listed: boolean; retriesUntil: number; inFlight: boolean; resendsUsed: number; now: number }): Ring {
  const { finding: f } = i;
  if (f.cls === "UNVERIFIED") return { state: "wait", label: "Not provable yet", ...(f.untilMs ? { waitMs: Math.max(0, f.untilMs - i.now) } : {}) };
  if (f.cls === "NO_EVENT_FOUND") return { state: "cannot_heal", label: "Cannot auto-heal: no event found anywhere" };
  if (!i.eid || !i.listed) return { state: "not_listed", label: "Cannot auto-heal: the event is not in PayPal's list (it shows up 80 to 163 s late)" };
  if (i.inFlight) return { state: "in_progress", label: "Resent, waiting for it to arrive" };
  if (i.retriesUntil > i.now) return { state: "retries_pending", label: "PayPal is still retrying on its own", waitMs: i.retriesUntil - i.now };
  if (i.resendsUsed >= RESEND_CAP) return { state: "cap_reached", label: `Resend limit reached (${RESEND_CAP} per session)` };
  return { state: "ready", label: "Ring again" };
}
