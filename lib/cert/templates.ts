// The words of the certificate (R9, plan 5.5). The certificate is a template plus numbers counted from the scan: no sentence in it is
// built from a string that came from PayPal, from the shop, or from a model. A function here takes numbers and returns a sentence;
// nothing takes a string. That is what lets a test inject a marker string anywhere into a scan and find it nowhere in the output.
//
// DO NOT CHANGE 3: no sentence here claims that the shop is in good order. Green means only that the rows we could check agreed, and
// its text says "of what we can see". A test scans this whole file, comments included, for the words the plan forbids.

const s = (n: number, one: string, many: string = `${one}s`): string => (n === 1 ? one : many);

// ---- the stamp --------------------------------------------------------------------------------------------------------------------
export const stampText = {
  green: (rows: number) => `Tied on ${rows}/${rows} of what we can see`,
  amber: (tied: number, rows: number, unverified: number) => `Tied on ${tied}/${rows} · ${unverified} unverified`,
  amberEmpty: () => "Nothing checked yet",
  red: (gaps: number, tied: number, rows: number, unverified: number) => `${gaps} ${s(gaps, "gap")} · Tied on ${tied}/${rows}${unverified > 0 ? ` · ${unverified} unverified` : ""}`,
};

// ---- the header sentence ----------------------------------------------------------------------------------------------------------
// It leads with what was found, because that is what a reader needs first; how much was checked comes after, as a secondary fact. A run that
// found nothing has nothing to lead with, so there it starts with the coverage (that is the whole news).
export const header = {
  empty: () => "Nothing checked yet: this session has no orders", // the sentence's full stop is added where the parts are joined
  checked: (checked: number, rows: number, pct: number) => `Checked ${checked} of ${rows} ${s(rows, "capture")} (${pct}%)`,
  // What was found. Before any resend: how many captures disagree with PayPal. Once a resend has repaired some: found, healed, still open.
  found: (gaps: number, healed: number, rows: number) => (healed === 0 ? `${gaps} of ${rows} ${s(rows, "capture")} did not match PayPal` : `${gaps + healed} ${s(gaps + healed, "gap")} found · ${healed} healed · ${gaps} still open`),
  kinds: (byClass: string) => ` (${byClass})`, // appended to the found sentence; it describes the gaps that are still open
  coverage: (checked: number, rows: number) => `checked ${checked} of ${rows} ${s(rows, "capture")}`,
  // Rows whose books were last written by PayPal's own retry of a message the shop did not take (lib/gaps/closure.ts). The first is the short clause the story
  // puts after the stamp text; the second adds what came before, with the earlier tries of those rows counted together ("try" when that count is 1).
  bookedOnRetry: (n: number) => `${n} booked on PayPal's own retry`,
  closedByPaypalRetry: (n: number, earlierTries: number) => `${header.bookedOnRetry(n)}, after the shop did not take the earlier ${s(earlierTries, "try", "tries")}`,
  tooNew: (n: number) => `${n} too new to verify`,
  requeryFailed: (n: number) => `${n} not re-queried (PayPal did not answer)`,
  otherUnverified: (n: number) => `${n} unverified for another reason`,
  missingRefundEvent: (n: number) => `webhook missing REFUNDED on ${n}`,
  missingPaymentEvent: (n: number) => `webhook missing the payment event on ${n}`,
  // Open disputes PayPal lists on an order that the shop's books know nothing about. The amount is the disputed amount, summed in cents.
  disputes: (n: number, amount: string) => `${n} open ${s(n, "dispute")} on PayPal that the books do not show ($${amount})`,
  money: (amount: string, refunds: number, payments: number) => {
    if (payments === 0) return `$${amount} across ${refunds} ${s(refunds, "refund")} not in books`;
    if (refunds === 0) return `$${amount} across ${payments} ${s(payments, "payment")} not in books`;
    return `$${amount} across ${refunds} ${s(refunds, "refund")} and ${payments} ${s(payments, "payment")} not in books`;
  },
};

