// Helpers for tests that talk to the real Upstash database.
import type { Redis } from "@upstash/redis";

// Every Redis key a test writes starts with this, so a cleanup can never touch real keys.
export const TEST_PREFIX = "db:test:";

export async function deleteByPrefix(redis: Redis, prefix: string): Promise<number> {
  if (!prefix.startsWith(TEST_PREFIX)) throw new Error(`refusing to delete keys under "${prefix}": test keys start with "${TEST_PREFIX}"`);
  let deleted = 0;
  let cursor: string | number = 0;
  do {
    const [next, keys]: [string, string[]] = await redis.scan(cursor, { match: `${prefix}*`, count: 200 });
    if (keys.length) deleted += await redis.del(...keys);
    cursor = next;
  } while (String(cursor) !== "0");
  return deleted;
}
