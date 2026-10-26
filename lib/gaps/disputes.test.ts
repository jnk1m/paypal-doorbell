// The dispute gap: PayPal lists an open dispute on a capture and the shop's books have none. PayPal is a stand-in here; the entries are the
// shapes measured on 2026-10-20 (docs/measurements/disputes-probe-2026-10-20.json).
import { test } from "node:test";
import assert from "node:assert/strict";
import { PaypalClient, PaypalError } from "../pay/paypal.ts";
import { ABSENCE_WINDOW_MS, BOOKS_SETTLE_MS } from "./classify.ts";
import {
  DISPUTE_CREATED,
  DISPUTE_EVENT_DELAY_MS,
  disputeOf,
  disputeRing,
  isDenied,
  judgeDispute,
  listedDisputeOf,
  openDisputes,
  PaypalClientDisputeReads,
  subscriptionOf,
  type AppWebhook,
  type DisputeEvidenceIn,
  type ListedDisputeEvent,
  type OpenDispute,
  type PaypalDispute,
} from "./disputes.ts";

const NOW = 1_800_000_000_000;
const CAPTURE = "46E84226B1829180C";
const DISPUTE_ID = "PP-R-WOI-10193701";
const SHOP = "SHOPWEBHOOK0000001";

// The list entry as PayPal sent it 39 s after the chargeback: OPEN, under review, no due date yet. The one after the status moved has the due date.
const openEntry = { dispute_id: DISPUTE_ID, create_time: "2026-10-20T08:17:39.000Z", update_time: "2026-10-20T08:18:13.000Z", status: "OPEN", dispute_state: "UNDER_PAYPAL_REVIEW", dispute_amount: { currency_code: "USD", value: "48.00" } };
const waitingEntry = { ...openEntry, status: "WAITING_FOR_SELLER_RESPONSE", dispute_state: "REQUIRED_ACTION", seller_response_due_date: "2026-10-31T03:59:59.000Z" };

const dispute = (over: Partial<OpenDispute> = {}): OpenDispute => ({ disputeId: DISPUTE_ID, status: "WAITING_FOR_SELLER_RESPONSE", amount: "48.00", createdAt: NOW - 20 * 60_000, sellerResponseDueAt: Date.parse("2026-10-31T03:59:59.000Z"), ...over });

// A client whose HTTP layer is a script: it records every request and answers from `answer`.
function scripted(answer: (path: string) => unknown) {
  const asked: { method: string; path: string; body?: unknown; timeoutMs?: number }[] = [];
  const client = Object.create(PaypalClient.prototype) as PaypalClient;
  client.request = (async (_step: string, method: string, path: string, opts: { body?: unknown; timeoutMs?: number } = {}) => {
    asked.push({ method, path, body: opts.body, timeoutMs: opts.timeoutMs });
    const a = answer(path);
    if (a instanceof Error) throw a;
    return a;
  }) as PaypalClient["request"];
  return { client, asked };
}

test("disputeOf: the measured list entries parse, the due date is null until PayPal sends one, and a malformed entry is dropped", () => {
  assert.deepEqual(disputeOf(openEntry), { disputeId: DISPUTE_ID, status: "OPEN", amount: "48.00", createdAt: Date.parse("2026-10-20T08:17:39.000Z"), sellerResponseDueAt: null });
  assert.equal(disputeOf(waitingEntry)?.sellerResponseDueAt, Date.parse("2026-10-31T03:59:59.000Z"));
  assert.equal(disputeOf({ ...openEntry, dispute_id: "../../v1/oauth2/token" }), null, "an id that is not a dispute id never reaches a URL or a key");
  assert.equal(disputeOf({ ...openEntry, dispute_amount: { currency_code: "USD", value: "48" } }), null);
  assert.equal(disputeOf({ ...openEntry, dispute_amount: { currency_code: "EUR", value: "48.00" } }), null, "the shop sells in dollars: a euro amount is never shown as dollars");
  assert.equal(disputeOf({ ...openEntry, create_time: "yesterday" }), null);
  assert.equal(disputeOf(null), null);
});