// The class names the header may mention: a closed list, so an unknown class (from anything but our own code) cannot become words.
export const CLASS_ORDER = ["ACKED_BUT_NOT_APPLIED", "HANDLER_REJECTING", "NO_REPORT", "NO_EVENT_FOUND"] as const;
export const classPhrase: Record<(typeof CLASS_ORDER)[number], (n: number) => string> = {
  // True of each row in the class, including the ones whose books DID change and were then overwritten (those are told apart below).
  ACKED_BUT_NOT_APPLIED: (n) => `${n} answered OK but the books do not match PayPal`,
  HANDLER_REJECTING: (n) => `${n} rejected by the handler`,
  NO_REPORT: (n) => `${n} with no report from the shop`,
  NO_EVENT_FOUND: (n) => `${n} with no event found`,
};
// A late "paid" that overwrote a refund: class ACKED_BUT_NOT_APPLIED with the flag OUT_OF_ORDER. It is counted here and not in the line above.
export const lateOverwritePhrase = (n: number): string => `${n} overwritten by a late payment`;

// ---- the limits that apply to THIS run, each with its number ------------------------------------------------------------------------
export const limits = {
  noEventFound: (n: number) => `${n} ${s(n, "event")} could not be found at the witness or in PayPal's event list: whether PayPal created ${n === 1 ? "it" : "them"} cannot be proven from here.`,
  tooNew: (n: number) => `${n} ${s(n, "row is", "rows are")} too new to verify: the books get 10 s after the shop answers, and an event that is absent needs 6 minutes before it can be called missing.`,
  insideListLag: (n: number) => `${n} ${s(n, "row is", "rows are")} inside PayPal's event-list lag (median about 80 s, up to 163 s measured): an event missing from the list proves nothing yet.`,
  requeryFailed: (n: number) => `${n} ${s(n, "re-query", "re-queries")} of PayPal failed after one retry; ${n === 1 ? "that row stays" : "those rows stay"} unverified.`,
  // One line for each reason a row can be unverified, so that no line says something that is not why.
  statusNotModeled: (n: number) => `${n} ${s(n, "row")} ${n === 1 ? "shows" : "show"} a PayPal state that the shop has no entry for, so ${n === 1 ? "it is" : "they are"} not compared.`,
  listingUnavailable: (n: number) => `${n} ${s(n, "row")} could not be judged because PayPal's event list could not be read.`,
  reporterRecordMissing: (n: number) => `${n} ${s(n, "row")}: the shop noted the event arriving, but its reporter has no record of what it answered, so the result is unknown.`,
  otherUnverified: (n: number) => `${n} ${s(n, "row")} could not be confirmed.`,
  deadline: (seconds: string) => `The scan stopped waiting for PayPal after ${seconds} s; rows it had not reached are unverified.`,
  listNotRead: () => "PayPal's event list could not be read this time, so rows that depend on it stay unverified.",
  // The disputes of a Sandbox shop. The first is the cannot-prove line: with no webhook subscribed PayPal made no event that could be counted, and a
  // missing event is not proof that none was made (in the one test, PayPal listed none in 8 minutes).
  disputeNoWebhook: (n: number) => `${n} ${s(n, "dispute")}: no webhook of this app subscribes to dispute events, so whether PayPal would have sent an event cannot be proven from here (in our one test it listed none in 8 minutes).`,
  disputeDueDate: () => "A Sandbox dispute's response-due date is the one the test call that made it asked for, not a deadline that PayPal's own rules produced.",
  disputesUnreadable: (n: number) => `PayPal's dispute list could not be read for ${n} ${s(n, "order")}, so an open dispute on ${n === 1 ? "it is" : "them is"} not ruled out.`,
  // One sentence: the record is the subject, so it does not read as a dodge. It says what the tries show and that the record stops there. The earlier tries
  // are counted the way the header counts them (header.closedByPaypalRetry).
  closedByPaypalRetry: (n: number, earlierTries: number) => `${n} ${s(n, "capture")} ${n === 1 ? "was" : "were"} booked on PayPal's own retry, after the shop did not take the earlier ${s(earlierTries, "try", "tries")}; this record does not show why, or whether the shop's code changed in between.`,
  unreadableAmounts: (n: number) => `${n} ${s(n, "amount")} could not be read, so the money total leaves ${n === 1 ? "it" : "them"} out.`,
};

