// Phase-1 probe for "the dispute your shop never heard" (Track B). DEV Sandbox app only: appClient("dev") is the only client built here,
// and the demo app's webhooks D, S and U are never read or written by this script (run scripts/check-webhooks.ts before and after).
// Raw results go to docs/measurements/disputes-probe-<date>.json (emails, names, payer and merchant ids are replaced by "<redacted>").
//   npx tsx scripts/disputes-probe.ts setup      (a) event types + a `*` webhook, then adds the dispute types to the dev witness webhook
//   npx tsx scripts/disputes-probe.ts order      makes a card order + capture, waits for the witness and the event list, runs (b)
//   npx tsx scripts/disputes-probe.ts dispute    (c) process-chargeback on that capture and watches events, the witness and the disputes API
//   npx tsx scripts/disputes-probe.ts resend     (d) resends the dispute event to the dev witness webhook and times the arrival
//   npx tsx scripts/disputes-probe.ts trials [n] n more chargebacks side by side: timings, status changes, due date, resends
//   npx tsx scripts/disputes-probe.ts refund-filter   refund by API, then transaction_id by capture id vs refund id
//   npx tsx scripts/disputes-probe.ts unsub      a chargeback while no webhook subscribes to disputes (run after cleanup + 8 min)
//   npx tsx scripts/disputes-probe.ts refund-target / refund-watch   (e) a capture for the owner to refund in the dashboard, then what arrived
//   npx tsx scripts/disputes-probe.ts cleanup    puts the dev witness webhook's event types back
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PaypalError, SANDBOX_TEST_CARD, type PaypalClient } from "../lib/pay/paypal.ts";
import { redisFromEnv } from "../lib/redis.ts";
import type { AttemptEntry } from "../lib/witness/store.ts";
import { appClient, loadEnv, loadRedisEnv } from "./env.ts";

const DATE = "2026-10-20";
const OUT = new URL(`../docs/measurements/disputes-probe-${DATE}.json`, import.meta.url).pathname;
// Probe state between commands (ids of the order, capture and disputes). Override with DISPUTES_PROBE_STATE.
const STATE = process.env.DISPUTES_PROBE_STATE ?? join(tmpdir(), "doorbell-disputes-probe-state.json");
const DEV_WITNESS_WEBHOOK = "7N5964230U472033D"; // the dev app's witness webhook (slot D-dev of the deployed /api/witness)
const DISPUTE_TYPES = ["CUSTOMER.DISPUTE.CREATED", "CUSTOMER.DISPUTE.UPDATED", "CUSTOMER.DISPUTE.RESOLVED"];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const iso = (ms: number) => new Date(ms).toISOString();
const isoSeconds = (ms: number) => iso(ms).replace(/\.\d+Z$/, "Z");

loadEnv();
loadRedisEnv();
const client: PaypalClient = appClient("dev");

// ---- result and state files ----
type Json = Record<string, unknown>;
const results: Json = existsSync(OUT) ? (JSON.parse(readFileSync(OUT, "utf8")) as Json) : { app: "dev (Default Application)", date: DATE, steps: {} };
const steps = results.steps as Json;
const state: Json = existsSync(STATE) ? (JSON.parse(readFileSync(STATE, "utf8")) as Json) : {};
const REDACT = /^(email_address|email|payer_id|merchant_id|given_name|surname|full_name|name_prefix|phone|business_name|display_name|account_id)$/;
function redact(v: unknown, key = ""): unknown {
  if (Array.isArray(v)) return v.map((x) => redact(x));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, redact(x, k)]));
  if (typeof v === "string" && REDACT.test(key)) return "<redacted>";
  return v;
}
function save(step: string, value: unknown): void {
  // read the file again before writing: several stages can run side by side, and each one must keep the others' records
  const current: Json = existsSync(OUT) ? (JSON.parse(readFileSync(OUT, "utf8")) as Json) : results;
  const cs = (current.steps ?? {}) as Json;
  cs[step] = redact(value);
  current.steps = cs;
  writeFileSync(OUT, `${JSON.stringify(current, null, 2)}\n`);
  steps[step] = cs[step];
}
const saveState = () => writeFileSync(STATE, JSON.stringify(state, null, 2));

// A PayPal call that never throws: the status and the codes are part of the result.
async function call(step: string, method: "GET" | "POST" | "PATCH" | "DELETE", path: string, body?: unknown): Promise<{ ok: boolean; status: number; body: unknown; ms: number }> {
  const t = Date.now();
  try {
    const r = await client.request<unknown>(step, method, path, body === undefined ? {} : { body });
    return { ok: true, status: method === "POST" ? 2 : 200, body: r, ms: Date.now() - t };
  } catch (e) {
    if (e instanceof PaypalError) return { ok: false, status: e.status, body: { codes: e.codes, body: e.body }, ms: Date.now() - t };
    return { ok: false, status: 0, body: { error: (e as Error).message }, ms: Date.now() - t };
  }
}

// ---- the witness's record of what PayPal delivered (read only) ----
const redis = redisFromEnv();
type WitnessRow = { tid: string; type: string; eid: string; at: number; slot: string; big?: boolean; raw?: string };
const keyCache = new Map<string, WitnessRow[]>(); // a key is db:w:att:<transmission id>: one key per delivery, so a key already read does not need reading again
async function witnessRows(sinceMs: number): Promise<WitnessRow[]> {
  if (!redis) throw new Error("KV_REST_API_URL / KV_REST_API_TOKEN are not set (.env.vercel)");
  let cursor: string | number = 0;
  do {
    const [next, keys]: [string, string[]] = await redis.scan(cursor, { match: "db:w:att:*", count: 1000 });
    for (const key of keys) {
      if (keyCache.has(key)) continue;
      const list = (await redis.lrange<string>(key, 0, -1)).map((r) => JSON.parse(String(r)) as AttemptEntry);
      keyCache.set(key, list.map((e) => ({ tid: e.tid, type: e.type, eid: e.eid, at: e.at, slot: e.slot, big: e.big, raw: e.raw })));
    }
    cursor = next;
  } while (String(cursor) !== "0");
  return [...keyCache.values()].flat().filter((r) => r.at >= sinceMs).sort((a, b) => a.at - b.at);
}

