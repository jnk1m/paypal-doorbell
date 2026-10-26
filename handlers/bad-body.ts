// Maple Mug webhook handler. PayPal posts here when a payment is captured or refunded.
import { bookingOf, rank } from "../lib/shop/events.ts";
import type { Handler } from "../lib/shop/types.ts";

export const SOURCE = import.meta.url;

export const handleWebhook: Handler = async (ctx) => {
  const event = canonical(JSON.parse(ctx.rawBody));
  if ((await ctx.verify(event)) !== "SUCCESS") return { status: 401 };

  const booking = bookingOf(event);
  if (!booking) return { status: 200 };

  // Never move an order backwards: a late "paid" must not undo a "refunded".
  const current = await ctx.books.get(booking.captureId);
  if (current && rank(current.state) > rank(booking.state)) return { status: 200 };

  await ctx.books.set(booking.captureId, { state: booking.state, amount: booking.amount, eid: event.id, at: ctx.now() });
  return { status: 200 };
};

// The same value with its object keys in alphabetical order, so that every copy of an event looks alike.
function canonical(value: any): any {
  if (Array.isArray(value)) return value.map(canonical);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}
