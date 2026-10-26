// REST client for PayPal. Sandbox only: the base URL is a constant and construction fails if anything else is configured.
import { randomUUID } from "node:crypto";

export const SANDBOX_BASE_URL = "https://api-m.sandbox.paypal.com";
const DEFAULT_TIMEOUT_MS = 20_000;

// Public Sandbox test card (not a secret).
export const SANDBOX_TEST_CARD = { number: "4111111111111111", expiry: "2030-12", securityCode: "123", name: "Doorbell Test" };

// PayPal error names and issue codes look like INVALID_RESOURCE_ID. Anything else in a response (descriptions, echoed input)
// is free text and stays out of messages that can reach a log line or a client.
const CODE = /^[A-Z][A-Z0-9_]{2,63}$/;

function codesOf(body: unknown): string[] {
  const b = body as { name?: unknown; details?: { issue?: unknown }[] } | undefined;
  const found = [b?.name, ...(Array.isArray(b?.details) ? b.details.map((d) => d?.issue) : [])];
  return found.filter((c): c is string => typeof c === "string" && CODE.test(c)).slice(0, 4);
}

// The message holds the step, the HTTP status and PayPal's error codes. The debug id and the raw response body are fields,
// for code that decides what to log: never log the whole error object.
export class PaypalError extends Error {
  readonly codes: string[];
  constructor(
    readonly step: string,
    readonly status: number,
    readonly debugId: string | undefined,
    readonly body: unknown,
  ) {
    const codes = codesOf(body);
    super(`${step} failed: HTTP ${status}${codes.length ? ` ${codes.join(" ")}` : ""}`);
    this.name = "PaypalError";
    this.codes = codes;
  }
}

export interface PaypalConfig {
  clientId: string;
  clientSecret: string;
  baseUrl?: string; // only SANDBOX_BASE_URL is accepted
  timeoutMs?: number; // per HTTP call, token requests included
}

export interface RequestOptions {
  body?: unknown;
  requestId?: string;
  prefer?: boolean;
  timeoutMs?: number;
}

export interface VerifyParams {
  authAlgo: string;
  certUrl: string;
  transmissionId: string;
  transmissionSig: string;
  transmissionTime: string;
  webhookId: string;
  webhookEvent: unknown;
}

export class PaypalClient {
  private readonly baseUrl = SANDBOX_BASE_URL;
  private readonly timeoutMs: number;
  private tokenCache?: { value: string; expiresAt: number };
  private tokenInFlight?: Promise<string>;

  constructor(private readonly cfg: PaypalConfig) {
    if (cfg.baseUrl !== undefined && cfg.baseUrl !== SANDBOX_BASE_URL) {
      throw new Error(`PayPal base URL must be ${SANDBOX_BASE_URL} (Sandbox only), got ${cfg.baseUrl}`);
    }
    if (!cfg.clientId || !cfg.clientSecret) throw new Error("PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET must be set (Sandbox app keys)");
    this.timeoutMs = cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  static fromEnv(env: Record<string, string | undefined> = process.env, opts: { timeoutMs?: number } = {}): PaypalClient {
    return new PaypalClient({
      clientId: env.PAYPAL_CLIENT_ID ?? "",
      clientSecret: env.PAYPAL_CLIENT_SECRET ?? "",
      baseUrl: env.PAYPAL_BASE_URL || undefined, // unset or empty is fine; any other value than the Sandbox URL throws
      timeoutMs: opts.timeoutMs,
    });
  }

  async accessToken(): Promise<string> {
    if (this.tokenCache && this.tokenCache.expiresAt > Date.now() + 60_000) return this.tokenCache.value;
    this.tokenInFlight ??= this.fetchToken().finally(() => (this.tokenInFlight = undefined));
    return this.tokenInFlight;
  }

  private async fetchToken(): Promise<string> {
    const basic = Buffer.from(`${this.cfg.clientId}:${this.cfg.clientSecret}`).toString("base64");
    const res = await fetch(`${this.baseUrl}/v1/oauth2/token`, {
      method: "POST",
      headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: "grant_type=client_credentials",
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const json = (await res.json().catch(() => undefined)) as { access_token?: string; expires_in?: number } | undefined;
    if (!res.ok || !json?.access_token) throw new PaypalError("oauth token", res.status, res.headers.get("paypal-debug-id") ?? undefined, json);
    this.tokenCache = { value: json.access_token, expiresAt: Date.now() + (json.expires_in ?? 300) * 1000 };
    return json.access_token;
  }

  async request<T>(step: string, method: "GET" | "POST" | "PATCH" | "DELETE", path: string, opts: RequestOptions = {}): Promise<T> {
    const headers: Record<string, string> = { Authorization: `Bearer ${await this.accessToken()}` };
    if (opts.body !== undefined) headers["Content-Type"] = "application/json";
    if (method === "POST") headers["PayPal-Request-Id"] = opts.requestId ?? randomUUID();
    if (opts.prefer) headers.Prefer = "return=representation";
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: AbortSignal.timeout(opts.timeoutMs ?? this.timeoutMs),
    });
    const text = await res.text();
    let json: unknown = text || undefined;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      // keep the raw text in the error body
    }
    if (!res.ok) throw new PaypalError(step, res.status, res.headers.get("paypal-debug-id") ?? undefined, json);
    return json as T;
  }

  // POST /v1/notifications/verify-webhook-signature. Returns PayPal's verification_status as sent ("SUCCESS", "FAILURE", ...).
  // webhookEvent is the parsed delivery body. Throws PaypalError on any non-2xx answer; the caller decides what that means.
  async verifyWebhookSignature(p: VerifyParams, timeoutMs?: number): Promise<string | undefined> {
    const r = await this.request<{ verification_status?: string }>("verify webhook signature", "POST", "/v1/notifications/verify-webhook-signature", {
      timeoutMs,
      body: {
        auth_algo: p.authAlgo,
        cert_url: p.certUrl,
        transmission_id: p.transmissionId,
        transmission_sig: p.transmissionSig,
        transmission_time: p.transmissionTime,
        webhook_id: p.webhookId,
        webhook_event: p.webhookEvent,
      },
    });
    return r?.verification_status;
  }
}