async function waitFor<T>(limitMs: number, everyMs: number, f: () => Promise<T | undefined>): Promise<T | undefined> {
  const t0 = Date.now();
  while (Date.now() - t0 < limitMs) {
    const v = await f();
    if (v !== undefined) return v;
    await sleep(everyMs);
  }
  return undefined;
}

interface Webhook {
  id: string;
  url: string;
  event_types: { name: string; description?: string; status?: string }[];
}
const listWebhooks = async () => ((await client.request<{ webhooks?: Webhook[] }>("list webhooks", "GET", "/v1/notifications/webhooks")).webhooks ?? []);

const cmd = process.argv[2];

if (cmd === "setup") {
  const log: Json = { startedAt: iso(Date.now()) };
  const before = await listWebhooks();
  log.devWebhooksBefore = before.map((w) => ({ id: w.id, url: w.url, types: w.event_types.map((t) => t.name).sort() }));
  const witness = before.find((w) => w.id === DEV_WITNESS_WEBHOOK);
  if (!witness) throw new Error(`the dev witness webhook ${DEV_WITNESS_WEBHOOK} is not on the dev app: stop`);
  state.witnessTypesOriginal = witness.event_types.map((t) => t.name);

  // (a1) the list of event types PayPal knows
  const types = await call("list event types", "GET", "/v1/notifications/webhooks-event-types");
  const names = ((types.body as { event_types?: { name: string }[] }).event_types ?? []).map((t) => t.name);
  log.eventTypes = {
    status: types.status,
    count: names.length,
    hasWildcardEntry: names.includes("*"),
    disputeTypes: names.filter((n) => n.startsWith("CUSTOMER.DISPUTE")),
    captureTypes: names.filter((n) => n.startsWith("PAYMENT.CAPTURE")),
    sampleEntryKeys: Object.keys((types.body as { event_types?: object[] }).event_types?.[0] ?? {}),
    names,
  };

  // (a2) a webhook subscribed to `*`: how does PayPal show it back?
  const t1 = Date.now();
  const star = await call("register * webhook", "POST", "/v1/notifications/webhooks", { url: "https://paypal-doorbell.vercel.app/api/probe-wildcard", event_types: [{ name: "*" }] });
  log.wildcardRegistered = { at: iso(t1), status: star.status, ok: star.ok, response: star.body };
  const starId = (star.body as { id?: string })?.id;
  if (star.ok && starId) {
    const got = await call("get * webhook", "GET", `/v1/notifications/webhooks/${starId}`);
    const sub = await call("get * webhook event types", "GET", `/v1/notifications/webhooks/${starId}/event-types`);
    const listed = (await listWebhooks()).find((w) => w.id === starId);
    log.wildcardReadBack = {
      get: got.body,
      subscribedEventTypesEndpoint: sub.body,
      inList: listed ? { id: "<webhook>", types: listed.event_types } : null,
    };
    state.starWebhook = starId;
    saveState();
  }

  // (a3) does PayPal accept a prefix pattern such as PAYMENT.CAPTURE.* ?
  const pattern = await call("register pattern webhook", "POST", "/v1/notifications/webhooks", { url: "https://paypal-doorbell.vercel.app/api/probe-pattern", event_types: [{ name: "PAYMENT.CAPTURE.*" }] });
  log.prefixPatternRegistered = { status: pattern.status, ok: pattern.ok, response: pattern.body };
  const patternId = (pattern.body as { id?: string })?.id;
  if (pattern.ok && patternId) {
    log.prefixPatternReadBack = (await call("get pattern webhook", "GET", `/v1/notifications/webhooks/${patternId}`)).body;
    await call("delete pattern webhook", "DELETE", `/v1/notifications/webhooks/${patternId}`);
  }

  // clean up the `*` webhook now that it has been read
  if (starId) {
    const del = await call("delete * webhook", "DELETE", `/v1/notifications/webhooks/${starId}`);
    log.wildcardDeleted = { at: iso(Date.now()), status: del.ok ? "deleted" : del.status };
  }

  // (c-prep) add the dispute types to the dev witness webhook so the deployed witness hears them
  const tp = Date.now();
  const wanted = [...new Set([...witness.event_types.map((t) => t.name), ...DISPUTE_TYPES])].map((name) => ({ name }));
  const patch = await call("patch dev witness webhook", "PATCH", `/v1/notifications/webhooks/${DEV_WITNESS_WEBHOOK}`, [{ op: "replace", path: "/event_types", value: wanted }]);
  log.devWitnessPatched = { at: iso(tp), status: patch.ok ? "ok" : patch.status, response: patch.ok ? { types: ((patch.body as Webhook).event_types ?? []).map((t) => t.name).sort() } : patch.body };
  const after = await listWebhooks();
  log.devWebhooksAfter = after.map((w) => ({ id: w.id, url: w.url, types: w.event_types.map((t) => t.name).sort() }));
  state.setupDoneAt = Date.now();
  saveState();
  save("a_setup", log);
  console.log(JSON.stringify({ eventTypes: { count: names.length, wildcardEntry: names.includes("*"), dispute: names.filter((n) => n.startsWith("CUSTOMER.DISPUTE")) }, wildcard: log.wildcardRegistered, readBack: log.wildcardReadBack, prefixPattern: log.prefixPatternRegistered, devWitnessPatched: log.devWitnessPatched }, null, 1));
} else if (cmd === "order") {
  const t0 = Date.now();
  const c = SANDBOX_TEST_CARD;
  const created = await client.request<{ id: string; status: string; purchase_units: { payee?: { merchant_id?: string }; payments?: { captures?: { id: string; status: string; seller_receivable_breakdown?: unknown }[] } }[] }>("create order", "POST", "/v2/checkout/orders", {
    prefer: true,
    body: {
      intent: "CAPTURE",
      purchase_units: [{ invoice_id: `DBELL-DISPUTE-${t0}`, amount: { currency_code: "USD", value: "48.00" } }],
      payment_source: { card: { number: c.number, expiry: c.expiry, security_code: c.securityCode, name: c.name } },
    },
  });
  const capture = created.purchase_units[0].payments?.captures?.[0];
  if (!capture) throw new Error(`the order has no capture: status ${created.status}`);
  const merchantId = created.purchase_units[0].payee?.merchant_id;
  Object.assign(state, { orderId: created.id, captureId: capture.id, merchantId, orderAt: t0, amount: "48.00" });
  saveState();
  console.log(`order ${created.id} capture ${capture.id} status ${capture.status}; merchant id present: ${!!merchantId}`);

  // the control: does the dev witness webhook hear the capture (is the blind window over)?
  const heard = await waitFor(180_000, 3000, async () => (await witnessRows(t0)).find((r) => r.type === "PAYMENT.CAPTURE.COMPLETED" && (r.raw ?? "").includes(capture.id)));
  const heardAfterS = heard ? Math.round((heard.at - t0) / 100) / 10 : null;
  console.log(`witness heard COMPLETED: ${heard ? `${heardAfterS} s (slot ${heard.slot})` : "NOT within 180 s"}`);

  // wait for PayPal to list the capture's COMPLETED event (the list lags by about 80 s)
  const start = isoSeconds(t0 - 60_000);
  const listedAt = await waitFor(420_000, 10_000, async () => {
    const r = await client.request<{ events?: { id: string; event_type: string; resource?: { id?: string } }[] }>("list events", "GET", `/v1/notifications/webhooks-events?page_size=100&start_time=${start}&event_type=PAYMENT.CAPTURE.COMPLETED`);
    const e = (r.events ?? []).find((x) => x.resource?.id === capture.id);
    return e ? { eid: e.id, at: Date.now() } : undefined;
  });
  const listedAfterS = listedAt ? Math.round((listedAt.at - t0) / 1000) : null;
  console.log(`event list shows COMPLETED: ${listedAt ? `${listedAfterS} s` : "NOT within 420 s"}`);
  if (listedAt) state.completedEventId = listedAt.eid;
  saveState();

  // (b) the event list filtered by transaction_id vs unfiltered, in the same time window
  const base = `/v1/notifications/webhooks-events?page_size=100&start_time=${start}`;
  const summarize = (body: unknown) => {
    const events = ((body as { events?: { id: string; event_type: string; resource?: { id?: string } }[] }).events ?? []).map((e) => ({ id: e.id, type: e.event_type, resourceId: e.resource?.id }));
    return { count: events.length, events, hasNext: Array.isArray((body as { links?: { rel?: string }[] }).links) && ((body as { links: { rel?: string }[] }).links.some((l) => l.rel === "next")) };
  };
  const unfiltered = await call("list unfiltered", "GET", base);
  const byCapture = await call("list by capture id", "GET", `${base}&transaction_id=${capture.id}`);
  const byOrder = await call("list by order id", "GET", `${base}&transaction_id=${created.id}`);
  const byBogus = await call("list by bogus id", "GET", `${base}&transaction_id=NOTAREALID00000000`);
  const byCaptureNoWindow = await call("list by capture id, no start_time", "GET", `/v1/notifications/webhooks-events?page_size=100&transaction_id=${capture.id}`);
  const wrap = (r: { ok: boolean; status: number; body: unknown }) => (r.ok ? summarize(r.body) : { error: r });
  save("b_transaction_id_filter", {
    at: iso(Date.now()),
    captureId: "<this order's capture>",
    note: "ids are listed so that a reader can see which resource each event is about; capture/order ids are Sandbox ids",
    captureId_value: capture.id,
    orderId_value: created.id,
    unfiltered: wrap(unfiltered),
    byCaptureId: wrap(byCapture),
    byOrderId: wrap(byOrder),
    byBogusId: wrap(byBogus),
    byCaptureId_noStartTime: wrap(byCaptureNoWindow),
  });
  save("order", { orderId: created.id, captureId: capture.id, amount: "48.00", createdAt: iso(t0), witnessHeardCompletedAfterS: heardAfterS, witnessSlot: heard?.slot ?? null, eventListShowedCompletedAfterS: listedAfterS });
  console.log(JSON.stringify({ unfiltered: wrap(unfiltered), byCapture: wrap(byCapture), byOrder: wrap(byOrder), byBogus: wrap(byBogus) }, null, 1));
} else if (cmd === "dispute") {
  const { captureId, merchantId, amount } = state as { captureId?: string; merchantId?: string; amount?: string };
  if (!captureId || !merchantId || !amount) throw new Error("run `order` first (state has no capture id / merchant id)");
  const rnd = (n: number) => Array.from({ length: n }, () => Math.floor(Math.random() * 10)).join("");
  const t0 = Date.now();
  const dueRequested = iso(t0 + 10 * 24 * 3600 * 1000);
  const body = {
    adjacency: "PAYPAL",
    file_layout: "ATCK_CB",
    merchant_id: merchantId,
    financial_institution: { processor: "FDMS" },
    transaction: { id_enc: captureId, amount: { currency_code: "USD", value: amount } },
    instrument: { instrument_type: "CARD", card_brand: "VISA", credit_card_transaction_id: rnd(16), external: false },
    dispute: {
      id: null,
      stage: "CHARGEBACK",
      response_date: dueRequested,
      status: "2",
      amount: { currency_code: "USD", value: amount },
      receive_date: iso(t0),
      event_code: "CHARGEBACK_INITIATED",
      money_movement_date: iso(t0),
      event_type: "DEBIT",
      chargeback_type: "REPORTED_TO_PROCESSOR",
      processor_info: { reference_number: rnd(23), reason_code: "1330", notes: "TEST_MEMO" },
    },
  };
  const cb = await call("process chargeback", "POST", "/v2/customer-support/process-chargeback", body);
  state.chargebackAt = t0;
  state.dueRequested = dueRequested;
  saveState();
  const out: Json = { at: iso(t0), requestedResponseDate: dueRequested, status: cb.status, ok: cb.ok, ms: cb.ms, response: cb.body };
  console.log(`chargeback: HTTP ${cb.ok ? "2xx" : cb.status} in ${cb.ms} ms ${JSON.stringify(redact(cb.body)).slice(0, 300)}`);
  if (!cb.ok) {
    save("c_chargeback", out);
    throw new Error("the chargeback call failed; see the measurements file");
  }
  const responseId = (cb.body as { id?: string; dispute_id?: string })?.dispute_id ?? (cb.body as { id?: string })?.id;

  // (c1) the disputes API: how soon does it show a dispute for this capture?
  const dispFound: Json = {};
  const firstDispute = await waitFor(300_000, 5000, async () => {
    const r = await call("list disputes by transaction", "GET", `/v1/customer/disputes?disputed_transaction_id=${captureId}`);
    (dispFound.polls as unknown[]) = [...((dispFound.polls as unknown[]) ?? []), { afterS: Math.round((Date.now() - t0) / 1000), status: r.ok ? 200 : r.status, items: r.ok ? ((r.body as { items?: unknown[] }).items ?? []).length : undefined, error: r.ok ? undefined : r.body }].slice(-6);
    if (r.ok && ((r.body as { items?: unknown[] }).items ?? []).length) return { at: Date.now(), body: r.body };
    if (!r.ok && r.status !== 404) return { at: Date.now(), body: r.body, failed: true } as never;
    return undefined;
  });
  dispFound.firstSeenAfterS = firstDispute ? Math.round((firstDispute.at - t0) / 1000) : null;
  dispFound.listBody = firstDispute?.body;
  const items = (firstDispute?.body as { items?: { dispute_id?: string }[] } | undefined)?.items ?? [];
  const disputeId = items[0]?.dispute_id ?? responseId;
  state.disputeId = disputeId;
  if (disputeId) {
    const detail = await call("get dispute", "GET", `/v1/customer/disputes/${disputeId}`);
    const d = detail.body as { disputed_transactions?: { seller_transaction_id?: string }[]; seller_response_due_date?: string; status?: string; dispute_state?: string };
    dispFound.detail = detail.ok
      ? {
          keys: Object.keys(d),
          dispute_id_matches_chargeback_response: disputeId === responseId,
          seller_transaction_ids: (d.disputed_transactions ?? []).map((t) => t.seller_transaction_id),
          sellerTransactionIdEqualsCaptureId: (d.disputed_transactions ?? []).some((t) => t.seller_transaction_id === captureId),
          seller_response_due_date: d.seller_response_due_date,
          requestedResponseDate: dueRequested,
          status: d.status,
          dispute_state: d.dispute_state,
          full: d,
        }
      : { status: detail.status, error: detail.body };
  }
  out.disputesApi = dispFound;

  // (c2) PayPal's event list and the witness: CUSTOMER.DISPUTE.* events after the chargeback
  const start = isoSeconds(t0 - 60_000);
  const sawList: Record<string, number> = {};
  const sawWitness: Record<string, { afterS: number; slot: string; big?: boolean }> = {};
  const listedEvents: { id: string; type: string; createTime: string }[] = [];
  await waitFor(540_000, 10_000, async () => {
    const r = await call("list dispute events", "GET", `/v1/notifications/webhooks-events?page_size=100&start_time=${start}`);
    if (r.ok) {
      for (const e of (r.body as { events?: { id: string; event_type: string; create_time: string }[] }).events ?? []) {
        if (e.event_type.startsWith("CUSTOMER.DISPUTE") || e.event_type === "PAYMENT.CAPTURE.REVERSED" || e.event_type === "PAYMENT.CAPTURE.REFUNDED") {
          if (!(e.id in sawList)) {
            sawList[e.id] = Math.round((Date.now() - t0) / 1000);
            listedEvents.push({ id: e.id, type: e.event_type, createTime: e.create_time });
          }
        }
      }
    }
    for (const w of await witnessRows(t0)) if (w.type.startsWith("CUSTOMER.DISPUTE") || w.type === "PAYMENT.CAPTURE.REVERSED") sawWitness[`${w.type} ${w.eid}`] ??= { afterS: Math.round((w.at - t0) / 100) / 10, slot: w.slot, big: w.big };
    const haveCreatedListed = listedEvents.some((e) => e.type === "CUSTOMER.DISPUTE.CREATED");
    const haveCreatedWitness = Object.keys(sawWitness).some((k) => k.startsWith("CUSTOMER.DISPUTE.CREATED"));
    return haveCreatedListed && haveCreatedWitness ? true : undefined;
  });
  const created = listedEvents.find((e) => e.type === "CUSTOMER.DISPUTE.CREATED");
  out.eventList = { events: listedEvents.map((e) => ({ ...e, listedAfterS: sawList[e.id] })), createdListedAfterS: created ? sawList[created.id] : null };
  out.witness = { deliveries: sawWitness };
  if (created) {
    state.disputeEventId = created.id;
    const ev = await call("get dispute event", "GET", `/v1/notifications/webhooks-events/${created.id}`);
    out.disputeCreatedEvent = ev.ok ? ev.body : { status: ev.status, error: ev.body };
    const r = (ev.body as { resource?: { disputed_transactions?: { seller_transaction_id?: string }[]; seller_response_due_date?: string; dispute_id?: string } }).resource;
    out.disputeCreatedResource = {
      resourceKeys: Object.keys(r ?? {}),
      dispute_id_matches: r?.dispute_id === disputeId,
      sellerTransactionIdsInResource: (r?.disputed_transactions ?? []).map((t) => t.seller_transaction_id),
      resourceSellerTransactionIdEqualsCaptureId: (r?.disputed_transactions ?? []).some((t) => t.seller_transaction_id === captureId),
      seller_response_due_date: r?.seller_response_due_date,
      requestedResponseDate: dueRequested,
    };
    // does the transaction_id filter on the event list find the dispute event by capture id?
    const byCapture = await call("list by capture id", "GET", `/v1/notifications/webhooks-events?page_size=100&start_time=${start}&transaction_id=${captureId}`);
    const all = await call("list unfiltered", "GET", `/v1/notifications/webhooks-events?page_size=100&start_time=${start}`);
    const byDispute = disputeId ? await call("list by dispute id", "GET", `/v1/notifications/webhooks-events?page_size=100&start_time=${start}&transaction_id=${disputeId}`) : undefined;
    const brief = (r: { ok: boolean; status: number; body: unknown }) => (r.ok ? ((r.body as { events?: { id: string; event_type: string }[] }).events ?? []).map((e) => ({ id: e.id, type: e.event_type })) : { status: r.status, error: r.body });
    out.eventListFilteredByCaptureAfterDispute = brief(byCapture);
    out.eventListUnfilteredSameWindow = brief(all);
    if (byDispute) out.eventListFilteredByDisputeId = brief(byDispute);
  }
  state.disputeDoneAt = Date.now();
  saveState();
  save("c_chargeback", out);
  console.log(JSON.stringify(redact({ chargeback: { status: out.status }, disputesApi: { firstSeenAfterS: dispFound.firstSeenAfterS, detail: dispFound.detail && { ...(dispFound.detail as Json), full: "(saved)" } }, eventList: out.eventList, witness: out.witness, resource: out.disputeCreatedResource, filtered: out.eventListFilteredByCaptureAfterDispute }), null, 1));
} else if (cmd === "resend") {
  const { disputeEventId } = state as { disputeEventId?: string };
  if (!disputeEventId) throw new Error("no dispute event id in the state: run `dispute` first");
  const out: Json = { eventId: disputeEventId, trials: [] };
  for (let i = 1; i <= 2; i++) {
    const before = await witnessRows(Date.now() - 10 * 60_000);
    const known = new Set(before.filter((r) => r.eid === disputeEventId).map((r) => r.tid));
    const t = Date.now();
    const r = await call("resend dispute event", "POST", `/v1/notifications/webhooks-events/${disputeEventId}/resend`, { webhook_ids: [DEV_WITNESS_WEBHOOK] });
    const arrived = r.ok ? await waitFor(90_000, 2000, async () => (await witnessRows(t - 1000)).find((x) => x.eid === disputeEventId && !known.has(x.tid))) : undefined;
    (out.trials as unknown[]).push({ n: i, at: iso(t), http: r.ok ? "2xx" : r.status, response: r.ok ? undefined : r.body, arrivedAfterS: arrived ? Math.round((arrived.at - t) / 100) / 10 : null, newTransmissionId: arrived ? !known.has(arrived.tid) : null });
    console.log(JSON.stringify((out.trials as unknown[]).at(-1)));
    await sleep(3000);
  }
  save("d_resend", out);
} else if (cmd === "trials") {
  // More samples of (c) and (d): N independent chargebacks on fresh captures, run side by side. Timings are measured from the chargeback POST.
  const N = Number(process.argv[3] ?? 3);
  const c = SANDBOX_TEST_CARD;
  const rnd = (n: number) => Array.from({ length: n }, () => Math.floor(Math.random() * 10)).join("");
  type Trial = { n: number; captureId: string; chargebackAt: number; chargebackError?: unknown; disputeId?: string; apiFirstSeenS?: number; statusLog: { s: number; status: string; state?: string; due?: string | null }[]; captureLog: { s: number; status: string }[]; createdListedAfterS?: number; createdEventId?: string; createdEventCreateS?: number; updatedEventCreateS?: number; witness: Record<string, number>; resend: { n: number; at: number; http: string; arrivedAfterS: number | null }[]; dueRequested: string; amount: string };
  const trials: Trial[] = [];
  const t00 = Date.now();
  for (let i = 1; i <= N; i++) {
    const amount = i === 2 ? "20.00" : "48.00";
    const created = await client.request<{ id: string; purchase_units: { payee?: { merchant_id?: string }; payments?: { captures?: { id: string }[] } }[] }>("create order", "POST", "/v2/checkout/orders", {
      prefer: true,
      body: { intent: "CAPTURE", purchase_units: [{ invoice_id: `DBELL-DISPUTE-T${i}-${Date.now()}`, amount: { currency_code: "USD", value: amount } }], payment_source: { card: { number: c.number, expiry: c.expiry, security_code: c.securityCode, name: c.name } } },
    });
    const captureId = created.purchase_units[0].payments!.captures![0].id;
    trials.push({ n: i, captureId, chargebackAt: 0, statusLog: [], captureLog: [], witness: {}, resend: [], dueRequested: "", amount });
    (state as Json)[`trial${i}`] = { captureId, merchantId: created.purchase_units[0].payee?.merchant_id };
  }
  saveState();
  await sleep(30_000); // let the captures settle before charging them back
  const merchants = trials.map((t) => (state[`trial${t.n}`] as { merchantId?: string }).merchantId);
  await Promise.all(
    trials.map(async (t, idx) => {
      t.chargebackAt = Date.now();
      t.dueRequested = iso(t.chargebackAt + 10 * 24 * 3600 * 1000);
      const r = await call("process chargeback", "POST", "/v2/customer-support/process-chargeback", {
        adjacency: "PAYPAL",
        file_layout: "ATCK_CB",
        merchant_id: merchants[idx],
        financial_institution: { processor: "FDMS" },
        transaction: { id_enc: t.captureId, amount: { currency_code: "USD", value: t.amount } },
        instrument: { instrument_type: "CARD", card_brand: "VISA", credit_card_transaction_id: rnd(16), external: false },
        dispute: { id: null, stage: "CHARGEBACK", response_date: t.dueRequested, status: "2", amount: { currency_code: "USD", value: t.amount }, receive_date: iso(t.chargebackAt), event_code: "CHARGEBACK_INITIATED", money_movement_date: iso(t.chargebackAt), event_type: "DEBIT", chargeback_type: "REPORTED_TO_PROCESSOR", processor_info: { reference_number: rnd(23), reason_code: "1330", notes: "TEST_MEMO" } },
      });
      if (!r.ok) t.chargebackError = redact(r.body);
      else t.disputeId = (r.body as { dispute_id?: string }).dispute_id;
    }),
  );
  // watch for 9 minutes: disputes API, capture status, event list, witness
  const watchUntil = Date.now() + 9 * 60_000;
  const startList = isoSeconds(Math.min(...trials.map((t) => t.chargebackAt)) - 60_000);
  while (Date.now() < watchUntil) {
    for (const t of trials.filter((x) => !x.chargebackError)) {
      const s = Math.round((Date.now() - t.chargebackAt) / 1000);
      const d = await call("list disputes", "GET", `/v1/customer/disputes?disputed_transaction_id=${t.captureId}`);
      const item = d.ok ? (d.body as { items?: { status: string; dispute_state?: string; seller_response_due_date?: string }[] }).items?.[0] : undefined;
      if (item) {
        t.apiFirstSeenS ??= s;
        const last = t.statusLog.at(-1);
        if (!last || last.status !== item.status || last.due !== (item.seller_response_due_date ?? null)) t.statusLog.push({ s, status: item.status, state: item.dispute_state, due: item.seller_response_due_date ?? null });
      }
      const cap = await call("get capture", "GET", `/v2/payments/captures/${t.captureId}`);
      const cs = cap.ok ? (cap.body as { status: string }).status : `error ${cap.status}`;
      if (t.captureLog.at(-1)?.status !== cs) t.captureLog.push({ s, status: cs });
    }
    const rows = await witnessRows(Math.min(...trials.map((t) => t.chargebackAt)) - 60_000);
    const evs = await call("list dispute events", "GET", `/v1/notifications/webhooks-events?page_size=100&start_time=${startList}`);
    const listed = evs.ok ? ((evs.body as { events?: { id: string; event_type: string; create_time: string; resource?: { dispute_id?: string } }[] }).events ?? []) : [];
    for (const t of trials) {
      for (const e of listed) {
        if (e.resource?.dispute_id !== t.disputeId) continue;
        const off = Math.round((Date.parse(e.create_time) - t.chargebackAt) / 1000);
        if (e.event_type === "CUSTOMER.DISPUTE.CREATED") {
          t.createdEventId = e.id;
          t.createdEventCreateS = off;
          t.createdListedAfterS ??= Math.round((Date.now() - t.chargebackAt) / 1000);
        }
        if (e.event_type === "CUSTOMER.DISPUTE.UPDATED") t.updatedEventCreateS ??= off;
      }
      for (const r of rows) if (r.type.startsWith("CUSTOMER.DISPUTE") && t.createdEventId && r.eid === t.createdEventId && !(`created#${r.tid}` in t.witness)) t.witness[`created#${r.tid.slice(0, 6)}`] = Math.round((r.at - t.chargebackAt) / 100) / 10;
    }
    if (trials.every((t) => t.chargebackError || (t.statusLog.some((x) => x.due) && t.createdListedAfterS !== undefined))) break;
    await sleep(8000);
  }
  // (d) more resends: each trial's CREATED event, up to 3 sends, 75 s apart, stopping at the first arrival
  await Promise.all(
    trials
      .filter((t) => t.createdEventId)
      .map(async (t) => {
        for (let k = 1; k <= 3; k++) {
          const known = new Set((await witnessRows(Date.now() - 30 * 60_000)).filter((r) => r.eid === t.createdEventId).map((r) => r.tid));
          const at = Date.now();
          const r = await call("resend dispute event", "POST", `/v1/notifications/webhooks-events/${t.createdEventId}/resend`, { webhook_ids: [DEV_WITNESS_WEBHOOK] });
          const arrived = r.ok ? await waitFor(75_000, 5000, async () => (await witnessRows(at - 1000)).find((x) => x.eid === t.createdEventId && !known.has(x.tid))) : undefined;
          t.resend.push({ n: k, at, http: r.ok ? "2xx" : String(r.status), arrivedAfterS: arrived ? Math.round((arrived.at - at) / 100) / 10 : null });
          if (arrived) break;
        }
      }),
  );
  const outTrials = trials.map((t) => ({ ...t, captureId: "<capture>", disputeId: "<dispute>", createdEventId: t.createdEventId ? "<event>" : undefined, chargebackAt: iso(t.chargebackAt) }));
  save("c2_more_trials", { startedAt: iso(t00), n: N, trials: outTrials });
  console.log(JSON.stringify(outTrials, null, 1));
} else if (cmd === "unsub") {
  // Is a dispute event created and listed when NO webhook of the app subscribes to CUSTOMER.DISPUTE.*? (run after `cleanup` and a wait)
  const subscribed = (await listWebhooks()).flatMap((w) => w.event_types.map((t) => t.name)).filter((n) => n.startsWith("CUSTOMER.DISPUTE") || n === "*");
  if (subscribed.length) throw new Error(`a webhook of the dev app still subscribes to ${subscribed.join(", ")}: run cleanup first`);
  const c = SANDBOX_TEST_CARD;
  const rnd = (n: number) => Array.from({ length: n }, () => Math.floor(Math.random() * 10)).join("");
  const created = await client.request<{ purchase_units: { payee?: { merchant_id?: string }; payments?: { captures?: { id: string }[] } }[] }>("create order", "POST", "/v2/checkout/orders", {
    prefer: true,
    body: { intent: "CAPTURE", purchase_units: [{ invoice_id: `DBELL-UNSUB-${Date.now()}`, amount: { currency_code: "USD", value: "48.00" } }], payment_source: { card: { number: c.number, expiry: c.expiry, security_code: c.securityCode, name: c.name } } },
  });
  const captureId = created.purchase_units[0].payments!.captures![0].id;
  await sleep(30_000);
  const t0 = Date.now();
  const cb = await call("process chargeback", "POST", "/v2/customer-support/process-chargeback", {
    adjacency: "PAYPAL",
    file_layout: "ATCK_CB",
    merchant_id: created.purchase_units[0].payee?.merchant_id,
    financial_institution: { processor: "FDMS" },
    transaction: { id_enc: captureId, amount: { currency_code: "USD", value: "48.00" } },
    instrument: { instrument_type: "CARD", card_brand: "VISA", credit_card_transaction_id: rnd(16), external: false },
    dispute: { id: null, stage: "CHARGEBACK", response_date: iso(t0 + 10 * 24 * 3600 * 1000), status: "2", amount: { currency_code: "USD", value: "48.00" }, receive_date: iso(t0), event_code: "CHARGEBACK_INITIATED", money_movement_date: iso(t0), event_type: "DEBIT", chargeback_type: "REPORTED_TO_PROCESSOR", processor_info: { reference_number: rnd(23), reason_code: "1330", notes: "TEST_MEMO" } },
  });
  const disputeId = cb.ok ? (cb.body as { dispute_id?: string }).dispute_id : undefined;
  const out: Json = { at: iso(t0), webhooksSubscribingToDisputes: 0, chargebackOk: cb.ok, disputeApiFirstSeenS: null, statusLog: [], dispute_event_in_list: null };
  const start = isoSeconds(t0 - 60_000);
  const log: { s: number; status: string; due: string | null }[] = [];
  const t1 = Date.now();
  let seenInList: { type: string; createTimeS: number; listedAfterS: number }[] = [];
  while (Date.now() - t1 < 11 * 60_000) {
    const s = Math.round((Date.now() - t0) / 1000);
    const d = await call("list disputes", "GET", `/v1/customer/disputes?disputed_transaction_id=${captureId}`);
    const item = d.ok ? (d.body as { items?: { status: string; seller_response_due_date?: string }[] }).items?.[0] : undefined;
    if (item) {
      (out as { disputeApiFirstSeenS: number | null }).disputeApiFirstSeenS ??= s;
      if (log.at(-1)?.status !== item.status || log.at(-1)?.due !== (item.seller_response_due_date ?? null)) log.push({ s, status: item.status, due: item.seller_response_due_date ?? null });
    }
    const ev = await call("list events", "GET", `/v1/notifications/webhooks-events?page_size=100&start_time=${start}`);
    const found = ev.ok ? ((ev.body as { events?: { event_type: string; create_time: string; resource?: { dispute_id?: string } }[] }).events ?? []).filter((e) => e.resource?.dispute_id === disputeId) : [];
    for (const e of found) if (!seenInList.some((x) => x.type === e.event_type)) seenInList = [...seenInList, { type: e.event_type, createTimeS: Math.round((Date.parse(e.create_time) - t0) / 1000), listedAfterS: s }];
    if (log.some((x) => x.due) && s > 480) break;
    await sleep(15_000);
  }
  out.statusLog = log;
  out.dispute_event_in_list = seenInList;
  out.watchedForS = Math.round((Date.now() - t0) / 1000);
  save("e2_dispute_with_no_subscribing_webhook", out);
  console.log(JSON.stringify(out, null, 1));
} else if (cmd === "refund-filter") {
  // Does transaction_id on the event list match a REFUNDED event by the capture id or by the refund id?
  const t0 = Date.now();
  const c = SANDBOX_TEST_CARD;
  const created = await client.request<{ purchase_units: { payments?: { captures?: { id: string }[] } }[] }>("create order", "POST", "/v2/checkout/orders", {
    prefer: true,
    body: { intent: "CAPTURE", purchase_units: [{ invoice_id: `DBELL-RFILTER-${t0}`, amount: { currency_code: "USD", value: "6.00" } }], payment_source: { card: { number: c.number, expiry: c.expiry, security_code: c.securityCode, name: c.name } } },
  });
  const captureId = created.purchase_units[0].payments!.captures![0].id;
  await sleep(5000);
  const refund = await client.request<{ id: string }>("refund", "POST", `/v2/payments/captures/${captureId}/refund`, { body: { amount: { currency_code: "USD", value: "6.00" }, invoice_id: `DBELL-RFILTER-R-${t0}` } });
  const start = isoSeconds(t0 - 60_000);
  const got = await waitFor(420_000, 10_000, async () => {
    const r = await call("list", "GET", `/v1/notifications/webhooks-events?page_size=100&start_time=${start}&event_type=PAYMENT.CAPTURE.REFUNDED`);
    const events = r.ok ? ((r.body as { events?: { id: string; resource?: { id?: string } }[] }).events ?? []) : [];
    return events.some((e) => e.resource?.id === refund.id) ? true : undefined;
  });
  const q = async (id: string) => {
    const r = await call("list filtered", "GET", `/v1/notifications/webhooks-events?page_size=100&start_time=${start}&transaction_id=${id}`);
    return r.ok ? ((r.body as { events?: { id: string; event_type: string }[] }).events ?? []).map((e) => e.event_type) : { status: r.status };
  };
  const unfilteredAll = await call("list unfiltered", "GET", `/v1/notifications/webhooks-events?page_size=100&start_time=${start}`);
  const result = {
    at: iso(Date.now()),
    refundedEventListed: !!got,
    unfilteredTypes: unfilteredAll.ok ? ((unfilteredAll.body as { events?: { event_type: string }[] }).events ?? []).map((e) => e.event_type) : { status: unfilteredAll.status },
    byCaptureId: await q(captureId),
    byRefundId: await q(refund.id),
  };
  save("b2_transaction_id_with_refund", result);
  console.log(JSON.stringify(result, null, 1));
} else if (cmd === "refund-target") {
  // (e) prepare: one dev-app capture for the owner to refund by hand in the Sandbox business dashboard (nobody logs in here)
  const t0 = Date.now();
  const c = SANDBOX_TEST_CARD;
  const created = await client.request<{ id: string; purchase_units: { payments?: { captures?: { id: string; status: string }[] } }[] }>("create order", "POST", "/v2/checkout/orders", {
    prefer: true,
    body: {
      intent: "CAPTURE",
      purchase_units: [{ invoice_id: `DBELL-DASHREFUND-${t0}`, description: "Doorbell probe: refund this one from the Sandbox business dashboard", amount: { currency_code: "USD", value: "9.00" } }],
      payment_source: { card: { number: c.number, expiry: c.expiry, security_code: c.securityCode, name: c.name } },
    },
  });
  const capture = created.purchase_units[0].payments?.captures?.[0];
  if (!capture) throw new Error("no capture");
  state.refundTarget = { captureId: capture.id, orderId: created.id, at: t0 };
  saveState();
  save("e_dashboard_refund_target", { createdAt: iso(t0), captureId: capture.id, amount: "9.00", note: "to be refunded by the owner in the Sandbox business dashboard; then run `refund-watch`" });
  console.log(`refund target: capture ${capture.id} (${capture.status}), USD 9.00, created ${iso(t0)}`);
} else if (cmd === "refund-watch") {
  const target = state.refundTarget as { captureId: string; at: number } | undefined;
  if (!target) throw new Error("run refund-target first");
  const cap = await call("get capture", "GET", `/v2/payments/captures/${target.captureId}`);
  const status = cap.ok ? (cap.body as { status?: string }).status : `error ${cap.status}`;
  const start = isoSeconds(target.at - 60_000);
  const list = await call("list refunded events", "GET", `/v1/notifications/webhooks-events?page_size=100&start_time=${start}&event_type=PAYMENT.CAPTURE.REFUNDED`);
  const events = list.ok ? ((list.body as { events?: { id: string; create_time: string; resource?: { id?: string; links?: { rel?: string; href?: string }[] } }[] }).events ?? []) : [];
  const mine = events.filter((e) => (e.resource?.links ?? []).some((l) => l.rel === "up" && (l.href ?? "").endsWith(target.captureId)));
  const heard = (await witnessRows(target.at)).filter((r) => r.type === "PAYMENT.CAPTURE.REFUNDED" && (r.raw ?? "").includes(target.captureId));
  const out = { checkedAt: iso(Date.now()), captureStatusNow: status, refundedEventsInListForThisCapture: mine.map((e) => ({ id: e.id, createTime: e.create_time })), witnessDeliveries: heard.map((h) => ({ eid: h.eid, slot: h.slot, afterRefundTargetS: Math.round((h.at - target.at) / 1000) })) };
  save("e_dashboard_refund_result", out);
  console.log(JSON.stringify(out, null, 1));
} else if (cmd === "cleanup") {
  const original = state.witnessTypesOriginal as string[] | undefined;
  if (!original) throw new Error("no original event types in the state");
  const tp = Date.now();
  const patch = await call("restore dev witness webhook", "PATCH", `/v1/notifications/webhooks/${DEV_WITNESS_WEBHOOK}`, [{ op: "replace", path: "/event_types", value: original.map((name) => ({ name })) }]);
  const now = (await listWebhooks()).map((w) => ({ id: w.id, url: w.url, types: w.event_types.map((t) => t.name).sort() }));
  save("z_cleanup", { at: iso(tp), restored: patch.ok, status: patch.ok ? "ok" : patch.status, devWebhooksNow: now, matchesOriginal: JSON.stringify(now.find((w) => w.id === DEV_WITNESS_WEBHOOK)?.types) === JSON.stringify([...original].sort()) });
  console.log(JSON.stringify(steps.z_cleanup, null, 1));
} else {
  throw new Error("usage: disputes-probe.ts setup | order | dispute | resend | cleanup");
}
