// Used by reporter.redis.test.ts: handles one delivery against real Redis and dies (SIGKILL) inside the handler, the way a serverless
// function that is killed does, so the test can read what the reporter had written by then. Not a test itself and not part of the app.
//   argv[2] = JSON { prefix, raw, headers }
import { redisFromEnv } from "../redis.ts";
import { InProcessReporter } from "./reporter.ts";
import { RedisShopStore } from "./store.ts";
import { SHOP_WEBHOOK_ID } from "./test-helpers.ts";
import { handleShopDelivery } from "./webhook.ts";

for (const file of [process.env.PAYPAL_ENV_FILE, process.env.REDIS_ENV_FILE]) if (file) process.loadEnvFile(file);
const { prefix, raw, headers } = JSON.parse(process.argv[2]) as { prefix: string; raw: string; headers: Record<string, string> };
const redis = redisFromEnv();
if (!redis) throw new Error("crash-child: Redis is not configured");
const store = new RedisShopStore(redis, prefix);

await handleShopDelivery(new Request("https://doorbell.test/api/shop/webhook", { method: "POST", headers, body: raw }), {
  webhookId: SHOP_WEBHOOK_ID,
  store,
  reporter: new InProcessReporter(store),
  // The handler asks PayPal to verify the delivery. This process dies at that point.
  verify: async () => process.kill(process.pid, "SIGKILL") as never,
});
console.error("crash-child: the delivery was handled, the process was supposed to die"); // reaching this line is a test failure
process.exit(3);
