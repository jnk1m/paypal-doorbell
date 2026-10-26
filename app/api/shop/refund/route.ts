// POST {captureId}: refund one of this session's orders in full. A capture that is not this session's gets the same 403 as any other.
import { readJson, requireLiveToken, requireSameOrigin, requireSession, sessionIdOf } from "../../../../lib/shop/api.ts";
import { shopApiFromEnv } from "../../../../lib/shop/config.ts";
import { refundOrder } from "../../../../lib/shop/orders.ts";
import { HttpError, enforceLimit, handle, json } from "../../../../lib/web/http.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export function POST(req: Request): Promise<Response> {
  return handle("api/shop/refund", async () => {
    const { store, client, liveToken } = shopApiFromEnv();
    requireSameOrigin(req);
    requireLiveToken(req, liveToken);
    await enforceLimit("refund", req, sessionIdOf(req)); // a refund is a PayPal call that moves test money
    const { sid } = await requireSession(req, store);
    const { captureId } = await readJson(req);
    if (typeof captureId !== "string" || !/^[A-Za-z0-9_-]{10,40}$/.test(captureId)) throw new HttpError(400, "Bad request.", { reason: "malformed capture id" });
    return json({ order: await refundOrder(client, store, sid, captureId, Date.now()) }, 201);
  });
}
