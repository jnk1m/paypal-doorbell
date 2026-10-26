// Real Upstash. Not part of `npm test`. Run: REDIS_ENV_FILE=/path/to/.env.vercel npm run test:redis
// Every key lives under db:test:<run>: and is deleted at the end.
import { randomUUID } from "node:crypto";
import { after } from "node:test";
import { redisFromEnv } from "../redis.ts";
import { deleteByPrefix, TEST_PREFIX } from "../test-redis.ts";
import { storeContract } from "./store.contract.ts";
import { RedisWitnessStore } from "./store.ts";

for (const file of [process.env.PAYPAL_ENV_FILE, process.env.REDIS_ENV_FILE]) if (file) process.loadEnvFile(file);
const redis = redisFromEnv();
if (!redis) throw new Error("missing env: KV_REST_API_URL, KV_REST_API_TOKEN. Load the Upstash .env.vercel first (see header).");

const prefix = `${TEST_PREFIX}${randomUUID().slice(0, 8)}:store:`;
after(async () => console.log(`cleanup: deleted ${await deleteByPrefix(redis, prefix)} keys under ${prefix}`));

// One prefix for the whole file, so each contract test needs a fresh sub-prefix.
let n = 0;
storeContract(async (opts) => ({ store: new RedisWitnessStore(redis, { prefix: `${prefix}${n++}:`, ...opts }), done: async () => {} }));
