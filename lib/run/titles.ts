// The titles of the recorded steps that depend on what happened (the ones after "Ring again"). They are written from the snapshot's own rows,
// with fixed words and the numbers in it, so a title cannot say more than its step shows: "tied again" only for rows that are TIED (whose books
// changed to what PayPal says), and a resend that PayPal accepted and never delivered is said to be exactly that. recorded.test.ts checks that
// every stored title is what these functions return for its step.
import type { ScanEvent, ScanRow } from "../gaps/scan.ts";
import type { RecordedScenario, RunSnapshot } from "./snapshot.ts";

// The first step of each scenario: what the visitor sees first. Fixed words; the fixtures' first titles must be exactly these (recorded.test.ts).
export const FIRST_TITLES = {
  refund_never_booked: "PayPal refunded two orders. The shop's books still say paid.",
  late_payment_overwrites: "A late payment message arrived after the refund and overwrote it. The books say paid again.",
  signature_rejected: "PayPal sent each refund 3 times; the shop answered 401 on all three tries.",
  resend_not_delivered: "PayPal sent each refund 3 times; the shop answered 401 on all three tries.",
  cause_not_in_code: "PayPal sent each refund 3 times; the shop answered 401 on all three tries. The last deploy changed only a comment, so no cause is proven.",
} as const satisfies Record<RecordedScenario["id"], string>;

// The second step: what the fix was. In the first three scenarios it is the handler; in cause_not_in_code the code was never the problem, so it is the setting.
const CODE_FIX_TITLE = "The fix is deployed: the handler books refunds correctly again. The gaps stay until PayPal sends the messages again.";
export const FIX_TITLES = {
  refund_never_booked: CODE_FIX_TITLE,
  late_payment_overwrites: CODE_FIX_TITLE,
  signature_rejected: CODE_FIX_TITLE,
  resend_not_delivered: CODE_FIX_TITLE,
  cause_not_in_code: "The fix is deployed: the shop checks signatures against its own webhook ID again. The gaps stay until PayPal sends the messages again.",
} as const satisfies Record<RecordedScenario["id"], string>;

const healOf = (row: ScanRow): NonNullable<ScanEvent["heal"]> | null => row.events.find((e) => e.heal)?.heal ?? null;
const rowsOf = (s: RunSnapshot, caps: string[]): ScanRow[] => caps.map((c) => s.scan!.rows.find((r) => r.captureId === c)).filter((r): r is ScanRow => !!r);
const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

// The step right after Ring again was pressed for every gap row.
export function ringTitle(s: RunSnapshot, caps: string[]): string {
  const rows = rowsOf(s, caps);
  const tied = rows.filter((r) => r.status === "TIED").length;
  const reached = rows.filter((r) => r.status === "TIED" || ["arrived", "healed", "unchanged"].includes(healOf(r)?.state ?? "")).length;
  return `Ring again: PayPal accepted a resend for each row (HTTP 202). ${reached} of ${rows.length} ${plural(reached, "has", "have")} already reached the shop; ${tied} ${plural(tied, "row is", "rows are")} tied again.`;
}

// The last step: how the resends ended.
export function finalTitle(s: RunSnapshot, caps: string[]): string {
  const rows = rowsOf(s, caps);
  const open = rows.filter((r) => r.status !== "TIED");
  const more = rows.filter((r) => r.status === "TIED" && (healOf(r)?.sends ?? 0) > 1).length;
  if (open.length === 0) return `All ${rows.length} rows are tied again: the resent messages reached the shop and the books changed${more > 0 ? ` (${more} needed more than one resend)` : ""}.`;
  const tied = rows.length - open.length;
  const sends = open.map((r) => healOf(r)?.sends ?? 0);
  const capped = open.some((r) => r.events.some((e) => e.ring?.state === "cap_reached"));
  const accepted = `PayPal accepted ${sends.join(" and ")} ${plural(sends.reduce((a, b) => a + b, 0), "resend", "resends")}`;
  return `${tied} of ${rows.length} rows ${plural(tied, "is", "are")} tied again. For the other${open.length > 1 ? "s" : ""}: resend accepted, not delivered (${accepted}; none reached the shop${capped ? ", and the session's 5 resends are now used up" : ""}). The gap stays open.`;
}

// ---- the fifth run: a dispute the shop never heard (scripts/record-run.ts, dispute_never_heard) ------------------------------------------------
// Four steps, each title written from its own snapshot with fixed words and the snapshot's numbers, so that a title cannot say more than the step shows.
//   before  the three orders are tied; nothing is wrong yet
//   listed  PayPal lists the dispute (the chargeback was made about a minute ago); the shop's books have none
//   due     PayPal has set the response-due date; the capture shows PENDING
//   ring    Ring again was pressed: nothing was sent
export type DisputeStep = "before" | "listed" | "due" | "ring";

const utc = (ms: number): string => `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;

export function disputeTitle(step: DisputeStep, s: RunSnapshot, captureId: string): string {
  const scan = s.scan!;
  if (step === "before") return `${scan.summary.tied} of ${scan.summary.rows} ${plural(scan.summary.rows, "order is", "orders are")} tied: the books agree with PayPal.`;
  const row = scan.rows.find((r) => r.captureId === captureId);
  const d = row?.disputes?.[0];
  if (!row || !d) return `No dispute is listed on ${row ? `order #${row.n}` : "an order of this session"} yet.`;
  const why = d.webhooks.any === false ? "no webhook of this app subscribes to dispute events" : d.webhooks.shop === false ? "the shop's webhook is not subscribed to dispute events" : null;
  if (step === "listed") return `PayPal lists a $${d.amount} dispute on order #${row.n}. The shop's books have none${why ? `, and ${why}` : ""}.`;
  if (step === "due") {
    const status = row.paypalStatus === "PENDING" ? "The capture now shows PENDING at PayPal" : row.paypalStatus === "COMPLETED" ? "The capture still shows COMPLETED at PayPal" : "The capture shows another status at PayPal";
    const due = d.sellerResponseDueAt === null ? "PayPal has not set a response-due date yet" : `PayPal's response-due date is ${utc(d.sellerResponseDueAt)}, the one our Sandbox test call asked for`;
    return `${status}. ${due}.`;
  }
  const flagged = d.finding?.flag === "UNSUBSCRIBED_EVENT_TYPE";
  return `Ring again: nothing was sent.${flagged && why ? ` ${why.charAt(0).toUpperCase()}${why.slice(1)}, so Doorbell has no event to ask PayPal to send again.` : ""}`;
}