// ---- the standing footnote (plan 5.5): always the same one line ---------------------------------------------------------------------
export const FOOTNOTE =
  "Orders that were approved but never captured cannot be counted (PayPal has no list API for them). An event that is not in PayPal's event list cannot be shown to have existed. Transaction Search lags about 97-128 minutes, so the last 2 hours of transactions were not used. This certificate is not signed: anyone could edit it.";

// ---- the owner view: plain sentences, no jargon (plan 5.5, video 2:10) --------------------------------------------------------------
export const owner = {
  empty: () => "No orders have been checked yet.",
  checked: (checked: number, rows: number) => `We checked ${checked} of your ${rows} ${s(rows, "order")} against PayPal's own records.`,
  // What was wrong, in one line, once a resend has repaired it: the books would otherwise read as if nothing had ever been off.
  healed: (n: number, amount: string) => `${n} ${s(n, "order")} did not match PayPal earlier ($${amount}). PayPal was asked to send ${n === 1 ? "its message" : "their messages"} again, and your books now match.`,
  // Two sentences, for what the books really say: an entry that says paid, or no entry that shows the refund (no record at all, or anything else).
  refundsStillPaid: (n: number, amount: string) => `${n} ${s(n, "refund")} that PayPal made ${n === 1 ? "is" : "are"} still marked as paid in your books. That is $${amount}.`,
  refundsNotShown: (n: number, amount: string) => `PayPal refunded ${n} ${s(n, "order")}; your books do not show the ${s(n, "refund")}. That is $${amount}.`,
  payments: (n: number, amount: string) => `${n} ${s(n, "payment")} that PayPal took ${n === 1 ? "is" : "are"} missing from your books. That is $${amount}.`,
  // Disputes. The amount is what a customer is asking PayPal to take back; the second sentence is only said when the shop's webhook cannot have told it.
  disputes: (n: number, amount: string) => `PayPal lists ${n} open ${s(n, "dispute")} on your orders that your books do not show. That is $${amount} under dispute.`,
  disputesNotTold: () => "Your shop's webhook is not set up to hear about disputes, so PayPal would not have told it.",
  disputesUnreadable: (n: number) => `PayPal's dispute list could not be read for ${n} ${s(n, "order")}, so an open dispute on ${n === 1 ? "it" : "them"} is not ruled out.`,
  // A tied row that no resend of ours touched: its books were written by PayPal's own retry. It says nothing about what we did or did not send, and nothing about why.
  closedByPaypalRetry: (n: number) => `${n} ${s(n, "order")}: your shop did not take PayPal's message at first. PayPal tried again by itself, and your books took it then.`,
  gapsNeedAttention: () => "These need your attention: your books and PayPal disagree.",
  tooNew: (n: number) => `${n} ${s(n, "order")} ${n === 1 ? "is" : "are"} too new to check yet. Look again in a few minutes.`,
  requeryFailed: (n: number) => `PayPal did not answer for ${n} ${s(n, "order")}, so ${n === 1 ? "that one was" : "those were"} not checked.`,
  otherUnverified: (n: number) => `${n} ${s(n, "order")} could not be confirmed, so ${n === 1 ? "it is" : "they are"} left out of the check.`,
  agree: (tied: number, rows: number) => `Your books match PayPal on ${tied} of ${rows} ${s(rows, "order")}.`,
  limit: () => "We can only check what PayPal tells us about. An order that was started but never paid cannot be counted.",
  unsigned: () => "This page is not signed. Anyone could edit it, so treat it as a report, not a receipt.",
};
