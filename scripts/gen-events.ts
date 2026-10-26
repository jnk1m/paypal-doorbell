// Makes real Sandbox events for the witness: card orders that capture at once (4111 test card), refunds, and authorize/void pairs.
//   npx tsx scripts/gen-events.ts captures <n> [refund <k>]      n capture orders, then refund the first k
//   npx tsx scripts/gen-events.ts auth <n>                        n authorizations, each voided
// Prints one JSON line per action (no secrets) so a run can be matched against what the witness stored.
import { randomUUID } from "node:crypto";
import { PaypalClient, SANDBOX_TEST_CARD } from "../lib/pay/paypal.ts";
import { refundCapture } from "../lib/pay/toolkit.ts";
import { loadEnv } from "./env.ts";

loadEnv();
const client = PaypalClient.fromEnv();
const [mode, nArg, , kArg] = process.argv.slice(2);
const n = Number(nArg ?? 1);
const k = Number(kArg ?? 0);
const say = (o: object) => console.log(JSON.stringify({ t: new Date().toISOString(), ...o }));

interface OrderResponse {
  id: string;
  status: string;
  purchase_units?: { payments?: { captures?: { id: string }[]; authorizations?: { id: string }[] } }[];
}

async function order(intent: "CAPTURE" | "AUTHORIZE", invoiceId: string, value: string): Promise<OrderResponse> {
  const c = SANDBOX_TEST_CARD;
  return client.request<OrderResponse>("create order", "POST", "/v2/checkout/orders", {
    prefer: true,
    body: {
      intent,
      purchase_units: [{ invoice_id: invoiceId, amount: { currency_code: "USD", value } }],
      payment_source: { card: { number: c.number, expiry: c.expiry, security_code: c.securityCode, name: c.name } },
    },
  });
}

const run = randomUUID().slice(0, 6);

if (mode === "captures") {
  const captures: string[] = [];
  for (let i = 0; i < n; i++) {
    const o = await order("CAPTURE", `DBELL-S1-${run}-${i}`, (10 + i).toFixed(2));
    const capture = o.purchase_units?.[0]?.payments?.captures?.[0]?.id;
    say({ action: "capture", order: o.id, status: o.status, capture });
    if (capture) captures.push(capture);
  }
  for (const capture of captures.slice(0, k)) {
    const r = await refundCapture(client, capture);
    say({ action: "refund", capture, refund: r.refundId, status: r.status });
  }
} else if (mode === "auth") {
  for (let i = 0; i < n; i++) {
    const o = await order("AUTHORIZE", `DBELL-S1-${run}-A${i}`, (20 + i).toFixed(2));
    const auth = o.purchase_units?.[0]?.payments?.authorizations?.[0]?.id;
    say({ action: "authorize", order: o.id, status: o.status, authorization: auth });
    if (auth) {
      await client.request("void authorization", "POST", `/v2/payments/authorizations/${auth}/void`);
      say({ action: "void", authorization: auth });
    }
  }
} else {
  throw new Error("usage: gen-events.ts captures <n> [refund <k>] | auth <n>");
}
