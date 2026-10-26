// Guards for the shop's API routes. The live shop is closed by default (DO NOT CHANGE 9): every route that touches PayPal needs the
// live token, a browser must come from our own origin, and a session id is 128 random bits that the server created.
import { timingSafeEqual } from "node:crypto";
import { HttpError } from "../web/http.ts";
import type { ShopStore } from "./store.ts";
import { isSettingBug, type Mode } from "./types.ts";

const SESSION_ID = /^[0-9a-f]{32}$/;

const safeEqual = (a: string, b: string): boolean => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

// With no token configured nothing is allowed: a deployment that forgot the variable is closed, not open.
export function requireLiveToken(req: Request, expected: string | undefined): void {
  const given = req.headers.get("x-live-token") ?? "";
  if (!expected) throw new HttpError(403, "Forbidden.", { reason: "DOORBELL_LIVE_TOKEN is not set: the live shop is closed" });
  if (!safeEqual(given, expected)) throw new HttpError(403, "Forbidden.", { reason: "live token missing or wrong" });
}

// A request from a browser carries Origin; it has to be this site. Scripts send none, and they still need the token.
export function requireSameOrigin(req: Request): void {
  const origin = req.headers.get("origin");
  if (!origin) return;
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? "";
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    throw new HttpError(403, "Forbidden.", { reason: "unparseable Origin" });
  }
  if (originHost !== host) throw new HttpError(403, "Forbidden.", { reason: `cross-origin request from ${originHost.slice(0, 60)}` });
}

// The setting-bug mode checks deliveries against another webhook's id (webhook.ts); a deployment without that id cannot plant it, and says so
// instead of switching to a mode that would then answer 500 to every delivery.
export function requireModeAvailable(mode: Mode, settingWebhookId: string | undefined): void {
  if (isSettingBug(mode) && !settingWebhookId) throw new HttpError(409, "Not available.", { reason: `mode ${mode} needs PAYPAL_WITNESS_WEBHOOK_ID, which is not set or malformed` });
}

export const newSessionId = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");

// The session id of a request as its header gives it, checked for shape only (no Redis): the limiter counts per session before the session
// is looked up, so a flood of requests costs the database nothing. The id is 128 random bits; a made-up one fails requireSession below.
export function sessionIdOf(req: Request): string {
  const sid = req.headers.get("x-session") ?? "";
  if (!SESSION_ID.test(sid)) throw new HttpError(400, "Bad request.", { reason: "X-Session header missing or malformed" });
  return sid;
}

export async function requireSession(req: Request, store: ShopStore): Promise<{ sid: string; mode: Mode; at: number }> {
  const sid = sessionIdOf(req);
  const session = await store.getSession(sid);
  if (!session) throw new HttpError(404, "Not found.", { reason: "unknown or expired session" });
  return { sid, ...session };
}

// A JSON body, or a 400 with a fixed phrase. Whatever the caller sent never reaches the message.
export async function readJson(req: Request): Promise<Record<string, unknown>> {
  try {
    const text = await req.text();
    if (text.length > 2048) throw new Error("too large");
    const body: unknown = JSON.parse(text);
    if (typeof body !== "object" || body === null || Array.isArray(body)) throw new Error("not an object");
    return body as Record<string, unknown>;
  } catch (e) {
    throw new HttpError(400, "Bad request.", { reason: e instanceof Error ? e.message : "unparseable body" });
  }
}