test("listedDisputeOf: only a CUSTOMER.DISPUTE.CREATED event with an event id, a time and a dispute id", () => {
  const e = { id: "WH-4NY37331K6294023J-5X2155257W973735X", event_type: DISPUTE_CREATED, create_time: "2026-10-20T08:20:51.000Z", resource: { dispute_id: DISPUTE_ID } };
  assert.deepEqual(listedDisputeOf(e), { eid: e.id, disputeId: DISPUTE_ID, createTime: Date.parse("2026-10-20T08:20:51.000Z") });
  assert.equal(listedDisputeOf({ ...e, event_type: "CUSTOMER.DISPUTE.UPDATED" }), null);
  assert.equal(listedDisputeOf({ ...e, id: "../../x" }), null);
  assert.equal(listedDisputeOf({ ...e, resource: { dispute_id: "nope" } }), null);
  assert.equal(listedDisputeOf({ ...e, create_time: "soon" }), null);
  assert.equal(listedDisputeOf(null), null);
});

test("openDisputes keeps the four open statuses and drops the rest", () => {
  const mk = (status: string): PaypalDispute => ({ ...dispute(), status });
  assert.deepEqual(openDisputes(["OPEN", "UNDER_REVIEW", "WAITING_FOR_BUYER_RESPONSE", "WAITING_FOR_SELLER_RESPONSE", "RESOLVED", "OTHER"].map(mk)).map((d) => d.status), ["OPEN", "UNDER_REVIEW", "WAITING_FOR_BUYER_RESPONSE", "WAITING_FOR_SELLER_RESPONSE"]);
});

test("the dispute read asks PayPal by capture id with a GET and nothing else, and checks the id first", async () => {
  const { client, asked } = scripted(() => ({ items: [openEntry] }));
  const reads = new PaypalClientDisputeReads(client);
  assert.deepEqual(await reads.disputesOfCapture(CAPTURE, 1000), [disputeOf(openEntry)]);
  assert.deepEqual(asked, [{ method: "GET", path: `/v1/customer/disputes?disputed_transaction_id=${CAPTURE}`, body: undefined, timeoutMs: 1000 }]);
  await assert.rejects(reads.disputesOfCapture("46E8/../v1", 1000), /malformed/);
  await assert.rejects(reads.disputesOfCapture("46e84226b1829180c", 1000), /malformed/, "PayPal documents the id as upper case only");
  assert.equal(asked.length, 1, "a bad id never reaches PayPal");
});

test("a capture with no dispute reads as an empty list; a failed read, an unparseable entry and a next page all throw (none may look like 'no dispute')", async () => {
  const read = (answer: unknown) => new PaypalClientDisputeReads(scripted(() => answer).client).disputesOfCapture(CAPTURE, 1000);
  assert.deepEqual(await read({ items: [] }), []);
  assert.deepEqual(await read({}), []);
  await assert.rejects(read(new PaypalError("list disputes", 403, "dbg", undefined)), /403/);
  await assert.rejects(read({ items: [{ ...openEntry, dispute_id: "nope" }] }), /no usable dispute id/);
  await assert.rejects(read({ items: [openEntry], links: [{ rel: "next", href: "https://api-m.sandbox.paypal.com/v1/customer/disputes?page=2" }] }), /next page/);
  assert.deepEqual(await read({ items: [openEntry], links: [{ rel: "self", href: "x" }] }), [disputeOf(openEntry)], "links that are not 'next' are fine");
});

test("isDenied is true for a 401 or 403 from PayPal and for nothing else", () => {
  assert.equal(isDenied(new PaypalError("list disputes", 403, "dbg", undefined)), true);
  assert.equal(isDenied(new PaypalError("list disputes", 401, "dbg", undefined)), true);
  assert.equal(isDenied(new PaypalError("list disputes", 503, "dbg", undefined)), false);
  assert.equal(isDenied(new Error("timeout")), false);
});

test("the webhook list gives each webhook's id and types, drops a name that is not a string, is asked once a minute, and refuses an entry without a usable id", async () => {
  let t = 0;
  const answer = { webhooks: [{ id: SHOP, url: "https://example.test/a", event_types: [{ name: "PAYMENT.CAPTURE.COMPLETED" }, { name: 7 }] }, { id: "WITNESSHOOK000001", event_types: [{ name: "*", description: "ALL" }] }] };
  const { client, asked } = scripted(() => answer);
  const reads = new PaypalClientDisputeReads(client, () => t);
  assert.deepEqual(await reads.appWebhooks(1000), [{ id: SHOP, types: ["PAYMENT.CAPTURE.COMPLETED"] }, { id: "WITNESSHOOK000001", types: ["*"] }]);
  assert.deepEqual(asked[0], { method: "GET", path: "/v1/notifications/webhooks", body: undefined, timeoutMs: 1000 });
  t = 59_000;
  await reads.appWebhooks(1000);
  assert.equal(asked.length, 1, "the second answer came from the cache");
  t = 61_000;
  await reads.appWebhooks(1000);
  assert.equal(asked.length, 2);
  await assert.rejects(new PaypalClientDisputeReads(scripted(() => ({ webhooks: [{ id: "../x", event_types: [] }] })).client).appWebhooks(1000), /no usable webhook id/);
});

