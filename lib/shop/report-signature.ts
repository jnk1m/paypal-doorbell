// The reporter's wire protocol for a shop of your own (R24, plan 5.7): one POST per report line, signed with a secret that the shop
// and the Doorbell it reports to share. The client (http-reporter.ts) and the intake (report-intake.ts) both read this file, so the two
// sides sign the same string.
//
//   Doorbell-Timestamp   the sender's clock, milliseconds since the epoch, digits only
//   Doorbell-Nonce       16 to 64 hex characters, new for every request
//   Doorbell-Signature   v1=<hex HMAC-SHA256 of "<timestamp>.<nonce>.<raw body>" under the shared secret>
//
// The body is one report line, the same two shapes the in-process reporter writes (reporter.ts), without the time (the intake stamps its own):
//   {"k":"rx","tid":<transmission id>,"eid":<event id>,"a":<attempt id>}
//   {"k":"rs","tid":<transmission id>,"eid":<event id>,"a":<attempt id>,"st":<status code>}
//
// A request whose timestamp is more than 5 minutes from the intake's clock, whose nonce was seen before (nonces are kept for 10 minutes,
// twice the skew, so a replay is refused by one check or the other), whose signature does not match, or whose body is not one report
// line is refused. Every refusal has the same body; the reason goes to the server log only.
import { createHmac, timingSafeEqual } from "node:crypto";

export const HEADER_TIMESTAMP = "doorbell-timestamp";
export const HEADER_NONCE = "doorbell-nonce";
export const HEADER_SIGNATURE = "doorbell-signature";

export const MAX_SKEW_MS = 5 * 60_000;
export const NONCE_TTL_MS = 2 * MAX_SKEW_MS;
export const MAX_REPORT_BYTES = 1024;
// A shorter secret is treated as none: the intake stays closed rather than open with a guessable key.
export const MIN_SECRET_LENGTH = 32;

export const NONCE = /^[0-9a-f]{16,64}$/;
export const TIMESTAMP = /^\d{1,16}$/;
export const SIGNATURE = /^v1=[0-9a-f]{64}$/;
// The same shapes the witness pre-check accepts for PayPal's ids; the attempt id is what both reporters generate (6 random bytes, hex).
const TRANSMISSION_ID = /^[A-Za-z0-9-]{8,64}$/;
const EVENT_ID = /^[A-Za-z0-9._-]{1,64}$/;
const ATTEMPT_ID = /^[0-9a-f]{12}$/;

export type ReportLine = { k: "rx"; tid: string; eid: string; a: string } | { k: "rs"; tid: string; eid: string; a: string; st: number };

export function signReport(secret: string, timestamp: number, nonce: string, body: string): string {
  return `v1=${createHmac("sha256", secret).update(`${timestamp}.${nonce}.${body}`).digest("hex")}`;
}

// Constant-time on the signature itself; the shapes are checked first so a malformed header is refused without a comparison.
export function signatureMatches(secret: string, timestamp: number, nonce: string, body: string, given: string): boolean {
  if (!SIGNATURE.test(given)) return false;
  const expected = Buffer.from(signReport(secret, timestamp, nonce, body));
  const got = Buffer.from(given);
  return expected.length === got.length && timingSafeEqual(expected, got);
}

// One report line and nothing else: an object with exactly the keys of one of the two shapes. null for anything else.
export function parseReportLine(raw: string): ReportLine | null {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o).sort();
  if (typeof o.tid !== "string" || !TRANSMISSION_ID.test(o.tid)) return null;
  if (typeof o.eid !== "string" || !EVENT_ID.test(o.eid)) return null;
  if (typeof o.a !== "string" || !ATTEMPT_ID.test(o.a)) return null;
  if (o.k === "rx" && keys.join(",") === "a,eid,k,tid") return { k: "rx", tid: o.tid, eid: o.eid, a: o.a };
  if (o.k === "rs" && keys.join(",") === "a,eid,k,st,tid" && Number.isInteger(o.st) && (o.st as number) >= 100 && (o.st as number) <= 599) return { k: "rs", tid: o.tid, eid: o.eid, a: o.a, st: o.st as number };
  return null;
}
