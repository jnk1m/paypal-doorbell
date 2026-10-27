// The shop's persistent state (plan 5.6). Every key has a TTL and there is no global list.
//
//   <p>shop:s:<sid>          hash   mode, at                       the session. TTL 24 h
//   <p>shop:o:<sid>          hash   <capture id> -> order JSON      the session's orders. TTL 24 h
//   <p>shop:b:<sid>          hash   <capture id> -> book JSON       the session's books (what the webhook handler wrote). TTL 24 h
//   <p>shop:cap:<capture id> string <sid>                            capture -> session, written when the order is created. TTL 24 h
//   <p>shop:d:<res>:<type>   string JSON {eid, tid, at, slot}        the witness heard this event (D). TTL 24 h
//   <p>shop:x:<res>:<type>   string <event id>                       the shop (S) received this event. TTL 24 h
//   <p>shop:r:<event id>     string NDJSON, one line per report      the reporter's record for an event. TTL 4 days
//   <p>shop:h:<sid>          hash   _n (resends used), e:<event id> -> heal JSON   Ring again. TTL 24 h
//   <p>shop:hl:<sid>:<eid>   string 1                                the lock of a resend that is being sent. TTL 20 s
//   <p>shop:n:<nonce>        string 1                                a nonce the report intake has accepted (report-intake.ts). TTL 10 min
//
// <res> is the id of the event's own resource (the capture for COMPLETED, the refund for REFUNDED), which is also what we know
// when we create the order or the refund, so the screen can ask about an event before it knows the event id.
import type { Redis } from "@upstash/redis";
import { isMode, type BookEntry, type HealRecord, type Mode, type OrderRecord } from "./types.ts";

export const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
export const REPORT_TTL_MS = 4 * 24 * 60 * 60 * 1000;

export interface Heard {
  eid: string;
  tid: string;
  at: number;
  slot: string;
}

export interface EventRef {
  resourceId: string;
  type: string;
}

export interface EventLookup {
  heard: (Heard | null)[]; // by position in the refs asked for
  received: (string | null)[]; // the event id the shop saw, by position
}

export const RESEND_LOCK_MS = 20_000;
export type ResendReservation = "reserved" | "cap" | "busy";

export interface ShopStore {
  createSession(sid: string, mode: Mode, at: number): Promise<void>;
  getSession(sid: string): Promise<{ mode: Mode; at: number } | null>;
  setMode(sid: string, mode: Mode): Promise<boolean>; // false when the session does not exist (or has expired)
  putOrder(sid: string, order: OrderRecord): Promise<void>; // also maps the capture to the session
  orders(sid: string): Promise<OrderRecord[]>;
  sessionOfCapture(captureId: string): Promise<string | null>;
  getBook(sid: string, captureId: string): Promise<BookEntry | null>;
  setBook(sid: string, captureId: string, entry: BookEntry): Promise<void>;
  books(sid: string): Promise<Record<string, BookEntry>>;
  noteHeard(ref: EventRef, heard: Heard): Promise<void>;
  noteReceived(ref: EventRef, eid: string): Promise<void>;
  lookup(refs: EventRef[]): Promise<EventLookup>;
  appendReport(eid: string, line: string): Promise<void>; // atomic append, so concurrent attempts never overwrite each other
  reports(eids: string[]): Promise<(string | null)[]>;
  heals(sid: string): Promise<{ resends: number; records: Record<string, HealRecord> }>;
  // Counts one resend of this session and takes a short lock on the event, in one step: "cap" when the session has used `cap`
  // already, "busy" when another resend of the same event is being sent. releaseResend gives both back (PayPal did not accept it).
  reserveResend(sid: string, eid: string, cap: number): Promise<ResendReservation>;
  releaseResend(sid: string, eid: string): Promise<void>;
  putHeal(sid: string, record: HealRecord): Promise<void>;
  claimReportNonce(nonce: string, ttlMs: number): Promise<boolean>; // true the first time a nonce is seen within ttlMs, false on every repeat
}

const parseJson = <T>(raw: unknown): T | null => {
  if (typeof raw !== "string") return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
};

