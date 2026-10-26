// The dispute gap (Track B, variant L "unsubscribed", read only): PayPal has an OPEN dispute on a capture and the shop's books have none.
//
//   - PayPal is asked by capture id: GET /v1/customer/disputes?disputed_transaction_id=<capture> (documented filter; on 2026-10-20 it listed a
//     Sandbox chargeback made on that capture 39 to 100 s after the chargeback call, and answered 200 with no items before that;
//     docs/measurements/disputes-probe-2026-10-20.json). A dispute is "open" when its status is one of the four open ones below.
//   - A dispute the shop has booked is TIED. One it has not is a GAP, and the evidence class is the SAME classifier as for payments and refunds
//     (classify.ts): what PayPal's event list shows, what the shop's reporter saw, whether the shop's webhook subscribes to CUSTOMER.DISPUTE.CREATED.
//     A dispute list that could not be read is no row here: the scan counts it (ScanResult.disputeReads) and the certificate says so.
//   - Doorbell only reads here. It never accepts a claim, answers a dispute or sends evidence. "Ring again" for a dispute never sends anything:
//     the demo shop keeps no dispute book, so a resend could not be shown to change a thing (disputeRing below says so in words).
//
// What is measured, and what is not (n is small, one afternoon):
//   - with NO webhook of the app subscribed to CUSTOMER.DISPUTE.*, PayPal listed no dispute event in 8 minutes (n=1) while the API showed the dispute;
//     with one subscribed, the CREATED event was created 166 to 192 s after the chargeback call (n=4) and listed 46 to 173 s after that;
//   - the witness records payment and refund events only, so it never "heard" a dispute: `d` is always null here;
//   - the demo shop's webhook route answers 200 to an event type it does not book and stores nothing, so for a webhook that IS subscribed an absent
//     reporter record cannot be told from a delivery the shop ignored. The finding then says only what is true: "no record of receiving it".
import type { PaypalClient } from "../pay/paypal.ts";
import { PaypalError } from "../pay/paypal.ts";
import type { AttemptReport } from "../shop/reporter.ts";
import { classify, type Finding, type Ring } from "./classify.ts";
import { EVENT_ID, MAX_PAGES, nextPagePath, WEBHOOK_ID } from "./reads.ts";

export const DISPUTE_CREATED = "CUSTOMER.DISPUTE.CREATED";
export const DISPUTE_ID = /^PP-[A-Z]-[A-Z0-9-]{3,40}$/;
const TRANSACTION_ID = /^[0-9A-Z_]{10,40}$/; // the pattern PayPal documents for disputed_transaction_id

// The statuses that mean the merchant still has something to do or wait for ([Disputes API `status`](https://developer.paypal.com/docs/api/customer-disputes/v1/)).
export const OPEN_STATUSES = ["OPEN", "WAITING_FOR_BUYER_RESPONSE", "WAITING_FOR_SELLER_RESPONSE", "UNDER_REVIEW"] as const;
export type OpenStatus = (typeof OPEN_STATUSES)[number];
export const isOpen = (status: string): status is OpenStatus => (OPEN_STATUSES as readonly string[]).includes(status);
export type OpenDispute = PaypalDispute & { status: OpenStatus };
export const openDisputes = (list: PaypalDispute[]): OpenDispute[] => list.filter((d): d is OpenDispute => isOpen(d.status));

export interface PaypalDispute {
  disputeId: string;
  status: string;
  amount: string; // as PayPal wrote it, e.g. "48.00" (USD: the shop sells in dollars only)
  createdAt: number; // ms
  sellerResponseDueAt: number | null; // ms; PayPal's field. Absent while the dispute is UNDER_REVIEW (measured: it appeared 218 to 221 s after the chargeback call, n=5); in the Sandbox its value comes from the test call that made the dispute
}

// PayPal's dispute shows in the disputes API well before its CREATED event exists: in four Sandbox chargebacks the event was created 166 to
// 192 s after the chargeback call (the API listed the dispute after 39 to 100 s), and PayPal's event list showed it 46 to 173 s after that.
// So "no event found anywhere" may not be claimed 6 minutes after the dispute's own creation time, as it is for a payment: the clock starts
// when the event can first exist.
export const DISPUTE_EVENT_DELAY_MS = 200_000;

