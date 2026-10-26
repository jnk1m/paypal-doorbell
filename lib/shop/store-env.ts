// The shop's store from the environment, in a file of its own so that the witness route can use it without pulling in the rest of the shop.
import { redisFromEnv } from "../redis.ts";
import { RedisShopStore } from "./store.ts";

export const KEY_PREFIX = "db:";

let store: RedisShopStore | undefined;
export function shopStoreFromEnv(): RedisShopStore {
  if (store) return store;
  const redis = redisFromEnv();
  if (!redis) throw new Error("KV_REST_API_URL and KV_REST_API_TOKEN are not set: the shop's state needs Upstash");
  store = new RedisShopStore(redis, KEY_PREFIX);
  return store;
}
