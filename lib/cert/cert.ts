// The certificate (R9, plan 5.5): what a scan found, said once, in words that come from templates and numbers that come from counting.
//
//   certificateOf(scan, ctx)  ->  Certificate
//
// Computed from the ScanResult only. Nothing from a model reaches it, and no string of the scan does either: the output is made of the
// sentences in templates.ts and of integers counted here (the money is summed in minor units, cents, so there is no float rounding).
// Anything in the scan that is not one of the values this code knows is treated as the careful answer: a row whose status is not
// TIED, GAP or UNVERIFIED is UNVERIFIED; a class name that is not on the closed list is not shown; an amount that is not "12.34" is left
// out of the money and said so. The stamp:
//
//   green  coverage 100% AND unverified 0 AND gaps 0 (and at least one row: with nothing checked there is nothing to be green about)
//   amber  no gap, but coverage under 100% or something unverified, or nothing checked yet
//   red    at least one gap
//
// Two kinds of tied row are told apart from the gaps that are still open. `healed`: a heal record says healed AND carries the resend's arrival (a resend
// that was asked for and never seen to arrive proves nothing). `closedByPaypalRetry`: no resend of ours arrived, and the books were last written by
// PayPal's own retry after the shop did not take the earlier tries (lib/gaps/closure.ts). The two never overlap. A row closed by a delivery nobody asked
// for (a new transmission id) is in neither: the certificate cannot call that PayPal's retry.
import type { Certificate, DisputeNumbers, StampState } from "../run/snapshot.ts";
import { closureOf, healArrived } from "../gaps/closure.ts";
import type { ScanResult, ScanRow } from "../gaps/scan.ts";
import { CLASS_ORDER, FOOTNOTE, classPhrase, header, lateOverwritePhrase, limits, owner, stampText } from "./templates.ts";

// Numbers only: this type has no place for a string, so a caller cannot hand the certificate a sentence.
export interface CertificateContext {
  rowsInsideListLag?: number; // rows whose last action is younger than PayPal's event-list lag (see rowsInsideListLag below)
}

type Class = (typeof CLASS_ORDER)[number];
const isClass = (v: unknown): v is Class => typeof v === "string" && (CLASS_ORDER as readonly string[]).includes(v);

const TOO_NEW = new Set(["settling", "absence_window", "handler_working"]);
const AMOUNT = /^(\d{1,9})\.(\d{2})$/;

// "48.00" -> 4800. null for anything else.
export function toMinor(amount: unknown): number | null {
  if (typeof amount !== "string") return null;
  const m = AMOUNT.exec(amount);
  return m ? Number(m[1]) * 100 + Number(m[2]) : null;
}

// 9600 -> "96.00"
export const fromMinor = (minor: number): string => `${Math.floor(minor / 100)}.${String(minor % 100).padStart(2, "0")}`;

const count = (n: unknown): number => (typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0);

function statusOf(row: ScanRow): "TIED" | "GAP" | "UNVERIFIED" {
  return row.status === "TIED" || row.status === "GAP" ? row.status : "UNVERIFIED"; // anything else is not a verdict
}