test("the CREATED events are asked for with the type filter from a start time, pages are followed on our own base, and an unreadable page fails the whole list", async () => {
  const e = (id: string) => ({ id, event_type: DISPUTE_CREATED, create_time: "2026-10-20T08:20:51.000Z", resource: { dispute_id: DISPUTE_ID } });
  const page1 = { events: [e("WH-AAAAAAAAAA-BBBBBBBBBB"), { id: "junk" }], links: [{ rel: "next", href: "https://api.sandbox.paypal.com/v1/notifications/webhooks-events/?page=2" }] };
  const page2 = { events: [e("WH-CCCCCCCCCC-DDDDDDDDDD")], links: [] };
  const { client, asked } = scripted((path) => (path.startsWith("/v1/notifications/webhooks-events/?page=2") ? page2 : page1));
  const found = await new PaypalClientDisputeReads(client).listedDisputeEvents(Date.parse("2026-10-20T08:00:00.789Z"), 5000);
  assert.deepEqual(found.map((x) => x.eid), ["WH-AAAAAAAAAA-BBBBBBBBBB", "WH-CCCCCCCCCC-DDDDDDDDDD"]);
  assert.equal(asked[0].path, "/v1/notifications/webhooks-events?page_size=100&start_time=2026-10-20T08:00:00Z&event_type=CUSTOMER.DISPUTE.CREATED");
  assert.ok(asked.every((a) => a.method === "GET" && a.timeoutMs === 5000));
  const broken = scripted((path) => (path.includes("page=2") ? new PaypalError("list", 503, "dbg", undefined) : page1));
  await assert.rejects(new PaypalClientDisputeReads(broken.client).listedDisputeEvents(NOW, 1000), /HTTP 503/);
  const endless = scripted(() => ({ events: [], links: [{ rel: "next", href: "https://api.sandbox.paypal.com/v1/notifications/webhooks-events/?page=n" }] }));
  await assert.rejects(new PaypalClientDisputeReads(endless.client).listedDisputeEvents(NOW, 1000), /more than 5 pages/);
});

// ---- the subscription ----
const hooks = (shop: string[], witness: string[] = ["PAYMENT.CAPTURE.COMPLETED"]): AppWebhook[] => [
  { id: SHOP, types: shop },
  { id: "WITNESSHOOK000001", types: witness },
];

test("subscriptionOf: the shop's webhook and any webhook of the app, with '*' counting as a subscription and an unreadable list as null", () => {
  assert.deepEqual(subscriptionOf(hooks(["PAYMENT.CAPTURE.COMPLETED"]), SHOP), { shop: false, any: false });
  assert.deepEqual(subscriptionOf(hooks(["PAYMENT.CAPTURE.COMPLETED"], [DISPUTE_CREATED]), SHOP), { shop: false, any: true });
  assert.deepEqual(subscriptionOf(hooks([DISPUTE_CREATED, "PAYMENT.CAPTURE.COMPLETED"]), SHOP), { shop: true, any: true });
  assert.deepEqual(subscriptionOf(hooks(["*"]), SHOP), { shop: true, any: true });
  assert.deepEqual(subscriptionOf(hooks(["CUSTOMER.DISPUTE.UPDATED"]), SHOP), { shop: false, any: false }, "UPDATED is not CREATED");
  assert.deepEqual(subscriptionOf(null, SHOP), { shop: null, any: null });
  assert.deepEqual(subscriptionOf(hooks([]), "SOMEOTHERHOOK00001"), { shop: null, any: false }, "the shop's webhook is not on the app at all: unknown, not 'not subscribed'");
});

// ---- the verdict ----
const event: ListedDisputeEvent = { eid: "WH-4NY37331K6294023J-5X2155257W973735X", disputeId: DISPUTE_ID, createTime: NOW - 10 * 60_000 };
const evidence = (over: Partial<DisputeEvidenceIn> = {}): DisputeEvidenceIn => ({ now: NOW, booked: [], webhooks: hooks([DISPUTE_CREATED]), shopWebhookId: SHOP, event, attempts: null, ...over });
const ack = { tid: "t1", attempt: "a1", state: "responded" as const, status: 200, receivedAt: NOW - 5 * 60_000, respondedAt: NOW - 5 * 60_000 + 300 };

