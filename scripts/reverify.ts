// Re-verifies the witness's quarantine ring against the real PayPal Sandbox (one verify call per entry, within the 60 per minute budget).
// A scan or heartbeat will call the same function in the product; this is the manual trigger.
//   npx tsx scripts/reverify.ts [max entries, default 25]
import { PaypalClient } from "../lib/pay/paypal.ts";
import { redisFromEnv } from "../lib/redis.ts";
import { VERIFY_BUDGET_PER_MINUTE } from "../lib/witness/config.ts";
import { reverifyQuarantined } from "../lib/witness/receive.ts";
import { RedisWitnessStore } from "../lib/witness/store.ts";
import { loadEnv, loadRedisEnv } from "./env.ts";

loadEnv();
loadRedisEnv();
const redis = redisFromEnv();
const webhookId = process.env.PAYPAL_WITNESS_WEBHOOK_ID;
if (!redis || !webhookId) throw new Error("needs Upstash settings and PAYPAL_WITNESS_WEBHOOK_ID");
const client = PaypalClient.fromEnv();
const store = new RedisWitnessStore(redis, { prefix: "db:", budgetPerMinute: VERIFY_BUDGET_PER_MINUTE });
const before = (await store.listQuarantined(10_000)).length;
const result = await reverifyQuarantined({ webhookId, verify: (p) => client.verifyWebhookSignature(p), store }, { max: Number(process.argv[2] ?? 25) });
console.log(`quarantine ring before ${before}, after ${(await store.listQuarantined(10_000)).length}`);
console.log(JSON.stringify(result));
