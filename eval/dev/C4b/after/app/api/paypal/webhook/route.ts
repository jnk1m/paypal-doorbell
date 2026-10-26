import { NextResponse } from "next/server";
import { createVerify } from "node:crypto";
import crc32 from "buffer-crc32";
import { sql } from "@/lib/db";
import { log } from "@/lib/log";
import { fetchCert } from "@/lib/paypal-certs";

export const runtime = "nodejs";

const WEBHOOK_ID = process.env.PAYPAL_WEBHOOK_ID!;

// Events this endpoint acts on. Anything else is acknowledged and ignored.
const HANDLED = new Set([
  "PAYMENT.CAPTURE.COMPLETED",
  "PAYMENT.CAPTURE.REFUNDED",
  "PAYMENT.CAPTURE.DENIED",
]);

async function verify(req: Request, raw: string): Promise<boolean> {
  const cert = await fetchCert(req.headers.get("paypal-cert-url")!);
  const signed = [
    req.headers.get("paypal-transmission-id"),
    req.headers.get("paypal-transmission-time"),
    WEBHOOK_ID,
    crc32.unsigned(raw),
  ].join("|");
  const verifier = createVerify("SHA256");
  verifier.update(signed);
  return verifier.verify(cert, req.headers.get("paypal-transmission-sig")!, "base64");
}

function captureIdOf(event: PayPalEvent): string {
  return event.resource.links.find((l) => l.rel === "up")!.href.split("/").pop()!;
}

async function applyEvent(event: PayPalEvent) {
  switch (event.event_type) {
    case "PAYMENT.CAPTURE.COMPLETED":
      await sql`UPDATE orders SET status = 'paid', pp_capture_id = ${event.resource.id}
                WHERE pp_order_id = ${event.resource.supplementary_data.related_ids.order_id}`;
      break;
    case "PAYMENT.CAPTURE.REFUNDED":
      await sql`UPDATE orders SET status = 'refunded' WHERE pp_capture_id = ${captureIdOf(event)}`;
      break;
    case "PAYMENT.CAPTURE.DENIED":
      await sql`UPDATE orders SET status = 'payment_failed' WHERE pp_capture_id = ${event.resource.id}`;
      break;
  }
}

export async function POST(req: Request) {
  const raw = await req.text();
  if (!(await verify(req, raw))) {
    log.warn({ transmissionId: req.headers.get("paypal-transmission-id") }, "paypal webhook signature rejected for transmission");
    return NextResponse.json({ error: "bad signature" }, { status: 401 });
  }
  const event = JSON.parse(raw) as PayPalEvent;
  if (!HANDLED.has(event.event_type)) return NextResponse.json({ ok: true });
  try {
    await applyEvent(event);
    return NextResponse.json({ ok: true });
  } catch (err) {
    log.error({ err, eventId: event.id }, "paypal webhook handler failed");
    return NextResponse.json({ error: "failed" }, { status: 500 });
  }
}