test("no webhook of the app subscribes to dispute events: NO_REPORT + UNSUBSCRIBED_EVENT_TYPE, final at once, even 30 s after the dispute and with no event anywhere; the ring says nothing was made to resend", () => {
  const v = judgeDispute(dispute({ createdAt: NOW - 30_000 }), evidence({ webhooks: hooks(["PAYMENT.CAPTURE.COMPLETED"]), event: null }));
  assert.deepEqual([v.status, v.finding?.cls, v.finding?.flag, v.finding?.final], ["GAP", "NO_REPORT", "UNSUBSCRIBED_EVENT_TYPE", true]);
  assert.deepEqual(v.webhooks, { shop: false, any: false });
  assert.equal(v.ring?.state, "cannot_heal");
  assert.match(v.ring!.label, /Nothing to resend: no webhook of this app subscribes to dispute events/);
  assert.match(v.ring!.label, /CUSTOMER\.DISPUTE\.CREATED/, "the owner's action is named");
});

test("another webhook of the app subscribes and the shop's does not: the same finding, and the ring names the shop's webhook, not the app", () => {
  const v = judgeDispute(dispute(), evidence({ webhooks: hooks(["PAYMENT.CAPTURE.COMPLETED"], [DISPUTE_CREATED]), event }));
  assert.deepEqual([v.status, v.finding?.flag, v.webhooks], ["GAP", "UNSUBSCRIBED_EVENT_TYPE", { shop: false, any: true }]);
  assert.match(v.ring!.label, /Nothing to resend to the shop: its webhook is not subscribed/);
  assert.doesNotMatch(v.ring!.label, /no webhook of this app/);
});

test("the facts the screen needs ride on the view: id, amount, PayPal's status, the due date and where it comes from, the creation time", () => {
  const v = judgeDispute(dispute(), evidence({ webhooks: hooks(["PAYMENT.CAPTURE.COMPLETED"]) }));
  assert.deepEqual([v.disputeId, v.amount, v.paypalStatus, v.createdAt, v.sellerResponseDueAt, v.dueDateSource], [DISPUTE_ID, "48.00", "WAITING_FOR_SELLER_RESPONSE", NOW - 20 * 60_000, Date.parse("2026-10-31T03:59:59.000Z"), "sandbox_test"]);
  const early = judgeDispute(dispute({ status: "UNDER_REVIEW", sellerResponseDueAt: null }), evidence({ webhooks: hooks([]) }));
  assert.deepEqual([early.sellerResponseDueAt, early.dueDateSource, early.paypalStatus], [null, "not_set_yet", "UNDER_REVIEW"], "PayPal sends the date about 220 s after the call: before that it is 'not set yet', never a made-up date");
});

test("a dispute the shop booked is TIED, has no finding and no ring", () => {
  const v = judgeDispute(dispute(), evidence({ booked: [{ disputeId: DISPUTE_ID, at: NOW - 5 * 60_000 }] }));
  assert.deepEqual([v.status, v.finding, v.ring], ["TIED", null, null]);
});

test("a booking of some other dispute does not tie this one", () => {
  assert.equal(judgeDispute(dispute(), evidence({ booked: [{ disputeId: "PP-R-XXX-00000001", at: NOW - 5 * 60_000 }] })).status, "GAP");
});

test("the shop's webhook subscribes and PayPal's list has the event for over 6 minutes, never reported: NO_REPORT (no flag), final; the ring does not offer a resend", () => {
  const v = judgeDispute(dispute(), evidence());
  assert.deepEqual([v.status, v.finding?.cls, v.finding?.flag, v.finding?.final, v.eid, v.listedAt], ["GAP", "NO_REPORT", undefined, true, event.eid, event.createTime]);
  assert.equal(v.ring?.state, "cannot_heal");
  assert.match(v.ring!.label, /Doorbell does not resend dispute events/);
});

test("the same dispute inside the 6-minute window is UNVERIFIED, not a gap: an absence claim waits", () => {
  const v = judgeDispute(dispute(), evidence({ event: { ...event, createTime: NOW - (ABSENCE_WINDOW_MS - 60_000) } }));
  assert.deepEqual([v.status, v.finding?.cls, v.finding?.waiting, v.ring?.state], ["UNVERIFIED", "UNVERIFIED", "absence_window", "wait"]);
  assert.equal(v.ring?.waitMs, 60_000);
});

