// POST: start a shop session (128 random bits, mode "good"). The live shop is closed unless the caller holds the live token.
import { randomBytes } from "node:crypto";
import { newSessionId, requireLiveToken, requireSameOrigin } from "../../../../lib/shop/api.ts";
import { shopApiFromEnv } from "../../../../lib/shop/config.ts";
import { enforceLimit, handle, json } from "../../../../lib/web/http.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 10;

export function POST(req: Request): Promise<Response> {
  return handle("api/shop/session", async () => {
    const { store, liveToken } = shopApiFromEnv();
    requireSameOrigin(req);
    requireLiveToken(req, liveToken);
    await enforceLimit("session", req); // plan 9.6: making a session is the cheapest way round every per-session limit, so it has its own
    const sid = newSessionId(randomBytes(16));
    await store.createSession(sid, "good", Date.now());
    return json({ session: sid, mode: "good" }, 201);
  });
}
