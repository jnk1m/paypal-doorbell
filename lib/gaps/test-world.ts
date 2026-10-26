// A stand-in world for the gap finder's tests: the shop's store (in memory), the reporter, and a PayPal that answers re-queries, lists
// events, accepts resends and can be told to fail. Time is a variable the test moves.
import { PaypalError } from "../pay/paypal.ts";
import { COMPLETED, REFUNDED } from "../shop/events.ts";
import { InProcessReporter } from "../shop/reporter.ts";
import { MemoryShopStore } from "../shop/store.ts";
import type { BookEntry, Mode } from "../shop/types.ts";
import { type AppWebhook, type DisputeReads, type ListedDisputeEvent, type PaypalDispute } from "./disputes.ts";
import type { ListedEvent, PaypalReads } from "./reads.ts";
import type { ScanDeps } from "./scan.ts";

export const SHOP_WEBHOOK = "SHOPWEBHOOK0000001";
export const WITNESS_WEBHOOK = "WITNESSHOOK000001";
let counter = 0;
const uniq = (prefix: string) => `${prefix}${(++counter).toString().padStart(10, "0")}`;

export function gapWorld(opts: { delayMs?: number } = {}) {
  const clock = { now: 1_800_000_000_000 };
  const store = new MemoryShopStore(() => clock.now);
  const reporter = new InProcessReporter(store, () => clock.now);
  const paypal = {
    captures: new Map<string, string>(), // capture id -> PayPal status
    refunds: new Map<string, string>(),
    listed: [] as ListedEvent[],
    subscribed: [COMPLETED, REFUNDED] as string[],
    resends: [] as { eid: string; webhookId: string }[],
    failing: new Set<string>(), // ids whose every read fails
    failFirst: new Set<string>(), // ids whose first read fails
    seenOnce: new Set<string>(),
    listFails: false,
    resendError: undefined as PaypalError | undefined,
    calls: { capture: 0, refund: 0, list: 0, subscription: 0 },
    inFlight: 0,
    maxInFlight: 0,
    hang: new Set<string>(), // ids whose read never answers
    // ---- disputes (a scan looks for them only when deps({ disputes: { reads: w.disputeReads } }) says so) ----
    disputes: new Map<string, PaypalDispute[]>(), // capture id -> the disputes PayPal lists for it
    disputeFailing: new Set<string>(), // capture ids whose dispute list cannot be read (503)
    disputesDenied: false, // the app has no right to the disputes API: every read is a 403
    disputeHang: new Set<string>(),
    webhooks: [
      { id: SHOP_WEBHOOK, types: [COMPLETED, REFUNDED] }, // the shop (S)
      { id: WITNESS_WEBHOOK, types: [COMPLETED, REFUNDED, "PAYMENT.CAPTURE.PENDING", "PAYMENT.CAPTURE.REVERSED"] }, // the witness (D): no dispute type, like the demo app's
    ] as AppWebhook[],
    webhooksFail: false,
    disputeEvents: [] as ListedDisputeEvent[], // CUSTOMER.DISPUTE.CREATED events in PayPal's list
    disputeEventsFail: false,
    disputeCalls: { disputes: 0, webhooks: 0, events: 0 },
  };
  const pause = async () => {
    paypal.inFlight++;
    paypal.maxInFlight = Math.max(paypal.maxInFlight, paypal.inFlight);
    try {
      if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
    } finally {
      paypal.inFlight--;
    }
  };
  const readOf = async (what: "capture" | "refund", map: Map<string, string>, id: string) => {
    paypal.calls[what]++;
    if (paypal.hang.has(id)) await new Promise(() => undefined);
    await pause();
    if (paypal.failing.has(id)) throw new PaypalError(`get ${what}`, 503, "dbg", undefined);
    if (paypal.failFirst.has(id) && !paypal.seenOnce.has(id)) {
      paypal.seenOnce.add(id);
      throw new PaypalError(`get ${what}`, 503, "dbg", undefined);
    }
    const status = map.get(id);
    if (!status) throw new PaypalError(`get ${what}`, 404, "dbg", undefined);
    return { status };
  };
  const reads: PaypalReads = {
    capture: (id) => readOf("capture", paypal.captures, id),
    refund: (id) => readOf("refund", paypal.refunds, id),
    async listedEvents() {
      paypal.calls.list++;
      await pause();
      if (paypal.listFails) throw new PaypalError("list webhook events", 503, "dbg", undefined);
      return [...paypal.listed];
    },
    async subscribedTypes() {
      paypal.calls.subscription++;
      return [...paypal.subscribed];
    },
    async resend(eventId, webhookId) {
      if (paypal.resendError) throw paypal.resendError;
      paypal.resends.push({ eid: eventId, webhookId });
    },
  };
  const disputeReads: DisputeReads = {
    async disputesOfCapture(captureId) {
      paypal.disputeCalls.disputes++;
      if (paypal.disputeHang.has(captureId)) await new Promise(() => undefined);
      await pause();
      if (paypal.disputesDenied) throw new PaypalError("list disputes", 403, "dbg", { name: "NOT_AUTHORIZED" });
      if (paypal.disputeFailing.has(captureId)) throw new PaypalError("list disputes", 503, "dbg", undefined);
      return [...(paypal.disputes.get(captureId) ?? [])];
    },
    async appWebhooks() {
      paypal.disputeCalls.webhooks++;
      if (paypal.webhooksFail) throw new PaypalError("list webhooks", 503, "dbg", undefined);
      return paypal.webhooks.map((w) => ({ ...w, types: [...w.types] }));
    },
    async listedDisputeEvents() {
      paypal.disputeCalls.events++;
      if (paypal.disputeEventsFail) throw new PaypalError("list webhook events", 503, "dbg", undefined);
      return [...paypal.disputeEvents];
    },
  };
  const logs: Record<string, unknown>[] = [];
  const deps = (over: Partial<ScanDeps> = {}): ScanDeps => ({ store, reads, shopWebhookId: SHOP_WEBHOOK, now: () => clock.now, log: (l) => void logs.push(l), ...over });

  async function session(mode: Mode = "good") {
    const sid = uniq("s").padEnd(32, "0");
    await store.createSession(sid, mode, clock.now);
    return sid;
  }

  // An order: made now, PayPal says COMPLETED. With refund: refunded `refundAfterMs` later and PayPal says REFUNDED.
  async function order(sid: string, o: { refund?: boolean; book?: "paid" | "refunded" | null; eventsListed?: boolean } = {}) {
    const n = (await store.orders(sid)).length + 1;
    const captureId = uniq("CAPTURE");
    const refundId = uniq("REFUND");
    const at = clock.now;
    const record = { n, item: "gift-set", amount: "48.00", orderId: uniq("ORDER"), captureId, invoiceId: `MM-${n}`, at, ...(o.refund ? { refund: { id: refundId, invoiceId: `MM-${n}-R`, at: at + 1000 } } : {}) };
    await store.putOrder(sid, record);
    paypal.captures.set(captureId, o.refund ? "REFUNDED" : "COMPLETED");
    if (o.refund) paypal.refunds.set(refundId, "COMPLETED");
    const paidEid = uniq("WH-PAID-");
    const refundEid = uniq("WH-REFUND-");
    if (o.eventsListed) {
      paypal.listed.push({ eid: paidEid, type: COMPLETED, createTime: at + 5000, resourceId: captureId, captureId });
      if (o.refund) paypal.listed.push({ eid: refundEid, type: REFUNDED, createTime: at + 6000, resourceId: refundId, captureId });
    }
    if (o.book) await store.setBook(sid, captureId, { state: o.book, amount: "48.00", eid: o.book === "paid" ? paidEid : refundEid, at: at + 3000 });
    return { captureId, refundId, paidEid, refundEid, at, refundAt: at + 1000 };
  }

  // The shop S received an event and answered (a reporter record, and the "received" note the webhook wrapper writes).
  async function deliver(e: { eid: string; tid: string; type: string; resourceId: string; status?: number; crash?: boolean; at?: number }) {
    const t = e.at ?? clock.now;
    const saved = clock.now;
    clock.now = t;
    const attempt = await reporter.received(e.tid, e.eid);
    await store.noteReceived({ resourceId: e.resourceId, type: e.type }, e.eid);
    if (!e.crash) {
      clock.now = t + 300;
      await reporter.responded(e.tid, e.status ?? 200, attempt);
    }
    clock.now = saved;
  }
  // PayPal lists an open dispute on a capture, `ageMs` old. With `pending`, PayPal's status of the capture is PENDING too (the chargeback does that about 3 minutes later).
  let disputeCounter = 0;
  function dispute(captureId: string, o: { ageMs?: number; status?: string; amount?: string; due?: boolean; pending?: boolean } = {}): PaypalDispute {
    const d: PaypalDispute = {
      disputeId: `PP-R-WOI-${(10_193_701 + ++disputeCounter).toString()}`,
      status: o.status ?? "UNDER_REVIEW",
      amount: o.amount ?? "48.00",
      createdAt: clock.now - (o.ageMs ?? 60_000),
      sellerResponseDueAt: o.due ? Date.parse("2026-10-31T03:59:59.000Z") : null,
    };
    paypal.disputes.set(captureId, [...(paypal.disputes.get(captureId) ?? []), d]);
    if (o.pending) paypal.captures.set(captureId, "PENDING");
    return d;
  }
  const heard = (e: { eid: string; tid: string; type: string; resourceId: string; at?: number }) => store.noteHeard({ resourceId: e.resourceId, type: e.type }, { eid: e.eid, tid: e.tid, at: e.at ?? clock.now, slot: "D" });
  const book = (sid: string, captureId: string, b: BookEntry) => store.setBook(sid, captureId, b);

  return { store, clock, paypal, reads, disputeReads, deps, logs, session, order, deliver, heard, book, dispute, uniq };
}