test("no event anywhere while the shop's webhook subscribes: the 6-minute window starts when the dispute's event can first exist, not when the dispute was created", () => {
  const none = (ageMs: number) => judgeDispute(dispute({ createdAt: NOW - ageMs }), evidence({ event: null }));
  const early = none(ABSENCE_WINDOW_MS + 30_000);
  assert.deepEqual([early.status, early.finding?.cls, early.finding?.waiting], ["UNVERIFIED", "UNVERIFIED", "absence_window"], "6.5 minutes after creation is still inside the window for a dispute");
  const late = none(ABSENCE_WINDOW_MS + DISPUTE_EVENT_DELAY_MS + 1_000);
  assert.deepEqual([late.status, late.finding?.cls, late.finding?.final, late.ring?.state], ["GAP", "NO_EVENT_FOUND", true, "cannot_heal"]);
});

test("PayPal's event list could not be read and the shop's webhook subscribes (or is unknown): UNVERIFIED, listing_unavailable, never a claim of absence", () => {
  const v = judgeDispute(dispute(), evidence({ event: "unread" }));
  assert.deepEqual([v.status, v.finding?.waiting, v.eid], ["UNVERIFIED", "listing_unavailable", undefined]);
  const unknown = judgeDispute(dispute(), evidence({ webhooks: null, event: "unread" }));
  assert.deepEqual([unknown.status, unknown.finding?.waiting, unknown.webhooks], ["UNVERIFIED", "listing_unavailable", { shop: null, any: null }]);
});

test("the list of webhooks could not be read but the event list could: the event decides, and no 'unsubscribed' is claimed", () => {
  const listed = judgeDispute(dispute(), evidence({ webhooks: null }));
  assert.deepEqual([listed.finding?.cls, listed.finding?.flag], ["NO_REPORT", undefined]);
});

test("the shop answered 2xx to the dispute event and booked nothing: ACKED_BUT_NOT_APPLIED, the same class as a dropped refund; the books get 10 s", () => {
  const v = judgeDispute(dispute(), evidence({ attempts: [ack] }));
  assert.deepEqual([v.status, v.finding?.cls, v.finding?.final], ["GAP", "ACKED_BUT_NOT_APPLIED", true]);
  const justNow = judgeDispute(dispute(), evidence({ attempts: [{ ...ack, respondedAt: NOW - BOOKS_SETTLE_MS + 1000 }] }));
  assert.deepEqual([justNow.status, justNow.finding?.waiting], ["UNVERIFIED", "settling"]);
});

test("a delivery that did reach the shop outranks the subscription list", () => {
  const v = judgeDispute(dispute(), evidence({ webhooks: hooks(["PAYMENT.CAPTURE.COMPLETED"]), attempts: [ack] }));
  assert.equal(v.finding?.cls, "ACKED_BUT_NOT_APPLIED");
  const rejected = judgeDispute(dispute(), evidence({ attempts: [{ ...ack, status: 401 }] }));
  assert.equal(rejected.finding?.cls, "HANDLER_REJECTING");
});

test("disputeRing: waiting says how long, and no finding ever makes the ring 'ready'", () => {
  const sub = { shop: true, any: true };
  assert.deepEqual(disputeRing({ cls: "UNVERIFIED", final: false, why: "x", waiting: "absence_window", untilMs: NOW + 90_000 }, sub, NOW), { state: "wait", label: "Not provable yet", waitMs: 90_000 });
  for (const f of [
    { cls: "NO_REPORT", final: true, why: "x" },
    { cls: "NO_REPORT", flag: "UNSUBSCRIBED_EVENT_TYPE", final: true, why: "x" },
    { cls: "NO_EVENT_FOUND", final: true, why: "x" },
    { cls: "ACKED_BUT_NOT_APPLIED", final: true, why: "x" },
    { cls: "HANDLER_REJECTING", flag: "CRASHED", final: true, why: "x" },
  ] as const) {
    for (const s of [sub, { shop: false, any: false }, { shop: false, any: true }, { shop: null, any: null }]) assert.equal(disputeRing(f, s, NOW).state, "cannot_heal", `${f.cls} ${f.flag ?? ""}`);
  }
});