export interface AppWebhook {
  id: string;
  types: string[];
}

// A CUSTOMER.DISPUTE.CREATED event as PayPal's event list shows it.
export interface ListedDisputeEvent {
  eid: string;
  disputeId: string;
  createTime: number; // ms
}

export interface DisputeReads {
  /** Every dispute PayPal lists for this capture (open or not). Throws when the read fails or the answer has a next page. */
  disputesOfCapture(captureId: string, timeoutMs: number): Promise<PaypalDispute[]>;
  /** The webhooks of this PayPal app and what each subscribes to. Throws when the read fails. */
  appWebhooks(timeoutMs: number): Promise<AppWebhook[]>;
  /** CUSTOMER.DISPUTE.CREATED events created since `sinceMs`, newest first. Throws when any page cannot be read. */
  listedDisputeEvents(sinceMs: number, timeoutMs: number): Promise<ListedDisputeEvent[]>;
}

const moneyOf = (c: unknown, v: unknown): string | null => (c === "USD" && typeof v === "string" && /^\d{1,9}\.\d{2}$/.test(v) ? v : null);
const timeOf = (v: unknown): number | null => {
  const t = typeof v === "string" ? Date.parse(v) : NaN;
  return Number.isNaN(t) ? null : t;
};

// One entry of PayPal's list, or null when it does not have what a row needs (the id is checked before it can reach a URL or a key).
export function disputeOf(entry: unknown): PaypalDispute | null {
  const e = entry as { dispute_id?: unknown; status?: unknown; create_time?: unknown; seller_response_due_date?: unknown; dispute_amount?: { currency_code?: unknown; value?: unknown } } | null;
  const amount = moneyOf(e?.dispute_amount?.currency_code, e?.dispute_amount?.value);
  const createdAt = timeOf(e?.create_time);
  if (typeof e?.dispute_id !== "string" || !DISPUTE_ID.test(e.dispute_id) || typeof e.status !== "string" || amount === null || createdAt === null) return null;
  return { disputeId: e.dispute_id, status: e.status, amount, createdAt, sellerResponseDueAt: timeOf(e.seller_response_due_date) };
}

// One entry of the event list, or null when it is not a usable CUSTOMER.DISPUTE.CREATED event.
export function listedDisputeOf(entry: unknown): ListedDisputeEvent | null {
  const e = entry as { id?: unknown; event_type?: unknown; create_time?: unknown; resource?: { dispute_id?: unknown } } | null;
  const createTime = timeOf(e?.create_time);
  if (e?.event_type !== DISPUTE_CREATED || typeof e.id !== "string" || !EVENT_ID.test(e.id) || createTime === null) return null;
  const disputeId = e.resource?.dispute_id;
  if (typeof disputeId !== "string" || !DISPUTE_ID.test(disputeId)) return null;
  return { eid: e.id, disputeId, createTime };
}

const SUBSCRIPTION_TTL_MS = 60_000;
const hasNext = (links: unknown): boolean => Array.isArray(links) && (links as { rel?: unknown }[]).some((l) => l?.rel === "next");
const isoSeconds = (ms: number) => new Date(ms).toISOString().replace(/\.\d+Z$/, "Z");

export class PaypalClientDisputeReads implements DisputeReads {
  private webhooks?: { at: number; list: AppWebhook[] };

  constructor(
    private readonly client: PaypalClient,
    private readonly now: () => number = Date.now,
  ) {}

  async disputesOfCapture(captureId: string, timeoutMs: number): Promise<PaypalDispute[]> {
    if (!TRANSACTION_ID.test(captureId)) throw new Error("capture id is malformed");
    // Any failure (a 4xx for a missing scope, a 5xx, a timeout) throws: the scan counts that capture as not read, never as "no dispute".
    const body = await this.client.request<{ items?: unknown[]; links?: unknown }>("list disputes", "GET", `/v1/customer/disputes?disputed_transaction_id=${captureId}`, { timeoutMs });
    if (hasNext(body?.links)) throw new Error("list disputes: the answer has a next page, so a dispute could be missing from it");
    const found: PaypalDispute[] = [];
    for (const entry of body?.items ?? []) {
      const d = disputeOf(entry);
      if (!d) throw new Error("list disputes: an entry has no usable dispute id, status, USD amount or time"); // never skip silently: a skipped dispute would look like "no dispute"
      found.push(d);
    }
    return found;
  }

