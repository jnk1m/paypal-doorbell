// The money budget for live model calls (R13, plan 9.14): a hard cap per UTC day, counted in money (from the tokens the API reports),
// not in calls. Before a live call, reserve its worst case (llm.ts worstCaseUsd: from the request's own size, never a flat guess);
// afterwards settle to what it really cost, or release the whole reservation when nothing was billed. When the day's cap would be
// passed by the reservation, reserve() says no and the caller makes no call: the product falls back to recorded causes, gap finding goes on.
//
// One Lua step per reservation (INCRBY, EXPIRE on the first, DECRBY back when it would pass the cap), micro-dollars as integers.
// Without Redis (local development) the same arithmetic lives in memory. A Redis error is thrown: no call without a budget check.
//
// A settle can only move the total by the difference between the real cost and the reservation. Because the reservation is a worst case
// that the real cost does not reach, the difference is a refund; if an estimate were ever too low, the overspend is still recorded (it is real
// money, and the next reservation sees it) rather than hidden.
import type { Redis } from "@upstash/redis";
import { redisFromEnv } from "./redis.ts";

export const DAILY_BUDGET_USD = 1.5;
const MICRO = 1_000_000;
const DAY_MS = 24 * 60 * 60 * 1000;

// KEYS[1] day counter. ARGV[1] amount, ARGV[2] cap, ARGV[3] ttl ms. Returns the new total, or -1 when the cap would be passed (nothing kept).
const RESERVE = `
local n = redis.call('INCRBY', KEYS[1], ARGV[1])
if n == tonumber(ARGV[1]) then redis.call('PEXPIRE', KEYS[1], ARGV[3]) end
if n > tonumber(ARGV[2]) then redis.call('DECRBY', KEYS[1], ARGV[1]) return -1 end
return n`;

export interface Reservation {
  /** Replace the reserved worst case with what the call really cost. */
  settle(actualUsd: number): Promise<void>;
  /** Nothing was billed (the request never produced anything): give the whole reservation back. */
  release(): Promise<void>;
}

export interface BudgetOptions {
  redis?: Redis | null;
  prefix?: string;
  now?: () => number;
  dailyUsd?: number;
}

export function createBudget({ redis = redisFromEnv(), prefix = "db:", now = Date.now, dailyUsd = DAILY_BUDGET_USD }: BudgetOptions = {}) {
  const memory = new Map<string, number>();
  const capMicro = Math.round(dailyUsd * MICRO);
  const dayKey = () => `${prefix}bud$:${new Date(now()).toISOString().slice(0, 10)}`;

  async function add(key: string, micro: number): Promise<void> {
    if (redis) await redis.incrby(key, micro);
    else memory.set(key, (memory.get(key) ?? 0) + micro);
  }

  return {
    // null = the day's budget does not cover another call.
    async reserve(worstCaseUsd: number): Promise<Reservation | null> {
      if (!(worstCaseUsd > 0) || !Number.isFinite(worstCaseUsd)) throw new Error(`budget: a reservation needs a positive worst-case cost, got ${worstCaseUsd}`);
      const key = dayKey();
      const reserved = Math.round(worstCaseUsd * MICRO);
      if (redis) {
        const n = (await redis.eval(RESERVE, [key], [reserved, capMicro, 2 * DAY_MS])) as number;
        if (n === -1) return null;
      } else {
        const total = (memory.get(key) ?? 0) + reserved;
        if (total > capMicro) return null;
        memory.set(key, total);
      }
      let done = false;
      const finish = async (actualMicro: number) => {
        if (done) return;
        done = true;
        const diff = actualMicro - reserved;
        if (diff !== 0) await add(key, diff);
      };
      return { settle: (actualUsd) => finish(Math.round(actualUsd * MICRO)), release: () => finish(0) };
    },
    async spentUsd(): Promise<number> {
      const key = dayKey();
      const micro = redis ? Number(await redis.get(key)) || 0 : (memory.get(key) ?? 0);
      return micro / MICRO;
    },
  };
}

let shared: ReturnType<typeof createBudget> | undefined;
export function sharedBudget() {
  shared ??= createBudget();
  return shared;
}
