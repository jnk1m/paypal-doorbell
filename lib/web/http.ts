// Small helpers for the route handlers: JSON responses and one error shape.
// What a client sees is a fixed phrase and an id. Everything else (PayPal debug ids, step names, stacks) goes to the server log only.
import { randomUUID } from "node:crypto";
import { checkLimit, type LimitKind } from "../limits.ts";
import { PaypalError } from "../pay/paypal.ts";

// An error whose message is written for the client (a fixed phrase, never built from request data or upstream responses).
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly context: Record<string, string> = {}, // server log only
    readonly retryAfterSec?: number,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

const NO_STORE = { "Cache-Control": "no-store" };

export const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response => Response.json(body, { status, headers: { ...NO_STORE, ...headers } });

const GENERIC: Record<number, string> = { 400: "Bad request.", 401: "Not authorized.", 403: "Forbidden.", 404: "Not found.", 429: "Too many requests.", 502: "An upstream service failed." };
const genericMessage = (status: number): string => GENERIC[status] ?? "Something went wrong.";

// The fields of an error that are safe and useful to log. Never the error object itself: an AI SDK error can carry the whole prompt.
export function errorFields(e: unknown): Record<string, unknown> {
  if (e instanceof PaypalError) return { name: e.name, step: e.step, paypalStatus: e.status, debugId: e.debugId, message: e.message };
  if (e instanceof Error) return { name: e.name, message: e.message.slice(0, 300), stack: e.stack?.split("\n").slice(1, 5).map((l) => l.trim()) };
  return { name: typeof e, message: String(e).slice(0, 300) };
}

export const logServerError = (route: string, id: string, status: number, e: unknown, context: Record<string, string> = {}): void =>
  console.error(JSON.stringify({ route, id, status, ...context, ...errorFields(e) }));

// Every failure leaves as { error: { message, id } }. The id ties the response to the server log line.
export async function handle(route: string, run: () => Promise<Response>, context: Record<string, string> = {}): Promise<Response> {
  try {
    return await run();
  } catch (e) {
    const id = randomUUID();
    if (e instanceof HttpError) {
      const headers: Record<string, string> = e.retryAfterSec ? { "Retry-After": String(e.retryAfterSec) } : {};
      if (e.status >= 500) logServerError(route, id, e.status, e, { ...context, ...e.context });
      return json({ error: { message: e.message, id } }, e.status, headers);
    }
    const status = e instanceof PaypalError ? 502 : 500;
    logServerError(route, id, status, e, context);
    return json({ error: { message: genericMessage(status), id } }, status);
  }
}

// The caller's address as the platform reports it (first X-Forwarded-For entry). With no proxy in front it is "unknown", one shared bucket.
export function clientIp(req: Request): string {
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || req.headers.get("x-real-ip")?.trim() || "unknown";
}

// R13. Throws a 429 that carries the limiter's reason. A limiter (Redis) error is not caught: the call it guards must not run unchecked.
export async function enforceLimit(kind: LimitKind, req: Request, session?: string): Promise<void> {
  const result = await checkLimit(kind, { ip: clientIp(req), session });
  if (!result.ok) throw new HttpError(429, result.reason ?? `rate limit reached (${kind})`, { limit: kind }, result.retryAfterSec);
}
