// Cheap checks that run before anything is verified, stored or sent to PayPal (plan 9.1).
// A request that fails here is not a PayPal delivery. Nothing here fetches a URL: cert_url is only matched against an allow-list
// and handed to PayPal's verify endpoint, which does the certificate work.

export const MAX_BODY_BYTES = 64 * 1024;
const FUTURE_TOLERANCE_MS = 5 * 60 * 1000;

// The only certificate hosts PayPal Sandbox signs from. Matched on the raw string, so userinfo, ports, queries and fragments cannot slip through.
const CERT_URL = /^https:\/\/(?:api\.sandbox\.paypal\.com|api-m\.sandbox\.paypal\.com)\/v1\/notifications\/certs\/[A-Za-z0-9-]{1,100}$/;
const TRANSMISSION_ID = /^[A-Za-z0-9-]{8,64}$/;
const TRANSMISSION_SIG = /^[A-Za-z0-9+/]{100,1024}={0,2}$/;
const TRANSMISSION_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const EVENT_ID = /^[A-Za-z0-9._-]{1,64}$/;
const EVENT_TYPE = /^[A-Z0-9][A-Z0-9._-]{1,63}$/;

export interface SignatureHeaders {
  transmissionId: string;
  transmissionTime: string;
  transmissionSig: string;
  certUrl: string;
  authAlgo: string;
}

export type HeaderCheck = { ok: true; headers: SignatureHeaders } | { ok: false; reason: string };

// The reason is for the server log only; the caller answers every failure with the same body.
export function checkHeaders(headers: Headers, now: number): HeaderCheck {
  const get = (name: string) => headers.get(name)?.trim() ?? "";
  const transmissionId = get("paypal-transmission-id");
  const transmissionTime = get("paypal-transmission-time");
  const transmissionSig = get("paypal-transmission-sig");
  const certUrl = get("paypal-cert-url");
  const authAlgo = get("paypal-auth-algo");

  if (!transmissionId || !transmissionTime || !transmissionSig || !certUrl || !authAlgo) return { ok: false, reason: "missing PayPal header" };
  if (!TRANSMISSION_ID.test(transmissionId)) return { ok: false, reason: "malformed transmission id" };
  if (!TRANSMISSION_SIG.test(transmissionSig)) return { ok: false, reason: "malformed transmission signature" };
  if (!CERT_URL.test(certUrl)) return { ok: false, reason: "cert_url is not an allowed PayPal Sandbox certificate URL" };
  if (authAlgo !== "SHA256withRSA") return { ok: false, reason: "unsupported auth_algo" };
  if (!TRANSMISSION_TIME.test(transmissionTime)) return { ok: false, reason: "malformed transmission time" };
  const sentAt = Date.parse(transmissionTime);
  if (Number.isNaN(sentAt)) return { ok: false, reason: "unparseable transmission time" };
  // The past is not checked: PayPal retries a delivery with its original time (measured: same id, same time, same signature).
  if (sentAt > now + FUTURE_TOLERANCE_MS) return { ok: false, reason: "transmission time is more than 5 minutes in the future" };
  if (!(headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) return { ok: false, reason: "content type is not application/json" };
  return { ok: true, headers: { transmissionId, transmissionTime, transmissionSig, certUrl, authAlgo } };
}

export type BodyRead = { ok: true; raw: string } | { ok: false; reason: string };

// Reads the request body, stopping as soon as it passes the limit (a declared Content-Length is only a hint).
export async function readBodyCapped(req: Request, limit: number = MAX_BODY_BYTES): Promise<BodyRead> {
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) return { ok: false, reason: `declared body size ${declared} is over ${limit}` };
  if (!req.body) return { ok: false, reason: "empty body" };
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => undefined);
      return { ok: false, reason: `body is over ${limit} bytes` };
    }
    chunks.push(value);
  }
  if (size === 0) return { ok: false, reason: "empty body" };
  return { ok: true, raw: Buffer.concat(chunks).toString("utf8") };
}

export interface ParsedEvent {
  event: Record<string, unknown>;
  eventId: string;
  eventType: string;
}

export type EventParse = { ok: true; parsed: ParsedEvent } | { ok: false; reason: string };

// PayPal's verify endpoint takes the delivery as a JSON object, so a body that is not one cannot be verified at all.
export function parseEvent(raw: string): EventParse {
  let event: unknown;
  try {
    event = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "body is not JSON" };
  }
  if (typeof event !== "object" || event === null || Array.isArray(event)) return { ok: false, reason: "body is not a JSON object" };
  const { id, event_type: type } = event as { id?: unknown; event_type?: unknown };
  if (typeof id !== "string" || !EVENT_ID.test(id)) return { ok: false, reason: "event id missing or malformed" };
  if (typeof type !== "string" || !EVENT_TYPE.test(type)) return { ok: false, reason: "event type missing or malformed" };
  return { ok: true, parsed: { event: event as Record<string, unknown>, eventId: id, eventType: type } };
}
