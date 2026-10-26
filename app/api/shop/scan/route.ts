// POST: scan the session. The page's polling calls this (there is no cron and no background work): it re-queries PayPal by id, compares
// with the books and with who heard what, classifies every difference, moves "Ring again" records along and re-verifies the witness
// quarantine. POST + the live token + same origin + the session header; the answer is per session and never cached.
import { requireLiveToken, requireSameOrigin, requireSession, sessionIdOf } from "../../../../lib/shop/api.ts";
import { gapsFromEnv, shopApiFromEnv } from "../../../../lib/shop/config.ts";
import { scanSession } from "../../../../lib/gaps/scan.ts";
import { enforceLimit, handle, json } from "../../../../lib/web/http.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export function POST(req: Request): Promise<Response> {
  return handle("api/shop/scan", async () => {
    const { store, liveToken } = shopApiFromEnv();
    requireSameOrigin(req);
    requireLiveToken(req, liveToken);
    await enforceLimit("scan", req, sessionIdOf(req)); // before anything is read: a request that is refused costs no Redis command
    const { sid, mode, at } = await requireSession(req, store);
    return json(await scanSession(gapsFromEnv(), sid, { mode, at }));
  });
}
