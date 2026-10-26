// The witness's persistent record (R2). Per-event keys, every key has a TTL, no global unbounded list.
//
//   <p>w:att:<transmissionId>  list of the attempts that verified. Its first element is the one that was processed: a later
//                              attempt with the same id (PayPal retries reuse the id, measured) is appended but not processed.
//                              Capped at ATTEMPT_CAP entries, TTL 4 days (the production retry window is 3 days).
//   <p>w:q                     quarantine ring: deliveries that could not be verified (the verify call failed, or the budget
//                              was spent). Soft cap 600, trimmed to 500, TTL 6 h refreshed on each push.
//   <p>w:bud                   verify budget counter, one window anchored at the first hit.
//   <p>w:rej:<hour>            count of deliveries PayPal's verify rejected. Counter only: no body, no headers.
//
// One Lua script per step, except the verify budget (a two-command pipeline). Upstash counts an EVAL as 1 command plus every
// redis.call inside it (measured 2026-10-19), so the scripts keep inner calls to a minimum; the command count per delivery is
// measured in scripts/measure-commands.ts.
import type { Redis } from "@upstash/redis";

export const ATTEMPT_CAP = 50;
export const ATTEMPT_TTL_MS = 4 * 24 * 60 * 60 * 1000;
export const QUARANTINE_TTL_MS = 6 * 60 * 60 * 1000;
export const QUARANTINE_SOFT_CAP = 600;
export const QUARANTINE_KEEP = 500;
export const BUDGET_WINDOW_MS = 60_000;
export const REJECT_TTL_MS = 3 * 24 * 60 * 60 * 1000;

// One delivery as the witness saw it. At most 8 KB serialized; a body that does not fit is replaced by its hash (big: true).
export interface AttemptEntry {
  v: 1;
  tid: string; // PayPal-Transmission-Id
  slot: string; // which webhook received it (D = the witness webhook)
  at: number; // receive time, ms since epoch
  st: "ok" | "q"; // verified, or quarantined
  why?: "unavail" | "budget"; // why it was quarantined
  rv?: number; // when a quarantined entry was verified, ms
  h: { time: string; sig: string; algo: string; cert: string };
  eid: string; // event id
  type: string; // event type
  raw?: string; // the body as received
  sha: string; // sha256 of the body
  len: number; // body length in bytes
  big?: true; // raw was left out because the entry would pass 8 KB
}

export interface ReserveResult {
  allowed: boolean;
  msLeft?: number; // when not allowed: time until the budget window ends
}
export interface CommitResult {
  processed: boolean; // true for the first verified attempt of this transmission id
  attempts: number;
}
export interface Quarantined {
  raw: string; // the stored JSON exactly as pushed, the handle for resolve/drop
  entry: AttemptEntry;
}

export interface WitnessStore {
  reserveVerify(): Promise<ReserveResult>;
  commitVerified(entry: AttemptEntry): Promise<CommitResult>;
  quarantine(entry: AttemptEntry): Promise<void>;
  countRejected(nowMs: number): Promise<void>;
  listQuarantined(limit: number): Promise<Quarantined[]>;
  // Moves a quarantined entry (identified by its stored JSON) to the verified attempts. "gone" when someone else resolved it first.
  resolveQuarantined(raw: string, verified: AttemptEntry): Promise<CommitResult | "gone">;
  dropQuarantined(raw: string): Promise<boolean>;
  attempts(tid: string): Promise<AttemptEntry[]>;
}

const hourBucket = (nowMs: number) => new Date(nowMs).toISOString().slice(0, 13).replace("T", "");

// KEYS[1] attempts list. ARGV[1] entry, ARGV[2] ttl ms, ARGV[3] cap. Returns the list length after the push (1 = first, processed).
const COMMIT = `
local n = redis.call('RPUSH', KEYS[1], ARGV[1])
if n == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[2]) end
if n > tonumber(ARGV[3]) then redis.call('LTRIM', KEYS[1], -tonumber(ARGV[3]), -1) end
return n`;

// KEYS[1] ring. ARGV[1] entry, ARGV[2] ttl ms, ARGV[3] soft cap, ARGV[4] keep.
const QUARANTINE = `
local n = redis.call('RPUSH', KEYS[1], ARGV[1])
redis.call('PEXPIRE', KEYS[1], ARGV[2])
if n > tonumber(ARGV[3]) then redis.call('LTRIM', KEYS[1], -tonumber(ARGV[4]), -1) end
return n`;

// KEYS[1] counter. ARGV[1] ttl ms.
const COUNT = `
local n = redis.call('INCR', KEYS[1])
if n == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
return n`;

// KEYS[1] ring, KEYS[2] attempts list. ARGV[1] stored entry (to remove), ARGV[2] verified entry, ARGV[3] ttl, ARGV[4] cap.
// Removal and commit are one step, so two re-verifications of the same entry cannot both process it. -1 = already gone.
const RESOLVE = `
if redis.call('LREM', KEYS[1], 1, ARGV[1]) == 0 then return -1 end
local n = redis.call('RPUSH', KEYS[2], ARGV[2])
if n == 1 then redis.call('PEXPIRE', KEYS[2], ARGV[3]) end
if n > tonumber(ARGV[4]) then redis.call('LTRIM', KEYS[2], -tonumber(ARGV[4]), -1) end
return n`;

export class RedisWitnessStore implements WitnessStore {
  constructor(
    private readonly redis: Redis,
    private readonly opts: { prefix: string; budgetPerMinute: number; budgetWindowMs?: number },
  ) {}

  private key(...parts: string[]) {
    return `${this.opts.prefix}w:${parts.join(":")}`;
  }

