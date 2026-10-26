// Shared by the shop tests: PayPal-shaped events, a request builder for the shop webhook, and a stand-in for PayPal's verify endpoint.
// The stand-in has the one property of the real endpoint that the planted bugs depend on (measured 2026-10-19 on 6 real deliveries):
// the delivery is checked against the exact key order PayPal signed, so the same event with its keys sorted is a FAILURE while the
// same event parsed and stringified again (same order) is a SUCCESS.
import { PaypalError, type VerifyParams } from "../pay/paypal.ts";
import { InProcessReporter } from "./reporter.ts";
import { MemoryShopStore, type ShopStore } from "./store.ts";
import { COMPLETED, REFUNDED } from "./events.ts";
import type { Mode } from "./types.ts";
import type { ShopWebhookDeps } from "./webhook.ts";

export const SHOP_WEBHOOK_ID = "SHOPWEBHOOK0000001";
// Another webhook of the same app (the witness's): what the setting-bug mode checks deliveries against. The stand-in verify calls it a FAILURE.
export const OTHER_WEBHOOK_ID = "OTHERWEBHOOK000001";

let counter = 0;
export const uniq = (prefix: string) => `${prefix}${(++counter).toString().padStart(8, "0")}`;

export interface SignedDelivery {
  tid: string;
  eid: string;
  raw: string;
  headers: Record<string, string>;
}

const eventBase = (eid: string, type: string, resource: Record<string, unknown>) => ({
  id: eid,
  event_version: "1.0",
  create_time: "2026-10-19T03:00:00.000Z",
  resource_type: type === COMPLETED ? "capture" : "refund",
  resource_version: "2.0",
  event_type: type,
  summary: "fixture",
  resource,
  links: [{ href: `https://api.sandbox.paypal.com/v1/notifications/webhooks-events/${eid}`, rel: "self", method: "GET" }],
});

// A COMPLETED event for `captureId`, as PayPal would deliver it (the key order here is the signed order).
export function completedEvent(captureId: string, amount = "48.00", eid = uniq("WH-COMPLETED-")) {
  return eventBase(eid, COMPLETED, {
    id: captureId,
    amount: { currency_code: "USD", value: amount },
    final_capture: true,
    invoice_id: "MM-fixture-1",
    status: "COMPLETED",
    create_time: "2026-10-19T03:00:00Z",
    links: [{ href: `https://api.sandbox.paypal.com/v2/payments/captures/${captureId}`, rel: "self", method: "GET" }],
  });
}

export function refundedEvent(captureId: string, refundId: string, amount = "48.00", eid = uniq("WH-REFUNDED-")) {
  return eventBase(eid, REFUNDED, {
    id: refundId,
    amount: { currency_code: "USD", value: amount },
    invoice_id: "MM-fixture-1-R",
    status: "COMPLETED",
    create_time: "2026-10-19T03:01:00Z",
    links: [
      { href: `https://api.sandbox.paypal.com/v2/payments/refunds/${refundId}`, rel: "self", method: "GET" },
      { href: `https://api.sandbox.paypal.com/v2/payments/captures/${captureId}`, rel: "up", method: "GET" },
    ],
  });
}

// Headers that pass the pre-check (they are not a signature PayPal made; the stand-in decides what counts as signed).
export function signed(event: { id: string }, tid = uniq("tid-")): SignedDelivery {
  return {
    tid,
    eid: event.id,
    raw: JSON.stringify(event),
    headers: {
      "content-type": "application/json",
      "paypal-auth-algo": "SHA256withRSA",
      "paypal-cert-url": "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-360caa42-fca2a594-1d93a270",
      "paypal-transmission-id": tid,
      "paypal-transmission-sig": Buffer.alloc(256, 7).toString("base64"),
      "paypal-transmission-time": new Date().toISOString(),
    },
  };
}

export const requestOf = (d: SignedDelivery, over: { headers?: Record<string, string | null>; raw?: string } = {}): Request => {
  const headers = new Headers(d.headers);
  for (const [k, v] of Object.entries(over.headers ?? {})) {
    if (v === null) headers.delete(k);
    else headers.set(k, v);
  }
  return new Request("https://doorbell.test/api/shop/webhook", { method: "POST", headers, body: over.raw ?? d.raw });
};

export type VerifyMode = "ok" | "timeout" | "http503";

// SUCCESS only for a delivery registered as really signed, for the shop's webhook, with its body in the signed key order.
export function fakePaypal() {
  const registered = new Map<string, SignedDelivery>();
  const state = { calls: 0, mode: "ok" as VerifyMode, events: [] as unknown[] };
  const verify = async (p: VerifyParams): Promise<string | undefined> => {
    state.calls++;
    state.events.push(p.webhookEvent);
    if (state.mode === "timeout") throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
    if (state.mode === "http503") throw new PaypalError("verify webhook signature", 503, "dbg", undefined);
    const d = registered.get(p.transmissionId);
    if (!d || p.webhookId !== SHOP_WEBHOOK_ID) return "FAILURE";
    return JSON.stringify(p.webhookEvent) === d.raw ? "SUCCESS" : "FAILURE";
  };
  return { verify, state, sign: (event: { id: string }, tid?: string) => { const d = signed(event, tid); registered.set(d.tid, d); return d; } };
}

export function shopWorld(store: ShopStore = new MemoryShopStore()) {
  const paypal = fakePaypal();
  const logs: Record<string, unknown>[] = [];
  let clock = Date.now();
  const deps: ShopWebhookDeps = {
    webhookId: SHOP_WEBHOOK_ID,
    settingWebhookId: OTHER_WEBHOOK_ID,
    store,
    reporter: new InProcessReporter(store, () => clock),
    verify: paypal.verify,
    now: () => clock,
    log: (line) => void logs.push(line),
  };
  return {
    store,
    paypal,
    deps,
    logs,
    advance: (ms: number) => (clock += ms),
    // A session whose order was created: the capture is mapped to it, as createOrder does.
    async session(mode: Mode = "good") {
      const sid = uniq("s").padEnd(32, "0");
      await store.createSession(sid, mode, clock);
      const captureId = uniq("CAPTURE");
      const refundId = uniq("REFUND");
      await store.putOrder(sid, { n: 1, item: "gift-set", amount: "48.00", orderId: uniq("ORDER"), captureId, invoiceId: "MM-fixture-1", at: clock });
      return { sid, captureId, refundId };
    },
  };
}
