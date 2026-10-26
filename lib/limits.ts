// R13 rate limits (plan 9.6). Two layers, built so that a flood costs the database nothing:
//
//   1. an in-memory token bucket per client (IPv6 by /64), checked first. A request it refuses is answered 429 with ZERO Redis commands.
//   2. hourly fixed windows in Redis. Each rule is a scope (ip, session, global) with its own counter, and ALL the counters of a request
//      are counted by one Lua call (INCR each, PEXPIRE on a counter's first hit, PTTL only on the counter that is over), so a request
//      that passes costs one EVAL whatever the number of scopes. When Redis says a counter is over, the time left is remembered in
//      memory (blockedUntil), so the rest of that hour's blocked requests do not touch Redis either.
//
// Windows are hourly, not daily: a pool that empties at noon recovers within the hour instead of locking the demo until midnight.
// The numbers are the plan's starting points ("measured and fixed in S6"). A Redis error is thrown, not swallowed: the call a limit
// guards (a model call, a PayPal call) must not run unchecked. Without Redis configured (local development) the same windows live in memory.
import type { Redis } from "@upstash/redis";
import { redisFromEnv } from "./redis.ts";

export type LimitKind = "model" | "scan" | "session" | "order" | "refund" | "replay" | "mode" | "ring";
export type Scope = "ip" | "session" | "global";
export interface Rule {
  scope: Scope;
  max: number;
  windowSec: number;
}
export interface Who {
  ip: string;
  session?: string;
}
export interface LimitResult {
  ok: boolean;
  retryAfterSec?: number;
  reason?: string; // a fixed phrase with a wait time; never request data
  blockedBy?: "burst" | Scope; // which layer said no (for the log and for tests)
}

const HOUR = 3600;
// Plan 9.6. Order inside a kind is most specific first, so that one abuser is stopped by their own IP/session counter before they
// can spend the pool everybody shares.
//
// scan (the page's poll: the snapshot route and the scan route count on the same two counters). S4 found the plan's 20 an hour too tight:
// the page's backoff of 3 s, then 10 s, then 20 s makes 19 polls in the first 5 minutes alone. Measured in limits.test.ts on a fake clock: a
// person who acts every minute and polls after every action (the cadence starts again at 3 s) makes 4 polls a minute, 240 in an hour; a
// visit with 10 actions 90 s apart and 5 quiet minutes at the end makes 61. So a session gets 300 an hour (1.25 times the non-stop worst case:
// someone who follows the cadence never meets it, a loop that does not follow it is stopped), and the pool 600 an hour: 2 people non-stop,
// or 9 visits at 61.
// The speed per minute is not decided here but by the burst bucket below (8 at once, 10 a minute for one address): that is what keeps A13 1.
// A13 9 (at most 60 Redis commands per session per 10 minutes) is NOT kept at that cadence, and no hourly cap can keep it without making the page
// unusable: scripts/measure-poll.ts counts 7 commands for one poll of the snapshot (1 limiter EVAL, 4 HGETALL, 2 MGET), so the 16 polls after
// one action cost 112 (docs/measurements/s5-poll-cost.json). 60 holds only for 8 polls in 10 minutes. The plan's 20 an hour kept it by construction.
// S6: the page now backs off to one poll in 5 minutes when nothing is awaited, so an idle session keeps it (7 polls, 49 commands); one that is used still does not
// (docs/measurements/s6-a13-redis-2026-10-21.json).
// replay: one live replay of the good and the bad build on real deliveries is 2 x N verify calls (N = 2 deliveries: 4 calls). A session has
// three bugs to try, so 3 an hour each; 20 an hour in all is at most 80 verify calls an hour. The result is kept per session and bug, so a
// replay that was done once is not paid for again at the next poll.
export const RULES: Record<LimitKind, Rule[]> = {
  model: [{ scope: "global", max: 6, windowSec: HOUR }], // live model calls
  scan: [
    { scope: "session", max: 300, windowSec: HOUR },
    { scope: "global", max: 600, windowSec: HOUR },
  ],
  session: [
    { scope: "ip", max: 10, windowSec: HOUR },
    { scope: "global", max: 60, windowSec: HOUR },
  ],
  order: [
    { scope: "ip", max: 20, windowSec: HOUR },
    { scope: "session", max: 6, windowSec: HOUR },
    { scope: "global", max: 12, windowSec: HOUR },
  ],
  refund: [{ scope: "global", max: 10, windowSec: HOUR }],
  replay: [
    { scope: "session", max: 3, windowSec: HOUR },
    { scope: "global", max: 20, windowSec: HOUR },
  ],
  // mode: switching the handler is a Redis write (about 4 commands). A visit switches 6 to 10 times; 60 an hour per session is 6 times that.
  mode: [
    { scope: "session", max: 60, windowSec: HOUR },
    { scope: "global", max: 300, windowSec: HOUR },
  ],
  // ring: a press of "Ring again" is counted here, whether or not anything is sent (a refused press still reads Redis and PayPal). Only a
  // resend that is really sent is counted against the "refund" pool as well (routes: ring), so refused presses cannot drain that pool.
  // The page enables the button only when a resend is possible; 30 an hour per session leaves room for the 5 resends and the presses before them.
  ring: [
    { scope: "session", max: 30, windowSec: HOUR },
    { scope: "global", max: 200, windowSec: HOUR },
  ],
};

// Per client: 8 requests at once, then 10 a minute. Polling at 3 s, 10 s, 20 s (plan 9.7) never gets near it; a script hammering a route does.
export const BURST = { capacity: 8, perMinute: 10 } as const;
const MEMORY_KEYS_MAX = 10_000;

