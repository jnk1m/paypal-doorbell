// GET: what the recorded cause step answers for each broken mode, read the same way the snapshot reads it. No session, no PayPal, no
// Redis, no model: it only shows whether the deployed function finds its recordings (the cause files under fixtures/recordings/ that
// next.config.ts ships with the shop's routes). A deploy where this says "no_recording" would show every cause as "not diagnosed".
// The live token is required like everywhere else on the live shop.
import { diagnose } from "../../../../../lib/cause/cause.ts";
import { symptomClassOf } from "../../../../../lib/cause/categories.ts";
import { hasRecordings } from "../../../../../lib/core/llm.ts";
import { deployInput } from "../../../../../lib/run/deploy-input.ts";
import { CAUSE_RECORDINGS_DIR } from "../../../../../lib/run/recordings.ts";
import { requireLiveToken } from "../../../../../lib/shop/api.ts";
import { diffBundle } from "../../../../../lib/shop/diff-bundle.ts";
import type { BrokenMode } from "../../../../../lib/shop/types.ts";
import { handle, json } from "../../../../../lib/web/http.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 10;

// The symptom class each broken mode produces in the shop's delivery record (all 401, or 2xx with the books unchanged).
const SYMPTOM_OF: Record<BrokenMode, Parameters<typeof symptomClassOf>[0]> = {
  bad_body: [{ tid: "t", attempt: "a", state: "responded", status: 401 }],
  wrong_webhook_id_setting: [{ tid: "t", attempt: "a", state: "responded", status: 401 }],
  ack_then_drop: [{ tid: "t", attempt: "a", state: "responded", status: 200 }],
  last_write_wins: [{ tid: "t", attempt: "a", state: "responded", status: 200 }],
};

export function GET(req: Request): Promise<Response> {
  return handle("api/shop/snapshot/causes", async () => {
    requireLiveToken(req, process.env.DOORBELL_LIVE_TOKEN); // no Redis and no PayPal client are built for this route
    const modes: Record<string, unknown> = {};
    for (const mode of Object.keys(SYMPTOM_OF) as BrokenMode[]) {
      const r = await diagnose(deployInput(mode, diffBundle, symptomClassOf(SYMPTOM_OF[mode])), { mode: "replay", onMiss: "none", dir: CAUSE_RECORDINGS_DIR, log: () => undefined });
      modes[mode] = r.status === "proposed" ? { status: r.status, category: r.category, source: r.source } : r.status === "not_proven" ? { status: r.status, reason: r.reason } : { status: r.status, reason: r.reason };
    }
    return json({ recordingsFound: hasRecordings(CAUSE_RECORDINGS_DIR), dir: "fixtures/recordings/", modes });
  });
}