  // GET /v1/notifications/webhooks: the same list scripts/check-webhooks.ts reads. A webhook subscribed to everything is listed with the single type "*".
  async appWebhooks(timeoutMs: number): Promise<AppWebhook[]> {
    if (this.webhooks && this.now() - this.webhooks.at < SUBSCRIPTION_TTL_MS) return this.webhooks.list;
    const body = await this.client.request<{ webhooks?: { id?: unknown; event_types?: { name?: unknown }[] }[] }>("list webhooks", "GET", "/v1/notifications/webhooks", { timeoutMs });
    const list: AppWebhook[] = [];
    for (const w of body?.webhooks ?? []) {
      if (typeof w?.id !== "string" || !WEBHOOK_ID.test(w.id)) throw new Error("list webhooks: an entry has no usable webhook id");
      list.push({ id: w.id, types: (w.event_types ?? []).map((t) => t.name).filter((n): n is string => typeof n === "string") });
    }
    this.webhooks = { at: this.now(), list };
    return list;
  }

  async listedDisputeEvents(sinceMs: number, timeoutMs: number): Promise<ListedDisputeEvent[]> {
    const found: ListedDisputeEvent[] = [];
    let path: string | null = `/v1/notifications/webhooks-events?page_size=100&start_time=${isoSeconds(sinceMs)}&event_type=${DISPUTE_CREATED}`;
    for (let page = 0; path; page++) {
      if (page >= MAX_PAGES) throw new Error(`the event list for ${DISPUTE_CREATED} has more than ${MAX_PAGES} pages`);
      const r: { events?: unknown[]; links?: unknown } = await this.client.request("list webhook events", "GET", path, { timeoutMs });
      for (const entry of r.events ?? []) {
        const listed = listedDisputeOf(entry);
        if (listed) found.push(listed);
      }
      path = nextPagePath(r.links);
    }
    return found;
  }
}

// A read that fails for a reason no retry fixes: the app has no right to the disputes API. The scan stops asking after the first one.
export const isDenied = (e: unknown): boolean => e instanceof PaypalError && (e.status === 401 || e.status === 403);

// What the shop's books say about a dispute. The shop records one when it processes CUSTOMER.DISPUTE.CREATED. The demo shop keeps no dispute
// book, so for it this is always empty; the seam is here so that a shop which does book disputes can be tied.
export interface BookedDispute {
  disputeId: string;
  at: number;
}

export type DisputeRowStatus = "TIED" | "GAP" | "UNVERIFIED";

// Whether the webhooks of this app subscribe to dispute events. null: the list of webhooks could not be read.
export interface DisputeSubscription {
  shop: boolean | null; // the shop's webhook (S) subscribes to CUSTOMER.DISPUTE.CREATED
  any: boolean | null; // at least one webhook of the app does
}

// "not_set_yet": PayPal sends the date only once the dispute waits for the seller. "sandbox_test": in the Sandbox the date is the one the test call that
// made the dispute asked for (probe: we asked for 10-30, PayPal rendered 10-31T03:59:59Z), not a deadline that PayPal's own rules produced.
export type DueDateSource = "not_set_yet" | "sandbox_test";

// What one open dispute looks like on a scan row. Every field is a number, a boolean, a fixed word, a validated id or a validated amount:
// no free text of PayPal's reaches a screen through it.
export interface DisputeView {
  disputeId: string;
  status: DisputeRowStatus;
  paypalStatus: OpenStatus;
  amount: string; // "48.00"
  createdAt: number;
  sellerResponseDueAt: number | null;
  dueDateSource: DueDateSource;
  webhooks: DisputeSubscription;
  eid?: string; // the CREATED event, when PayPal's list has it
  listedAt?: number;
  finding: Finding | null; // null for a TIED dispute
  ring: Ring | null; // null for a TIED dispute
}

export interface DisputeEvidenceIn {
  now: number;
  booked: BookedDispute[];
  webhooks: AppWebhook[] | null; // null: could not be read
  shopWebhookId: string;
  event: ListedDisputeEvent | null | "unread"; // PayPal's list of CREATED events: the event of this dispute, none, or the list was not read
  attempts: AttemptReport[] | null; // the shop's reporter for that event; null = no record
}

