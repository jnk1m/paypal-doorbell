// GET: the session's orders, books and per-event chips for the stamp screen. About 7 Redis commands a call, so it is a poll like the scan and
// counts on the same limit (kind "scan"); the origin and the token are checked first and the limit before any Redis read.
import { requireLiveToken, requireSameOrigin, requireSession, sessionIdOf } from "../../../../lib/shop/api.ts";
import { shopApiFromEnv } from "../../../../lib/shop/config.ts";
import { buildView } from "../../../../lib/shop/view.ts";
import { enforceLimit, handle, json } from "../../../../lib/web/http.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 10;

export function GET(req: Request): Promise<Response> {
  return handle("api/shop/state", async () => {
    const { store, liveToken } = shopApiFromEnv();
    requireSameOrigin(req);
    requireLiveToken(req, liveToken);
    await enforceLimit("scan", req, sessionIdOf(req));
    const { sid, mode, at } = await requireSession(req, store);
    return json(await buildView(store, sid, { mode, at }, Date.now()));
  });
}
