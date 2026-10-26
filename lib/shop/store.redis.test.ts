// Real Upstash. Not part of `npm test`. Run: REDIS_ENV_FILE=/path/to/.env.vercel npm run test:redis
// Every key lives under db:test:<run>: and is deleted at the end.
import { randomUUID } from "node:crypto";
import { after } from "node:test";
import { redisFromEnv } from "../redis.ts";
import { deleteByPrefix, TEST_PREFIX } from "../test-redis.ts";
import { shopStoreContract } from "./store.contract.ts";
import { RedisShopStore } from "./store.ts";

for (const file of [process.env.PAYPAL_ENV_FILE, process.env.REDIS_ENV_FILE]) if (file) process.loadEnvFile(file);
const redis = redisFromEnv();
if (!redis) throw new Error("missing env: KV_REST_API_URL, KV_REST_API_TOKEN. Load the Upstash .env.vercel first (see header).");

const prefix = `${TEST_PREFIX}${randomUUID().slice(0, 8)}:shop:`;
after(async () => console.log(`cleanup: deleted ${await deleteByPrefix(redis, prefix)} keys under ${prefix}`));

// Each test gets its own sub-prefix, so ids from one test cannot meet another's.
let n = 0;
shopStoreContract(async () => ({ store: new RedisShopStore(redis, `${prefix}${n++}:`), done: async () => {} }));
