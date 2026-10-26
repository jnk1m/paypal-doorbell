// PayPal calls that go through @paypal/agent-toolkit (get_order, create_refund). A separate file so that routes which only
// need the REST client (the witness receiver) do not pull the toolkit into their function bundle.
import type { PaypalClient } from "./paypal.ts";
import { PaypalError } from "./paypal.ts";

interface Capture { id: string; status: string }
interface OrderBody {
  id: string;
  status: string;
  purchase_units?: { payments?: { captures?: Capture[] } }[];
}

// Calls a toolkit tool function directly (the /mcp entry exports PayPalAPI; no ai-sdk adapter involved).
// sandbox: true is fixed here. run() returns JSON text and folds errors into {ok:false,status,code,message}, which has no debug_id.
async function toolkit<T>(client: PaypalClient, tool: string, requestId: string, args: object): Promise<T> {
  const { PayPalAPI } = await import("@paypal/agent-toolkit/mcp");
  const text = await new PayPalAPI(await client.accessToken(), { sandbox: true, request_id: requestId }).run(tool, args);
  const out = JSON.parse(text) as { ok?: boolean; status?: number; error?: unknown };
  if (out.ok === false || out.error) throw new PaypalError(`agent-toolkit:${tool}`, out.status ?? 0, undefined, out);
  return out as T;
}

// invoiceId and note are optional: the demo shop sets its own invoice id on every refund (the toolkit accepts [A-Za-z0-9_-], up to 127).
export async function refundCapture(client: PaypalClient, captureId: string, extra: { invoiceId?: string; note?: string } = {}) {
  const r = await toolkit<{ id: string; status: string }>(client, "create_refund", `refund:${captureId}`, {
    capture_id: captureId,
    ...(extra.invoiceId ? { invoice_id: extra.invoiceId } : {}),
    ...(extra.note ? { note_to_payer: extra.note } : {}),
  });
  return { refundId: r.id, status: r.status };
}

export async function getOrder(client: PaypalClient, orderId: string) {
  const o = await toolkit<OrderBody>(client, "get_order", `get-order:${orderId}`, { id: orderId });
  return { id: o.id, status: o.status, captureIds: (o.purchase_units?.[0]?.payments?.captures ?? []).map((c) => c.id) };
}