export function certificateOf(scan: ScanResult, ctx: CertificateContext = {}): Certificate {
  const rows: ScanRow[] = Array.isArray(scan.rows) ? scan.rows : [];
  const total = rows.length;

  let tied = 0;
  let healed = 0; // rows that were a gap and are tied now because a resend made the books change (the heal record says healed, and the resend arrived)
  let healedMinor = 0;
  let closedByPaypalRetry = 0; // tied rows whose books PayPal's own retry wrote after the shop did not take the earlier tries (no resend of ours arrived)
  let earlierTries = 0; // the tries before the closing one, summed over those rows: only for the grammar of one sentence
  let gaps = 0;
  let unverified = 0;
  let tooNew = 0;
  let requeryFailed = 0;
  let notModeled = 0; // unverified: PayPal says a state the shop has no entry for
  let listingDown = 0; // unverified: PayPal's event list could not be read
  let reporterMissing = 0; // unverified: the shop noted the event but its reporter has no record
  let unknownReason = 0; // unverified, and no reason this code knows
  let outOfOrder = 0; // gap events flagged OUT_OF_ORDER: a late "paid" overwrote the refund
  let absent = 0; // NO_EVENT_FOUND events
  let missingRefundEvent = 0;
  let missingPaymentEvent = 0;
  let refunds = 0;
  let payments = 0;
  let refundMinor = 0;
  let refundsPaid = 0; // refunds whose books entry says paid
  let refundPaidMinor = 0;
  let paymentMinor = 0;
  let unreadable = 0;
  const byClass: Record<string, number> = {};
  // Disputes (ScanRow.disputes). Counted from the rows' own numbers and fixed words, like everything else here.
  let disputesOpen = 0;
  let disputesGap = 0;
  let disputesUnverified = 0;
  let disputesUnsubscribed = 0; // gaps whose finding is "the shop's webhook is not subscribed"
  let disputesNoWebhook = 0; // gaps where no webhook of the app is subscribed at all
  let disputeMinor = 0;

  for (const row of rows) {
    const rowDisputes = (Array.isArray(row.disputes) ? row.disputes : []).filter((d) => d && typeof d === "object");
    for (const d of rowDisputes) {
      disputesOpen++;
      if (d.status === "GAP") {
        disputesGap++;
        const minor = toMinor(d.amount);
        if (minor === null) unreadable++;
        disputeMinor += minor ?? 0;
        if (d.finding?.flag === "UNSUBSCRIBED_EVENT_TYPE") disputesUnsubscribed++;
        if (d.webhooks?.any === false) disputesNoWebhook++;
        if (d.finding?.cls === "NO_EVENT_FOUND") absent++;
      } else if (d.status !== "TIED") {
        disputesUnverified++;
      }
    }
    const status = statusOf(row);
    if (status === "TIED") {
      tied++;
      if ((Array.isArray(row.events) ? row.events : []).some((e) => e?.heal?.state === "healed" && healArrived(e.heal))) {
        healed++;
        healedMinor += toMinor(row.amount) ?? 0;
      } else {
        const closure = closureOf(row);
        if (closure?.kind === "paypal_retry") {
          closedByPaypalRetry++;
          earlierTries += closure.failed.length;
        }
      }
      continue;
    }
    if (status === "UNVERIFIED") {
      unverified++;
      if (row.waiting === "requery_failed") requeryFailed++;
      else if (typeof row.waiting === "string" && TOO_NEW.has(row.waiting)) tooNew++;
      else if (row.waiting === "status_not_modeled") notModeled++;
      else if (row.waiting === "listing_unavailable") listingDown++;
      else if (row.waiting === "reporter_record_missing") reporterMissing++;
      else unknownReason++;
      continue;
    }
    // A gap row. Its money is the order's amount, on the side PayPal says it is.
    gaps++;
    // A row that is a gap only because of a dispute has no payment or refund of its own that differs: its money is the disputed amount, counted above.
    const eventGap = (Array.isArray(row.events) ? row.events : []).some((e) => isClass(e?.finding?.cls));
    if (!eventGap && rowDisputes.some((d) => d.status === "GAP")) continue;
    const minor = toMinor(row.amount);
    if (minor === null) unreadable++;
    if (row.truth === "refunded") {
      refunds++;
      refundMinor += minor ?? 0;
      // What the books really say decides the owner's sentence: an entry that says paid, or no entry that shows the refund (none at all, or any other).
      if (row.book?.state === "paid") {
        refundsPaid++;
        refundPaidMinor += minor ?? 0;
      }
    } else {
      payments++;
      paymentMinor += minor ?? 0;
    }
    for (const e of Array.isArray(row.events) ? row.events : []) {
      const cls = e?.finding?.cls;
      if (!isClass(cls)) continue; // UNVERIFIED findings and anything unknown are not counted as a gap class
      byClass[cls] = (byClass[cls] ?? 0) + 1;
      if (cls === "ACKED_BUT_NOT_APPLIED" && e.finding?.flag === "OUT_OF_ORDER") outOfOrder++;
      if (cls === "NO_EVENT_FOUND") absent++;
      if (cls === "NO_REPORT") {
        if (e.kind === "refunded") missingRefundEvent++;
        else missingPaymentEvent++;
      }
    }
  }

  const otherUnverified = notModeled + listingDown + reporterMissing + unknownReason; // one count in the header, one line each below
  const disputesUnread = scan.disputeReads ? count(scan.disputeReads.unreadable) : 0; // captures whose dispute list was not read
  // Present when the scan looked for disputes or found one; a scan from before disputes existed has neither, and its certificate is unchanged.
  const disputeNumbers: DisputeNumbers | undefined =
    scan.disputeReads || disputesOpen > 0
      ? { open: disputesOpen, notInBooks: disputesGap, unverified: disputesUnverified, unsubscribed: disputesUnsubscribed, noWebhook: disputesNoWebhook, moneyNotInBooks: fromMinor(disputeMinor), unreadable: disputesUnread }
      : undefined;
  const checked = tied + gaps;
  const coveragePct = total === 0 ? 0 : Math.floor((checked * 100) / total);
  const moneyMinor = refundMinor + paymentMinor;
  const stamp: StampState = gaps > 0 ? "red" : total > 0 && coveragePct === 100 && unverified === 0 ? "green" : "amber";

  const stampLine = stamp === "red" ? stampText.red(gaps, tied, total, unverified) : stamp === "green" ? stampText.green(total) : total === 0 ? stampText.amberEmpty() : stampText.amber(tied, total, unverified);

  // ---- the header sentence ----
  const parts: string[] = [];
  if (total === 0) {
    parts.push(header.empty());
  } else {
    // Lead with what was found; the coverage follows as a secondary fact. A run that found nothing leads with the coverage.
    const found = gaps + healed;
    const named: string[] = [];
    for (const c of CLASS_ORDER) {
      const n = (byClass[c] ?? 0) - (c === "ACKED_BUT_NOT_APPLIED" ? outOfOrder : 0);
      if (n > 0) named.push(classPhrase[c](n));
      if (c === "ACKED_BUT_NOT_APPLIED" && outOfOrder > 0) named.push(lateOverwritePhrase(outOfOrder));
    }
    if (found === 0) {
      parts.push(header.checked(checked, total, coveragePct));
    } else {
      parts.push(`${header.found(gaps, healed, total)}${gaps > 0 && named.length > 0 ? header.kinds(named.join(", ")) : ""}`);
    }
    if (missingRefundEvent > 0) parts.push(header.missingRefundEvent(missingRefundEvent));
    if (missingPaymentEvent > 0) parts.push(header.missingPaymentEvent(missingPaymentEvent));
    if (disputesGap > 0) parts.push(header.disputes(disputesGap, fromMinor(disputeMinor)));
    if (gaps > 0 && moneyMinor > 0) parts.push(header.money(fromMinor(moneyMinor), refunds, payments));
    if (found > 0) parts.push(header.coverage(checked, total));
    if (closedByPaypalRetry > 0) parts.push(header.closedByPaypalRetry(closedByPaypalRetry, earlierTries));
    if (tooNew > 0) parts.push(header.tooNew(tooNew));
    if (requeryFailed > 0) parts.push(header.requeryFailed(requeryFailed));
    if (otherUnverified > 0) parts.push(header.otherUnverified(otherUnverified));
  }

  // ---- the limits that apply to this run ----
  const lim: string[] = [];
  if (absent > 0) lim.push(limits.noEventFound(absent));
  if (tooNew > 0) lim.push(limits.tooNew(tooNew));
  const lag = count(ctx.rowsInsideListLag);
  if (lag > 0) lim.push(limits.insideListLag(lag));
  if (requeryFailed > 0) lim.push(limits.requeryFailed(requeryFailed));
  if (notModeled > 0) lim.push(limits.statusNotModeled(notModeled));
  if (listingDown > 0) lim.push(limits.listingUnavailable(listingDown));
  if (reporterMissing > 0) lim.push(limits.reporterRecordMissing(reporterMissing));
  if (unknownReason > 0) lim.push(limits.otherUnverified(unknownReason));
  if (scan.deadlineHit === true) lim.push(limits.deadline((Math.round(count(scan.durationMs) / 100) / 10).toFixed(1)));
  if (scan.listing?.asked === true && scan.listing.read !== true) lim.push(limits.listNotRead());
  if (unreadable > 0) lim.push(limits.unreadableAmounts(unreadable));
  if (disputesNoWebhook > 0) lim.push(limits.disputeNoWebhook(disputesNoWebhook));
  if (disputesOpen > 0) lim.push(limits.disputeDueDate());
  if (disputesUnread > 0) lim.push(limits.disputesUnreadable(disputesUnread));
  if (closedByPaypalRetry > 0) lim.push(limits.closedByPaypalRetry(closedByPaypalRetry, earlierTries));

  // ---- the owner view ----
  const view: string[] = [];
  if (total === 0) {
    view.push(owner.empty());
  } else {
    view.push(owner.checked(checked, total));
    if (healed > 0) view.push(owner.healed(healed, fromMinor(healedMinor)));
    if (gaps > 0) {
      if (refundsPaid > 0) view.push(owner.refundsStillPaid(refundsPaid, fromMinor(refundPaidMinor)));
      if (refunds > refundsPaid) view.push(owner.refundsNotShown(refunds - refundsPaid, fromMinor(refundMinor - refundPaidMinor)));
      if (payments > 0) view.push(owner.payments(payments, fromMinor(paymentMinor)));
      if (disputesGap > 0) view.push(owner.disputes(disputesGap, fromMinor(disputeMinor)));
      if (disputesUnsubscribed > 0) view.push(owner.disputesNotTold());
      view.push(owner.gapsNeedAttention());
    } else if (unverified === 0) {
      view.push(owner.agree(tied, total));
    }
    // After what is wrong or what matches: the near miss is a footnote about one of the orders, and the owner view leads with what was found.
    if (closedByPaypalRetry > 0) view.push(owner.closedByPaypalRetry(closedByPaypalRetry));
    if (tooNew > 0) view.push(owner.tooNew(tooNew));
    if (requeryFailed > 0) view.push(owner.requeryFailed(requeryFailed));
    if (otherUnverified > 0) view.push(owner.otherUnverified(otherUnverified));
    if (disputesUnread > 0) view.push(owner.disputesUnreadable(disputesUnread));
  }
  view.push(owner.limit(), owner.unsigned());

  return {
    stamp,
    stampText: stampLine,
    header: `${parts.join(" · ")}.`,
    numbers: {
      rows: total,
      checked,
      tied,
      gaps,
      unverified,
      healed,
      ...(closedByPaypalRetry > 0 ? { closedByPaypalRetry } : {}),
      coveragePct,
      moneyNotInBooks: fromMinor(moneyMinor),
      refundsNotInBooks: refunds,
      byClass,
      ...(disputeNumbers ? { disputes: disputeNumbers } : {}),
    },
    limits: lim,
    footnote: FOOTNOTE,
    ownerView: view,
    scopeAt: count(scan.at),
    signed: false,
  };
}

// How many rows were acted on so recently that PayPal's event list cannot be expected to show their events yet (median 80 s, up to 163 s,
// F3). The caller counts them from the shop's own record (the order or the refund time) and passes the number in `ctx`.
export const LIST_LAG_MS = 163_000;
export function rowsInsideListLag(orders: { at: number; refundAt: number | null }[], scanAt: number): number {
  return orders.filter((o) => scanAt - (o.refundAt ?? o.at) < LIST_LAG_MS).length;
}
