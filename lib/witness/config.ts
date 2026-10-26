// Wires the receiver to the environment: the Sandbox client, the Upstash database and the witness webhook's id.
import { PaypalClient } from "../pay/paypal.ts";
import { redisFromEnv } from "../redis.ts";
import type { WitnessDeps } from "./receive.ts";
import { RedisWitnessStore } from "./store.ts";

export const KEY_PREFIX = "db:";
export const VERIFY_BUDGET_PER_MINUTE = 60;
// The verify call and the token request each get this long. Past it the delivery is quarantined, so PayPal still gets its 200.
const PAYPAL_TIMEOUT_MS = 3000;
const WEBHOOK_ID = /^[A-Za-z0-9]{10,30}$/;

let shared: WitnessDeps | undefined;

// Built once per server instance so the access token and the Redis client are reused between deliveries.
export function witnessFromEnv(): WitnessDeps {
  if (shared) return shared;
  const webhookId = process.env.PAYPAL_WITNESS_WEBHOOK_ID;
  if (!webhookId) throw new Error("PAYPAL_WITNESS_WEBHOOK_ID is not set: the witness cannot verify deliveries without its webhook id");
  const redis = redisFromEnv();
  if (!redis) throw new Error("KV_REST_API_URL and KV_REST_API_TOKEN are not set: the witness record needs Upstash");
  const client = PaypalClient.fromEnv(process.env, { timeoutMs: PAYPAL_TIMEOUT_MS });
  // The other Sandbox app's witness webhook may deliver to the same URL (the dev app's, while the demo app's is D). Verify is not tied to the app.
  const devId = process.env.PAYPAL_WITNESS_DEV_WEBHOOK_ID;
  if (devId && !WEBHOOK_ID.test(devId)) throw new Error("PAYPAL_WITNESS_DEV_WEBHOOK_ID is malformed");
  shared = {
    webhookId,
    extraTargets: devId ? [{ slot: "D-dev", webhookId: devId }] : undefined,
    verify: (p) => client.verifyWebhookSignature(p, PAYPAL_TIMEOUT_MS),
    store: new RedisWitnessStore(redis, { prefix: KEY_PREFIX, budgetPerMinute: VERIFY_BUDGET_PER_MINUTE }),
  };
  return shared;
}