// HGETALL as a plain object. The shared Redis client has automatic deserialization off (lib/redis.ts), and then Upstash returns the
// reply as it came: a flat [field, value, field, value, ...] array.
function hash(reply: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (Array.isArray(reply)) for (let i = 0; i + 1 < reply.length; i += 2) out[String(reply[i])] = String(reply[i + 1]);
  else if (reply && typeof reply === "object") for (const [k, v] of Object.entries(reply)) out[k] = String(v);
  return out;
}

// KEYS[1] session. ARGV[1] mode. Changes the mode of a session that exists; never creates one (a stray HSET would make a key with no TTL).
const SET_MODE = `
if redis.call('EXISTS', KEYS[1]) == 0 then return 0 end
redis.call('HSET', KEYS[1], 'mode', ARGV[1])
return 1`;

// KEYS[1] heals hash, KEYS[2] event lock. ARGV[1] cap, ARGV[2] hash ttl ms, ARGV[3] lock ms.
// Returns the resends used after this one, -1 when the cap is reached, -2 when the event is locked.
const RESERVE_RESEND = `
if redis.call('SET', KEYS[2], '1', 'NX', 'PX', ARGV[3]) == false then return -2 end
local n = tonumber(redis.call('HGET', KEYS[1], '_n') or '0')
if n >= tonumber(ARGV[1]) then redis.call('DEL', KEYS[2]) return -1 end
redis.call('HSET', KEYS[1], '_n', n + 1)
redis.call('PEXPIRE', KEYS[1], ARGV[2])
return n + 1`;

export class RedisShopStore implements ShopStore {
  constructor(
    private readonly redis: Redis,
    private readonly prefix: string,
  ) {}

  private key(...parts: string[]) {
    return `${this.prefix}shop:${parts.join(":")}`;
  }

  async createSession(sid: string, mode: Mode, at: number): Promise<void> {
    await this.redis.pipeline().hset(this.key("s", sid), { mode, at: String(at) }).pexpire(this.key("s", sid), SESSION_TTL_MS).exec();
  }

  async getSession(sid: string): Promise<{ mode: Mode; at: number } | null> {
    const h = hash(await this.redis.hgetall(this.key("s", sid)));
    if (!isMode(h.mode)) return null;
    return { mode: h.mode, at: Number(h.at) };
  }

  async setMode(sid: string, mode: Mode): Promise<boolean> {
    return ((await this.redis.eval(SET_MODE, [this.key("s", sid)], [mode])) as number) === 1;
  }

  async putOrder(sid: string, order: OrderRecord): Promise<void> {
    await this.redis
      .pipeline()
      .set(this.key("cap", order.captureId), sid, { px: SESSION_TTL_MS })
      .hset(this.key("o", sid), { [order.captureId]: JSON.stringify(order) })
      .pexpire(this.key("o", sid), SESSION_TTL_MS)
      .exec();
  }

  async orders(sid: string): Promise<OrderRecord[]> {
    return Object.values(hash(await this.redis.hgetall(this.key("o", sid))))
      .map((raw) => parseJson<OrderRecord>(raw))
      .filter((o): o is OrderRecord => o !== null)
      .sort((a, b) => a.n - b.n);
  }

  async sessionOfCapture(captureId: string): Promise<string | null> {
    return (await this.redis.get<string>(this.key("cap", captureId))) ?? null;
  }

  async getBook(sid: string, captureId: string): Promise<BookEntry | null> {
    return parseJson<BookEntry>(await this.redis.hget<string>(this.key("b", sid), captureId));
  }

  async setBook(sid: string, captureId: string, entry: BookEntry): Promise<void> {
    await this.redis.pipeline().hset(this.key("b", sid), { [captureId]: JSON.stringify(entry) }).pexpire(this.key("b", sid), SESSION_TTL_MS).exec();
  }

  async books(sid: string): Promise<Record<string, BookEntry>> {
    const out: Record<string, BookEntry> = {};
    for (const [capture, raw] of Object.entries(hash(await this.redis.hgetall(this.key("b", sid))))) {
      const entry = parseJson<BookEntry>(raw);
      if (entry) out[capture] = entry;
    }
    return out;
  }