const subscribes = (types: string[]): boolean => types.includes(DISPUTE_CREATED) || types.includes("*"); // PayPal lists an all-events webhook as "*"

export function subscriptionOf(webhooks: AppWebhook[] | null, shopWebhookId: string): DisputeSubscription {
  if (!webhooks) return { shop: null, any: null };
  const shop = webhooks.find((w) => w.id === shopWebhookId);
  return { shop: shop ? subscribes(shop.types) : null, any: webhooks.some((w) => subscribes(w.types)) };
}

// Ring again for a dispute. It is never "ready": nothing is sent for a dispute, and the words say why in each case.
export function disputeRing(f: Finding, sub: DisputeSubscription, now: number): Ring {
  if (f.cls === "UNVERIFIED") return { state: "wait", label: "Not provable yet", ...(f.untilMs ? { waitMs: Math.max(0, f.untilMs - now) } : {}) };
  if (f.flag === "UNSUBSCRIBED_EVENT_TYPE") {
    return sub.any === false
      ? { state: "cannot_heal", label: "Nothing to resend: no webhook of this app subscribes to dispute events, so PayPal made no event to send again. Subscribing the shop's webhook to CUSTOMER.DISPUTE.CREATED would tell it about the next dispute." }
      : { state: "cannot_heal", label: "Nothing to resend to the shop: its webhook is not subscribed to dispute events. Subscribing it to CUSTOMER.DISPUTE.CREATED would tell it about the next dispute." };
  }
  if (f.cls === "NO_EVENT_FOUND") return { state: "cannot_heal", label: "Cannot auto-heal: no event found anywhere" };
  return { state: "cannot_heal", label: "Doorbell does not resend dispute events: the demo shop keeps no dispute book, so a resend could not be shown to change anything" };
}

// One open dispute of PayPal's, judged against the shop's books and the evidence of the webhooks.
export function judgeDispute(dispute: OpenDispute, i: DisputeEvidenceIn): DisputeView {
  const webhooks = subscriptionOf(i.webhooks, i.shopWebhookId);
  const eventFound = i.event !== null && i.event !== "unread" ? i.event : null;
  const base = {
    disputeId: dispute.disputeId,
    paypalStatus: dispute.status,
    amount: dispute.amount,
    createdAt: dispute.createdAt,
    sellerResponseDueAt: dispute.sellerResponseDueAt,
    dueDateSource: dispute.sellerResponseDueAt === null ? ("not_set_yet" as const) : ("sandbox_test" as const),
    webhooks,
    ...(eventFound ? { eid: eventFound.eid, listedAt: eventFound.createTime } : {}),
  };
  if (i.booked.some((b) => b.disputeId === dispute.disputeId)) return { ...base, status: "TIED", finding: null, ring: null };

  // The disputes API is the proof that the dispute exists, so a webhook that does not subscribe to the type is a final finding by itself. Measured:
  // with no webhook subscribed to CUSTOMER.DISPUTE.* PayPal listed no dispute event in 8 minutes (n=1), so there may be no event to find.
  // A delivery that did reach the shop outranks the subscription list (a resend, or a subscription changed since).
  const delivered = (i.attempts?.length ?? 0) > 0;
  const finding: Finding =
    webhooks.shop === false && !delivered
      ? { cls: "NO_REPORT", flag: "UNSUBSCRIBED_EVENT_TYPE", final: true, why: "PayPal lists this dispute as open and the shop's webhook is not subscribed to CUSTOMER.DISPUTE.CREATED, so the shop was never going to be told." }
      : classify({
          kind: "dispute",
          now: i.now,
          actionAt: dispute.createdAt + DISPUTE_EVENT_DELAY_MS,
          eid: eventFound?.eid ?? null,
          d: null,
          listed: eventFound ? { createTime: eventFound.createTime } : null,
          listingRead: i.event !== "unread",
          attempts: i.attempts,
          sNoted: false,
          subscribed: webhooks.shop ?? undefined,
          books: null,
        });
  return { ...base, status: finding.cls === "UNVERIFIED" ? "UNVERIFIED" : "GAP", finding, ring: disputeRing(finding, webhooks, i.now) };
}
