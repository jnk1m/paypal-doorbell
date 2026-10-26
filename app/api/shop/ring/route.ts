// POST {captureId}: Ring again for one order of this session. The client names the order and nothing else; which event is resent, whether
// it is listed, whether PayPal's own retries are pending and how many resends are left are all decided on the server. An order that is
// not this session's gets the same 403 as any other forbidden request, and nothing is read from or sent to PayPal for it.
import { readJson, requireLiveToken, requireSameOrigin, requireSession, sessionIdOf } from "../../../../lib/shop/api.ts";
import { gapsFromEnv, shopApiFromEnv } from "../../../../lib/shop/config.ts";
import { ringAgain } from "../../../../lib/gaps/ring.ts";
import { HttpError, enforceLimit, handle, json } from "../../../../lib/web/http.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export function POST(req: Request): Promise<Response> {
  return handle("api/shop/ring", async () => {
    const { store, liveToken } = shopApiFromEnv();
    requireSameOrigin(req);
    requireLiveToken(req, liveToken);
    const given = sessionIdOf(req);
    await enforceLimit("ring", req, given); // every press, sent or not: it reads Redis and PayPal. The press has its own per-session bucket ...
    const { sid, mode, at } = await requireSession(req, store);
    const { captureId } = await readJson(req);
    if (typeof captureId !== "string" || !/^[A-Za-z0-9_-]{10,40}$/.test(captureId)) throw new HttpError(400, "Bad request.", { reason: "malformed capture id" });
    // ... and only a resend that is really about to be sent counts against the pool that refunds and resends share (plan 9.6), so presses that
    // are refused ("not listed yet", "retries pending", the session's five used) cannot drain it.
    return json(await ringAgain(gapsFromEnv(), sid, { mode, at }, captureId, { beforeSend: () => enforceLimit("refund", req, sid) }));
  });
}