  async noteHeard(ref: EventRef, heard: Heard): Promise<void> {
    await this.redis.set(this.key("d", ref.resourceId, ref.type), JSON.stringify(heard), { px: SESSION_TTL_MS });
  }

  async noteReceived(ref: EventRef, eid: string): Promise<void> {
    await this.redis.set(this.key("x", ref.resourceId, ref.type), eid, { px: SESSION_TTL_MS });
  }

  async lookup(refs: EventRef[]): Promise<EventLookup> {
    if (refs.length === 0) return { heard: [], received: [] };
    // One MGET for both kinds of key (Upstash counts a command, not a key): a poll of the screen reads this on every call.
    const all = await this.redis.mget<(string | null)[]>(...refs.map((r) => this.key("d", r.resourceId, r.type)), ...refs.map((r) => this.key("x", r.resourceId, r.type)));
    const heard = all.slice(0, refs.length);
    const received = all.slice(refs.length);
    return { heard: heard.map((raw) => parseJson<Heard>(raw)), received: received.map((raw) => (typeof raw === "string" ? raw : null)) };
  }

  async appendReport(eid: string, line: string): Promise<void> {
    await this.redis.pipeline().append(this.key("r", eid), `${line}\n`).pexpire(this.key("r", eid), REPORT_TTL_MS).exec();
  }

  async reports(eids: string[]): Promise<(string | null)[]> {
    if (eids.length === 0) return [];
    return (await this.redis.mget<(string | null)[]>(...eids.map((e) => this.key("r", e)))).map((raw) => (typeof raw === "string" ? raw : null));
  }

  async heals(sid: string): Promise<{ resends: number; records: Record<string, HealRecord> }> {
    const fields = hash(await this.redis.hgetall(this.key("h", sid)));
    const records: Record<string, HealRecord> = {};
    for (const [field, raw] of Object.entries(fields)) {
      const record = field.startsWith("e:") ? parseJson<HealRecord>(raw) : null;
      if (record) records[record.eid] = record;
    }
    return { resends: Number(fields._n ?? 0), records };
  }

  async reserveResend(sid: string, eid: string, cap: number): Promise<ResendReservation> {
    const n = (await this.redis.eval(RESERVE_RESEND, [this.key("h", sid), this.key("hl", sid, eid)], [cap, SESSION_TTL_MS, RESEND_LOCK_MS])) as number;
    return n === -2 ? "busy" : n === -1 ? "cap" : "reserved";
  }

  async releaseResend(sid: string, eid: string): Promise<void> {
    await this.redis.pipeline().hincrby(this.key("h", sid), "_n", -1).del(this.key("hl", sid, eid)).exec();
  }

  async putHeal(sid: string, record: HealRecord): Promise<void> {
    await this.redis.pipeline().hset(this.key("h", sid), { [`e:${record.eid}`]: JSON.stringify(record) }).pexpire(this.key("h", sid), SESSION_TTL_MS).exec();
  }

  async claimReportNonce(nonce: string, ttlMs: number): Promise<boolean> {
    return (await this.redis.set(this.key("n", nonce), "1", { nx: true, px: ttlMs })) === "OK";
  }
}

// The same behavior in memory (TTLs aside), for tests that must run without Upstash. store.contract.ts holds the tests both pass.
export class MemoryShopStore implements ShopStore {
  private readonly sessions = new Map<string, { mode: Mode; at: number }>();
  private readonly orderMap = new Map<string, Map<string, OrderRecord>>();
  private readonly bookMap = new Map<string, Map<string, BookEntry>>();
  private readonly caps = new Map<string, string>();
  private readonly heard = new Map<string, Heard>();
  private readonly received = new Map<string, string>();
  private readonly reportMap = new Map<string, string>();
  private readonly healMap = new Map<string, { resends: number; records: Map<string, HealRecord> }>();
  private readonly locks = new Map<string, number>();
  private readonly nonces = new Map<string, number>();

  constructor(private readonly now: () => number = Date.now) {} // the clock the resend lock expires by; a test can move it

  async createSession(sid: string, mode: Mode, at: number): Promise<void> {
    this.sessions.set(sid, { mode, at });
  }

