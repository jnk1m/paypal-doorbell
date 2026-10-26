// POST {mode}: choose which handler file the shop's webhook runs for this session, from the next delivery on.
import { readJson, requireLiveToken, requireModeAvailable, requireSameOrigin, requireSession, sessionIdOf } from "../../../../lib/shop/api.ts";
import { settingWebhookIdFromEnv, shopApiFromEnv } from "../../../../lib/shop/config.ts";
import { MODE_FILE, PLANTED_LABEL } from "../../../../lib/shop/modes.ts";
import { isBroken, isMode } from "../../../../lib/shop/types.ts";
import { HttpError, enforceLimit, handle, json } from "../../../../lib/web/http.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 10;

export function POST(req: Request): Promise<Response> {
  return handle("api/shop/mode", async () => {
    const { store, liveToken } = shopApiFromEnv();
    requireSameOrigin(req);
    requireLiveToken(req, liveToken);
    await enforceLimit("mode", req, sessionIdOf(req)); // a Redis write: limited before any Redis work
    const { sid } = await requireSession(req, store);
    const { mode } = await readJson(req);
    if (!isMode(mode)) throw new HttpError(400, "Bad request.", { reason: "mode out of range" });
    requireModeAvailable(mode, settingWebhookIdFromEnv());
    if (!(await store.setMode(sid, mode))) throw new HttpError(404, "Not found.", { reason: "session expired" });
    return json({ mode, file: MODE_FILE[mode], planted: isBroken(mode), label: isBroken(mode) ? PLANTED_LABEL : null });
  });
}
