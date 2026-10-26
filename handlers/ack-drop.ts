// Maple Mug webhook handler. PayPal posts here when a payment is captured or refunded.
import type { Handler } from "../lib/shop/types.ts";

export const SOURCE = import.meta.url;

export const handleWebhook: Handler = async (ctx) => {
  const event = JSON.parse(ctx.rawBody);
  if ((await ctx.verify(event)) !== "SUCCESS") return { status: 401 };

  // Acknowledge first, book later.
  queue.push(event);
  return { status: 200 };
};

const queue: unknown[] = [];