  async getSession(sid: string) {
    const s = this.sessions.get(sid);
    return s ? { ...s } : null;
  }

  async setMode(sid: string, mode: Mode): Promise<boolean> {
    const s = this.sessions.get(sid);
    if (!s) return false;
    s.mode = mode;
    return true;
  }

  async putOrder(sid: string, order: OrderRecord): Promise<void> {
    this.caps.set(order.captureId, sid);
    const m = this.orderMap.get(sid) ?? new Map<string, OrderRecord>();
    m.set(order.captureId, structuredClone(order));
    this.orderMap.set(sid, m);
  }

  async orders(sid: string): Promise<OrderRecord[]> {
    return [...(this.orderMap.get(sid)?.values() ?? [])].map((o) => structuredClone(o)).sort((a, b) => a.n - b.n);
  }

  async sessionOfCapture(captureId: string): Promise<string | null> {
    return this.caps.get(captureId) ?? null;
  }

  async getBook(sid: string, captureId: string): Promise<BookEntry | null> {
    const b = this.bookMap.get(sid)?.get(captureId);
    return b ? { ...b } : null;
  }

  async setBook(sid: string, captureId: string, entry: BookEntry): Promise<void> {
    const m = this.bookMap.get(sid) ?? new Map<string, BookEntry>();
    m.set(captureId, { ...entry });
    this.bookMap.set(sid, m);
  }

  async books(sid: string): Promise<Record<string, BookEntry>> {
    return Object.fromEntries([...(this.bookMap.get(sid)?.entries() ?? [])].map(([k, v]) => [k, { ...v }]));
  }

  async noteHeard(ref: EventRef, heard: Heard): Promise<void> {
    this.heard.set(`${ref.resourceId}:${ref.type}`, { ...heard });
  }

  async noteReceived(ref: EventRef, eid: string): Promise<void> {
    this.received.set(`${ref.resourceId}:${ref.type}`, eid);
  }

  async lookup(refs: EventRef[]): Promise<EventLookup> {
    return {
      heard: refs.map((r) => this.heard.get(`${r.resourceId}:${r.type}`) ?? null),
      received: refs.map((r) => this.received.get(`${r.resourceId}:${r.type}`) ?? null),
    };
  }

  async appendReport(eid: string, line: string): Promise<void> {
    this.reportMap.set(eid, `${this.reportMap.get(eid) ?? ""}${line}\n`);
  }

  async reports(eids: string[]): Promise<(string | null)[]> {
    return eids.map((e) => this.reportMap.get(e) ?? null);
  }

  async heals(sid: string): Promise<{ resends: number; records: Record<string, HealRecord> }> {
    const h = this.healMap.get(sid);
    return { resends: h?.resends ?? 0, records: Object.fromEntries([...(h?.records.entries() ?? [])].map(([k, v]) => [k, structuredClone(v)])) };
  }

  async reserveResend(sid: string, eid: string, cap: number): Promise<ResendReservation> {
    const lock = `${sid}:${eid}`;
    if ((this.locks.get(lock) ?? 0) > this.now()) return "busy";
    const h = this.healMap.get(sid) ?? { resends: 0, records: new Map<string, HealRecord>() };
    if (h.resends >= cap) return "cap";
    this.locks.set(lock, this.now() + RESEND_LOCK_MS);
    h.resends++;
    this.healMap.set(sid, h);
    return "reserved";
  }

  async releaseResend(sid: string, eid: string): Promise<void> {
    this.locks.delete(`${sid}:${eid}`);
    const h = this.healMap.get(sid);
    if (h && h.resends > 0) h.resends--;
  }

  async putHeal(sid: string, record: HealRecord): Promise<void> {
    const h = this.healMap.get(sid) ?? { resends: 0, records: new Map<string, HealRecord>() };
    h.records.set(record.eid, structuredClone(record));
    this.healMap.set(sid, h);
  }

  async claimReportNonce(nonce: string, ttlMs: number): Promise<boolean> {
    if ((this.nonces.get(nonce) ?? 0) > this.now()) return false;
    this.nonces.set(nonce, this.now() + ttlMs);
    return true;
  }
}
