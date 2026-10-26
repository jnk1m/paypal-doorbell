// The endpoint of webhook U (plan 5.6): a demo-app webhook that deliberately does not subscribe to PAYMENT.CAPTURE.REFUNDED, kept
// so that the "unsubscribed event type" case file has a real webhook to point at. It answers 200 and does nothing else: no
// signature check, no Redis, no state. It exists so that PayPal's deliveries to U are acknowledged instead of retried; nobody reads them.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 10;

export function POST(): Response {
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}
