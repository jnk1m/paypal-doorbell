// Maple Mug's orders and refunds, on the Sandbox app this deployment runs as (the demo app on Vercel). The price comes from the
// server's catalog. We set the invoice id on the order and on the refund, and write the capture -> session map the moment the
// order exists, so that a webhook for it can find its session before its first delivery (about 3 s later at the earliest).
import { PaypalClient, SANDBOX_TEST_CARD } from "../pay/paypal.ts";
import { refundCapture } from "../pay/toolkit.ts";
import { HttpError } from "../web/http.ts";
import { CATALOG, type ItemId } from "./catalog.ts";
import type { ShopStore } from "./store.ts";
import type { OrderRecord } from "./types.ts";

interface OrderResponse {
  id: string;
  status: string;
  purchase_units?: { payments?: { captures?: { id: string; status: string }[] } }[];
}

// Card orders capture at once (measured, F12). Anything else means the order is not one the demo can use.
export async function createOrder(client: PaypalClient, store: ShopStore, sid: string, item: ItemId, now: number): Promise<OrderRecord> {
  const n = (await store.orders(sid)).length + 1;
  const invoiceId = `MM-${sid.slice(0, 8)}-${n}`;
  const card = SANDBOX_TEST_CARD;
  const order = await client.request<OrderResponse>("create order", "POST", "/v2/checkout/orders", {
    prefer: true,
    body: {
      intent: "CAPTURE",
      purchase_units: [{ invoice_id: invoiceId, description: `Maple Mug: ${CATALOG[item].name}`.slice(0, 127), amount: { currency_code: "USD", value: CATALOG[item].price } }],
      payment_source: { card: { number: card.number, expiry: card.expiry, security_code: card.securityCode, name: card.name } },
    },
  });
  const capture = order.purchase_units?.[0]?.payments?.captures?.[0];
  if (order.status !== "COMPLETED" || !capture?.id) throw new HttpError(502, "An upstream service failed.", { orderStatus: String(order.status), captures: String(order.purchase_units?.[0]?.payments?.captures?.length ?? 0) });
  const record: OrderRecord = { n, item, amount: CATALOG[item].price, orderId: order.id, captureId: capture.id, invoiceId, at: now };
  await store.putOrder(sid, record);
  return record;
}

export async function refundOrder(client: PaypalClient, store: ShopStore, sid: string, captureId: string, now: number): Promise<OrderRecord> {
  const order = (await store.orders(sid)).find((o) => o.captureId === captureId);
  if (!order) throw new HttpError(403, "Forbidden.", { reason: "capture is not an order of this session" });
  if (order.refund) throw new HttpError(409, "Already refunded.");
  const invoiceId = `${order.invoiceId}-R`;
  const refund = await refundCapture(client, captureId, { invoiceId, note: "Maple Mug refund" });
  const updated: OrderRecord = { ...order, refund: { id: refund.refundId, invoiceId, at: now } };
  await store.putOrder(sid, updated);
  return updated;
}
