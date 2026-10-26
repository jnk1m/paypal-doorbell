// POST {item}: buy one item. The price is the server's; the order completes at once with the Sandbox test card.
import { readJson, requireLiveToken, requireSameOrigin, requireSession, sessionIdOf } from "../../../../lib/shop/api.ts";
import { isItemId } from "../../../../lib/shop/catalog.ts";
import { shopApiFromEnv } from "../../../../lib/shop/config.ts";
import { createOrder } from "../../../../lib/shop/orders.ts";
import { HttpError, enforceLimit, handle, json } from "../../../../lib/web/http.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export function POST(req: Request): Promise<Response> {
  return handle("api/shop/order", async () => {
    const { store, client, liveToken } = shopApiFromEnv();
    requireSameOrigin(req);
    requireLiveToken(req, liveToken);
    await enforceLimit("order", req, sessionIdOf(req)); // an order is a PayPal call that moves test money
    const { sid } = await requireSession(req, store);
    const { item } = await readJson(req);
    if (!isItemId(item)) throw new HttpError(400, "Bad request.", { reason: "unknown item" });
    return json({ order: await createOrder(client, store, sid, item, Date.now()) }, 201);
  });
}
