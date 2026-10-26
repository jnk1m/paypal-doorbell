// What the shop reads out of a PayPal event: which order (capture) it is about, and whether it says paid or refunded.
// Pure functions. The ids end up in Redis keys, so every id is checked against a strict pattern first.
import type { BookState } from "./types.ts";

export const COMPLETED = "PAYMENT.CAPTURE.COMPLETED";
export const REFUNDED = "PAYMENT.CAPTURE.REFUNDED";

// The two event types the shop webhook (S) subscribes to.
export const SHOP_EVENT_TYPES = [COMPLETED, REFUNDED] as const;

const ID = /^[A-Za-z0-9_-]{10,40}$/;
const CAPTURE_LINK = /\/v2\/payments\/captures\/([A-Za-z0-9_-]{10,40})$/;

export interface Booking {
  captureId: string; // the order this event is about
  resourceId: string; // the id of the event's own resource: the capture for COMPLETED, the refund for REFUNDED
  type: string;
  state: BookState;
  amount: string;
}

export const rank = (state: BookState): number => (state === "paid" ? 1 : 2);

interface Resource {
  id?: unknown;
  amount?: { value?: unknown };
  links?: { rel?: unknown; href?: unknown }[];
}

// Undefined for any event the shop does not book (other types, or a shape that does not carry what is needed).
export function bookingOf(event: unknown): Booking | undefined {
  const e = event as { event_type?: unknown; resource?: Resource } | null;
  const resource = e?.resource;
  if (!resource || typeof resource.id !== "string" || !ID.test(resource.id)) return undefined;
  const value = resource.amount?.value;
  if (typeof value !== "string" || !/^\d{1,9}\.\d{2}$/.test(value)) return undefined;

  if (e?.event_type === COMPLETED) {
    return { captureId: resource.id, resourceId: resource.id, type: COMPLETED, state: "paid", amount: value };
  }
  if (e?.event_type === REFUNDED) {
    // A refund event names its capture through the link with rel "up".
    const up = resource.links?.find((l) => l.rel === "up");
    const captureId = typeof up?.href === "string" ? CAPTURE_LINK.exec(up.href)?.[1] : undefined;
    if (!captureId) return undefined;
    return { captureId, resourceId: resource.id, type: REFUNDED, state: "refunded", amount: value };
  }
  return undefined;
}
