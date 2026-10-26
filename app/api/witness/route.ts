// The witness webhook endpoint. Keep this import graph small and free of `ai`, @ai-sdk and the PayPal toolkit (it is a test).
import { noteWhatWitnessHeard } from "../../../lib/shop/heard.ts";
import { shopStoreFromEnv } from "../../../lib/shop/store-env.ts";
import { handle } from "../../../lib/web/http.ts";
import { witnessFromEnv } from "../../../lib/witness/config.ts";
import { receiveDelivery, type WitnessDeps } from "../../../lib/witness/receive.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 10;

// The witness, plus the one thing the demo shop needs from it: a note of which shop events it heard.
let deps: WitnessDeps | undefined;
const witness = (): WitnessDeps => (deps ??= { ...witnessFromEnv(), onVerified: noteWhatWitnessHeard(shopStoreFromEnv()) });

export function POST(req: Request): Promise<Response> {
  return handle("api/witness", () => receiveDelivery(req, witness()));
}