  // INCR and PEXPIRE ... NX in one pipeline: 2 commands on every call. The EVAL this replaced cost 3 on the first call of a window and
  // 2 after, which made the first delivery of a window cost 7 (A2 wants at most 6). The window is still anchored at its first hit: NX
  // sets the expiry only on a counter that has none (a new one, or one whose expiry was somehow lost).
  async reserveVerify(): Promise<ReserveResult> {
    const windowMs = this.opts.budgetWindowMs ?? BUDGET_WINDOW_MS;
    const key = this.key("bud");
    const [count] = await this.redis.pipeline().incr(key).pexpire(key, windowMs, "NX").exec<[number, number]>();
    if (count <= this.opts.budgetPerMinute) return { allowed: true };
    const ttl = await this.redis.pttl(key);
    return { allowed: false, msLeft: ttl > 0 ? ttl : windowMs };
  }

  async commitVerified(entry: AttemptEntry): Promise<CommitResult> {
    const n = (await this.redis.eval(COMMIT, [this.key("att", entry.tid)], [JSON.stringify(entry), ATTEMPT_TTL_MS, ATTEMPT_CAP])) as number;
    return { processed: n === 1, attempts: n };
  }

  async quarantine(entry: AttemptEntry): Promise<void> {
    await this.redis.eval(QUARANTINE, [this.key("q")], [JSON.stringify(entry), QUARANTINE_TTL_MS, QUARANTINE_SOFT_CAP, QUARANTINE_KEEP]);
  }

  async countRejected(nowMs: number): Promise<void> {
    await this.redis.eval(COUNT, [this.key("rej", hourBucket(nowMs))], [REJECT_TTL_MS]);
  }

  async listQuarantined(limit: number): Promise<Quarantined[]> {
    const rows = await this.redis.lrange<string>(this.key("q"), 0, limit - 1);
    return rows.map((raw) => ({ raw: String(raw), entry: JSON.parse(String(raw)) as AttemptEntry }));
  }

  async resolveQuarantined(raw: string, verified: AttemptEntry): Promise<CommitResult | "gone"> {
    const n = (await this.redis.eval(RESOLVE, [this.key("q"), this.key("att", verified.tid)], [raw, JSON.stringify(verified), ATTEMPT_TTL_MS, ATTEMPT_CAP])) as number;
    return n === -1 ? "gone" : { processed: n === 1, attempts: n };
  }

  async dropQuarantined(raw: string): Promise<boolean> {
    return (await this.redis.lrem(this.key("q"), 1, raw)) > 0;
  }

  async attempts(tid: string): Promise<AttemptEntry[]> {
    const rows = await this.redis.lrange<string>(this.key("att", tid), 0, -1);
    return rows.map((r) => JSON.parse(String(r)) as AttemptEntry);
  }
}

// Same behavior in memory, for tests that must run without Upstash. store.contract.ts holds the tests both implementations pass.
export class MemoryWitnessStore implements WitnessStore {
  private readonly att = new Map<string, string[]>();
  private ring: string[] = [];
  private budget = { n: 0, resetAt: 0 };
  readonly rejected = new Map<string, number>();

  constructor(
    private readonly opts: { budgetPerMinute: number; budgetWindowMs?: number; now?: () => number },
  ) {}

  private now() {
    return (this.opts.now ?? Date.now)();
  }

  async reserveVerify(): Promise<ReserveResult> {
    if (this.budget.n === 0 || this.budget.resetAt <= this.now()) this.budget = { n: 0, resetAt: this.now() + (this.opts.budgetWindowMs ?? BUDGET_WINDOW_MS) };
    this.budget.n++;
    return this.budget.n <= this.opts.budgetPerMinute ? { allowed: true } : { allowed: false, msLeft: this.budget.resetAt - this.now() };
  }

  private push(tid: string, serialized: string): CommitResult {
    const list = this.att.get(tid) ?? [];
    list.push(serialized);
    if (list.length > ATTEMPT_CAP) list.splice(0, list.length - ATTEMPT_CAP);
    this.att.set(tid, list);
    return { processed: list.length === 1, attempts: list.length };
  }

  async commitVerified(entry: AttemptEntry): Promise<CommitResult> {
    return this.push(entry.tid, JSON.stringify(entry));
  }

  async quarantine(entry: AttemptEntry): Promise<void> {
    this.ring.push(JSON.stringify(entry));
    if (this.ring.length > QUARANTINE_SOFT_CAP) this.ring = this.ring.slice(-QUARANTINE_KEEP);
  }

  async countRejected(nowMs: number): Promise<void> {
    const k = hourBucket(nowMs);
    this.rejected.set(k, (this.rejected.get(k) ?? 0) + 1);
  }

  async listQuarantined(limit: number): Promise<Quarantined[]> {
    return this.ring.slice(0, limit).map((raw) => ({ raw, entry: JSON.parse(raw) as AttemptEntry }));
  }

  async resolveQuarantined(raw: string, verified: AttemptEntry): Promise<CommitResult | "gone"> {
    const i = this.ring.indexOf(raw);
    if (i < 0) return "gone";
    this.ring.splice(i, 1);
    return this.push(verified.tid, JSON.stringify(verified));
  }

  async dropQuarantined(raw: string): Promise<boolean> {
    const i = this.ring.indexOf(raw);
    if (i < 0) return false;
    this.ring.splice(i, 1);
    return true;
  }

  async attempts(tid: string): Promise<AttemptEntry[]> {
    return (this.att.get(tid) ?? []).map((r) => JSON.parse(r) as AttemptEntry);
  }

  get quarantineSize(): number {
    return this.ring.length;
  }

  get processedCount(): number {
    return this.att.size;
  }
}
