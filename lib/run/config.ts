// Wires the live snapshot to the environment (the shop's store and PayPal reads from lib/shop/config.ts, the witness's stored deliveries,
// PayPal's verify endpoint for the replay, the build-time diffs and the recorded replay results). Built once per server instance.
// Nothing here is read by the recorded run: lib/run/recorded.ts imports static JSON and touches no environment.
import { checkLimit } from "../limits.ts";
import recordedReplays from "../../fixtures/replay/recorded.json" with { type: "json" };
import type { RecordedReplays, ReplayResult, VerifyFn } from "../cause/replay.ts";
import { gapsFromEnv, shopApiFromEnv } from "../shop/config.ts";
import { diffBundle } from "../shop/diff-bundle.ts";
import { clientIp } from "../web/http.ts";
import { witnessFromEnv } from "../witness/config.ts";
import type { AttemptEntry } from "../witness/store.ts";
import type { ReplayDeps, SnapshotDeps, SnapshotOptions } from "./build.ts";

const REPLAY_VERIFY_TIMEOUT_MS = 6_000;
const replays = new Map<string, ReplayResult>(); // per instance: a replay done once is not done again at the next poll
const replaysRunning = new Map<string, Promise<ReplayResult | null>>(); // ... and one that is running is waited for

// Which webhook a stored delivery was signed for: the slot says it (D is the demo app's witness, D-dev the dev app's; plan 9.10).
function webhookIdOf(entry: AttemptEntry): string | undefined {
  if (entry.slot === "D") return process.env.PAYPAL_WITNESS_WEBHOOK_ID;
  if (entry.slot === "D-dev") return process.env.PAYPAL_WITNESS_DEV_WEBHOOK_ID;
  return undefined;
}

let deps: SnapshotDeps | undefined;
export function snapshotFromEnv(): SnapshotDeps {
  if (deps) return deps;
  const replay: ReplayDeps = {
    witness: () => witnessFromEnv().store,
    webhookIdOf,
    verify: ((p) => shopApiFromEnv().client.verifyWebhookSignature(p, REPLAY_VERIFY_TIMEOUT_MS)) as VerifyFn,
    cache: replays,
    inflight: replaysRunning,
  };
  deps = {
    scan: gapsFromEnv(),
    bundle: diffBundle,
    recordedReplays: recordedReplays as unknown as RecordedReplays,
    replay,
    log: (line) => console.log(JSON.stringify({ route: "snapshot", ...line })),
  };
  return deps;
}

// The replay limiter (R13): a live replay is 2 x N verify calls to PayPal. A limiter (Redis) error is not caught here: it ends the request,
// as it does everywhere else, rather than letting a replay run unchecked.
export function replayLimit(req: Request, sid: string): SnapshotOptions {
  return { allowReplay: async () => (await checkLimit("replay", { ip: clientIp(req), session: sid })).ok };
}
