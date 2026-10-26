// POST: the judge lane's snapshot. One call that gives the screen what it renders for the session (the shape in lib/run/snapshot.ts, mode
// "LIVE"): the session view, the scan, the certificate, the witness heartbeat and, for each gap that a planted handler explains, the cause
// and the replay. The page's poll may call this instead of /api/shop/scan; both are kept and count on the same limit.
//
// The order of the guards is the order of their cost: same origin and the live token (memory), then the 2 s coalescer (a repeat inside 2 s
// is answered from the one computation and costs nothing), then the hourly and burst limit (memory first, Redis only for what passes it),
// then the session (Redis), then the work. The answer is per session and never cached.
import { requireLiveToken, requireSameOrigin, requireSession, sessionIdOf } from "../../../../lib/shop/api.ts";
import { shopApiFromEnv } from "../../../../lib/shop/config.ts";
import { buildLiveSnapshot } from "../../../../lib/run/build.ts";
import { createCoalescer } from "../../../../lib/run/coalesce.ts";
import { replayLimit, snapshotFromEnv } from "../../../../lib/run/config.ts";
import type { RunSnapshot } from "../../../../lib/run/snapshot.ts";
import { enforceLimit, handle, json } from "../../../../lib/web/http.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const coalescer = createCoalescer<RunSnapshot>({ windowMs: 2000 });

export function POST(req: Request): Promise<Response> {
  return handle("api/shop/snapshot", async () => {
    const { store, liveToken } = shopApiFromEnv();
    requireSameOrigin(req);
    requireLiveToken(req, liveToken);
    const sid = sessionIdOf(req);
    const snapshot = await coalescer.run(sid, async () => {
      await enforceLimit("scan", req, sid);
      const { mode, at } = await requireSession(req, store);
      return buildLiveSnapshot(snapshotFromEnv(), sid, { mode, at }, replayLimit(req, sid));
    });
    return json(snapshot);
  });
}