// All the counters of one request in ONE call. KEYS: the counters, most specific first. ARGV: for counter i, window ms then max.
// Stops at the first counter that is over, so a visitor stopped by their own counter never spends the shared one.
// Returns {index of the counter that is over (0 = none), its count, ms left in its window}.
const HIT = `
for i, key in ipairs(KEYS) do
  local n = redis.call('INCR', key)
  if n == 1 then redis.call('PEXPIRE', key, ARGV[2 * i - 1]) end
  if n > tonumber(ARGV[2 * i]) then return {i, n, redis.call('PTTL', key)} end
end
return {0, 0, 0}`;

// IPv4 as is; IPv6 as its /64 (the first four groups), because one customer gets a whole /64; an IPv4-mapped IPv6 address as its IPv4.
export function clientKey(ip: string): string {
  const raw = ip.trim().toLowerCase();
  if (raw === "") return "unknown";
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(raw);
  if (mapped) return mapped[1];
  if (!raw.includes(":")) return raw; // not IPv6 (and not node:net: the witness receiver's import graph is pinned by a test)
  const [head, tail = ""] = raw.split("::");
  const left = head === "" ? [] : head.split(":");
  const right = tail === "" ? [] : tail.split(":");
  const groups = raw.includes("::") ? [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill("0"), ...right] : left;
  return `${groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, "")).join(":")}::/64`;
}

const waitText = (sec: number) => (sec < 90 ? `${Math.max(1, sec)} s` : sec < HOUR ? `${Math.ceil(sec / 60)} min` : `${Math.ceil(sec / HOUR)} h`);

export interface LimiterOptions {
  redis?: Redis | null; // default: from env; null forces memory
  prefix?: string; // tests use "db:test:<run>:"
  now?: () => number;
  rules?: Record<LimitKind, Rule[]>;
}

export function createLimiter({ redis = redisFromEnv(), prefix = "db:", now = Date.now, rules = RULES }: LimiterOptions = {}) {
  const tokens = new Map<string, { n: number; at: number }>();
  const blockedUntil = new Map<string, number>();
  const windows = new Map<string, { count: number; resetAt: number }>(); // used only without Redis

  const trim = (map: Map<string, unknown>) => {
    if (map.size <= MEMORY_KEYS_MAX) return;
    let drop = Math.ceil(map.size / 2);
    for (const k of map.keys()) {
      if (drop-- <= 0) break;
      map.delete(k); // Map iterates in insertion order: the oldest go first
    }
  };

  // Layer 1. Returns 0 when a token was taken, otherwise the seconds until one is available.
  function takeToken(client: string): number {
    const t = now();
    const b = tokens.get(client) ?? { n: BURST.capacity, at: t };
    b.n = Math.min(BURST.capacity, b.n + ((t - b.at) / 60_000) * BURST.perMinute);
    b.at = t;
    tokens.delete(client);
    tokens.set(client, b);
    trim(tokens);
    if (b.n >= 1) {
      b.n -= 1;
      return 0;
    }
    return Math.max(1, Math.ceil(((1 - b.n) / BURST.perMinute) * 60));
  }

  // Counts one request against every counter of a kind. Returns the first one that is over (index into `entries`) and the ms left in its window.
  async function hitAll(entries: { key: string; rule: Rule }[]): Promise<{ over: number; msLeft: number } | null> {
    if (redis) {
      const [i, , ttl] = (await redis.eval(HIT, entries.map((e) => e.key), entries.flatMap((e) => [e.rule.windowSec * 1000, e.rule.max]))) as [number, number, number];
      return i === 0 ? null : { over: i - 1, msLeft: ttl > 0 ? ttl : entries[i - 1].rule.windowSec * 1000 };
    }
    for (const [i, { key, rule }] of entries.entries()) {
      let w = windows.get(key);
      if (!w || w.resetAt <= now()) {
        w = { count: 0, resetAt: now() + rule.windowSec * 1000 };
        windows.set(key, w);
        trim(windows);
      }
      if (++w.count > rule.max) return { over: i, msLeft: w.resetAt - now() };
    }
    return null;
  }

  const blocked = (retryAfterSec: number, by: LimitResult["blockedBy"]): LimitResult => ({
    ok: false,
    retryAfterSec,
    blockedBy: by,
    reason: by === "burst" ? `Too many requests. Try again in ${waitText(retryAfterSec)}.` : `Limit reached for this hour. Try again in ${waitText(retryAfterSec)}.`,
  });

  return {
    async checkLimit(kind: LimitKind, who: Who): Promise<LimitResult> {
      const client = clientKey(who.ip);
      const wait = takeToken(client);
      if (wait > 0) return blocked(wait, "burst");
      const entries = rules[kind].map((rule) => {
        const owner = rule.scope === "ip" ? client : rule.scope === "session" ? (who.session ?? `ip:${client}`) : "all";
        return { rule, key: `${prefix}rl:${kind}:${rule.scope}:${owner}` };
      });
      // A counter already known to be over (from an earlier answer of Redis) refuses without asking Redis again.
      for (const { rule, key } of entries) {
        const until = blockedUntil.get(key);
        if (until !== undefined && until > now()) return blocked(Math.max(1, Math.ceil((until - now()) / 1000)), rule.scope);
      }
      const hit = await hitAll(entries);
      if (!hit) return { ok: true };
      blockedUntil.set(entries[hit.over].key, now() + hit.msLeft);
      trim(blockedUntil);
      return blocked(Math.max(1, Math.ceil(hit.msLeft / 1000)), entries[hit.over].rule.scope);
    },
  };
}

let shared: ReturnType<typeof createLimiter> | undefined;

// What the routes call. Redis when KV_REST_API_URL is set, otherwise a per-process memory counter.
export function checkLimit(kind: LimitKind, who: Who): Promise<LimitResult> {
  shared ??= createLimiter();
  return shared.checkLimit(kind, who);
}
