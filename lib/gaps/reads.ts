// What the gap finder asks PayPal (R3, R5). Everything goes through PaypalClient, which only talks to the Sandbox. An id from anywhere
// else (an event list, a stored record) is checked against a strict pattern before it becomes part of a URL path (plan 9.1).
import type { PaypalClient } from "../pay/paypal.ts";
import { bookingOf, COMPLETED, REFUNDED } from "../shop/events.ts";

export const RESOURCE_ID = /^[A-Za-z0-9_-]{10,40}$/;
export const EVENT_ID = /^WH-[A-Za-z0-9-]{8,80}$/;
export const WEBHOOK_ID = /^[A-Za-z0-9]{10,30}$/;

// An event as PayPal's list shows it.
export interface ListedEvent {
  eid: string;
  type: string;
  createTime: number; // ms
  resourceId: string; // the capture for COMPLETED, the refund for REFUNDED
  captureId: string;
}

export interface PaypalReads {
  capture(id: string, timeoutMs: number): Promise<{ status: string }>;
  refund(id: string, timeoutMs: number): Promise<{ status: string }>;
  // PAYMENT.CAPTURE.COMPLETED and PAYMENT.CAPTURE.REFUNDED events created since `sinceMs`, newest first. Throws when any page cannot be read.
  listedEvents(sinceMs: number, timeoutMs: number): Promise<ListedEvent[]>;
  subscribedTypes(webhookId: string, timeoutMs: number): Promise<string[]>;
  resend(eventId: string, webhookId: string, timeoutMs: number): Promise<void>;
}

const LIST_HOSTS = new Set(["api.sandbox.paypal.com", "api-m.sandbox.paypal.com"]);
const LIST_PATH = "/v1/notifications/webhooks-events";
export const MAX_PAGES = 5;

// The next page's path and query from a list response, or null at the end. The link PayPal sends names the other Sandbox host
// (api.sandbox.paypal.com); the request is made to our own fixed base (the token goes with it), so the host is only checked, never followed.
export function nextPagePath(links: unknown): string | null {
  const next = Array.isArray(links) ? (links as { rel?: unknown; href?: unknown }[]).find((l) => l?.rel === "next") : undefined;
  if (typeof next?.href !== "string") return null;
  let url: URL;
  try {
    url = new URL(next.href);
  } catch {
    throw new Error("the event list's next link is not a URL");
  }
  if (url.protocol !== "https:" || !LIST_HOSTS.has(url.host) || url.username || url.password || !url.pathname.startsWith(LIST_PATH)) {
    throw new Error(`the event list's next link points somewhere else (${url.host.slice(0, 60)})`);
  }
  return `${url.pathname}${url.search}`;
}

export function listedOf(entry: unknown): ListedEvent | null {
  const e = entry as { id?: unknown; create_time?: unknown } | null;
  const booking = bookingOf(entry);
  const createTime = typeof e?.create_time === "string" ? Date.parse(e.create_time) : NaN;
  if (!booking || typeof e?.id !== "string" || !EVENT_ID.test(e.id) || Number.isNaN(createTime)) return null;
  return { eid: e.id, type: booking.type, createTime, resourceId: booking.resourceId, captureId: booking.captureId };
}

const isoSeconds = (ms: number) => new Date(ms).toISOString().replace(/\.\d+Z$/, "Z");
const SUBSCRIPTION_TTL_MS = 60_000;

export class PaypalClientReads implements PaypalReads {
  private readonly subscriptions = new Map<string, { at: number; types: string[] }>();

  constructor(
    private readonly client: PaypalClient,
    private readonly now: () => number = Date.now,
  ) {}

  async capture(id: string, timeoutMs: number): Promise<{ status: string }> {
    if (!RESOURCE_ID.test(id)) throw new Error("capture id is malformed");
    const c = await this.client.request<{ status?: string }>("get capture", "GET", `/v2/payments/captures/${id}`, { timeoutMs });
    if (typeof c?.status !== "string") throw new Error("get capture: the answer has no status");
    return { status: c.status };
  }

  async refund(id: string, timeoutMs: number): Promise<{ status: string }> {
    if (!RESOURCE_ID.test(id)) throw new Error("refund id is malformed");
    const r = await this.client.request<{ status?: string }>("get refund", "GET", `/v2/payments/refunds/${id}`, { timeoutMs });
    if (typeof r?.status !== "string") throw new Error("get refund: the answer has no status");
    return { status: r.status };
  }

  async listedEvents(sinceMs: number, timeoutMs: number): Promise<ListedEvent[]> {
    const since = isoSeconds(sinceMs);
    const pages = await Promise.all(
      [COMPLETED, REFUNDED].map(async (type) => {
        const found: ListedEvent[] = [];
        let path: string | null = `/v1/notifications/webhooks-events?page_size=100&start_time=${since}&event_type=${type}`;
        for (let page = 0; path; page++) {
          if (page >= MAX_PAGES) throw new Error(`the event list for ${type} has more than ${MAX_PAGES} pages`);
          const r: { events?: unknown[]; links?: unknown } = await this.client.request("list webhook events", "GET", path, { timeoutMs });
          for (const entry of r.events ?? []) {
            const listed = listedOf(entry);
            if (listed) found.push(listed);
          }
          path = nextPagePath(r.links);
        }
        return found;
      }),
    );
    return pages.flat();
  }

  async subscribedTypes(webhookId: string, timeoutMs: number): Promise<string[]> {
    if (!WEBHOOK_ID.test(webhookId)) throw new Error("webhook id is malformed");
    const cached = this.subscriptions.get(webhookId);
    if (cached && this.now() - cached.at < SUBSCRIPTION_TTL_MS) return cached.types;
    const w = await this.client.request<{ event_types?: { name?: unknown }[] }>("get webhook", "GET", `/v1/notifications/webhooks/${webhookId}`, { timeoutMs });
    const types = (w.event_types ?? []).map((t) => t.name).filter((n): n is string => typeof n === "string");
    this.subscriptions.set(webhookId, { at: this.now(), types });
    return types;
  }

  async resend(eventId: string, webhookId: string, timeoutMs: number): Promise<void> {
    if (!EVENT_ID.test(eventId)) throw new Error("event id is malformed");
    if (!WEBHOOK_ID.test(webhookId)) throw new Error("webhook id is malformed");
    await this.client.request("resend event", "POST", `/v1/notifications/webhooks-events/${eventId}/resend`, { body: { webhook_ids: [webhookId] }, timeoutMs });
  }
}
