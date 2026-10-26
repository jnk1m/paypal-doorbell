// Heal (R5, changed by what S2 measured): PayPal's resend is asked for only after the event is in PayPal's event list (before that it
// answers 404, or accepts with 202 and never delivers: 2 of 5 trials). After a 202 the arrival at the shop is confirmed from the
// reporter within 60 s; if it does not come the resend is sent again, at most twice more. TIED is never set here: the books are
// read again and compared with PayPal's own answer, and a heal counts only when the books changed.
import type { AttemptReport } from "../shop/reporter.ts";
import type { ShopStore } from "../shop/store.ts";
import type { BookEntry, HealRecord } from "../shop/types.ts";
import { PaypalError } from "../pay/paypal.ts";
import { BOOKS_SETTLE_MS, RESEND_CAP } from "./classify.ts";
import type { PaypalReads } from "./reads.ts";

export const ARRIVAL_WAIT_MS = 60_000; // a resend that was accepted should reach the shop within this
export const MAX_SENDS = 3; // the first resend and at most two retries
const RESEND_TIMEOUT_MS = 6_000;

const sameBooks = (a: BookEntry | HealRecord["booksBefore"], b: BookEntry | HealRecord["booksBefore"]): boolean => (a === null || b === null ? a === b : a.state === b.state && a.eid === b.eid && a.at === b.at);
export const snapshotOf = (books: BookEntry | null): HealRecord["booksBefore"] => (books ? { state: books.state, eid: books.eid, at: books.at } : null);

export interface HealAssessment {
  record: HealRecord;
  retry: boolean; // no delivery arrived in time and a retry is still allowed
}

// Moves one heal record along from what the reporter, the books and PayPal's own answer show now. Pure.
export function assessHeal(record: HealRecord, now: number, seen: { attempts: AttemptReport[] | null; books: BookEntry | null; truth: "paid" | "refunded" | null }): HealAssessment {
  if (record.state === "healed") return { record, retry: false };
  const firstSend = record.sends[0] ?? now;
  const lastSend = record.sends[record.sends.length - 1] ?? now;
  const fresh = (seen.attempts ?? [])
    .filter((a) => !record.seen.includes(a.tid) && (a.receivedAt ?? a.respondedAt ?? 0) >= firstSend)
    .sort((a, b) => (a.receivedAt ?? 0) - (b.receivedAt ?? 0));

  const agrees = seen.truth !== null && seen.books?.state === seen.truth;
  const changed = !sameBooks(snapshotOf(seen.books), record.booksBefore);

  if (fresh.length === 0) {
    // The books were put right some other way (PayPal's own retry reached a fixed handler): that is a heal, but no resent delivery is claimed.
    if (agrees && changed) return { record: { ...record, state: "healed", healedAt: record.healedAt ?? now }, retry: false };
    if (now - lastSend < ARRIVAL_WAIT_MS) return { record: { ...record, state: "sent" }, retry: false };
    return record.sends.length < MAX_SENDS ? { record: { ...record, state: "sent" }, retry: true } : { record: { ...record, state: "lost" }, retry: false };
  }

  const answered = fresh.find((a) => a.state === "responded");
  const next: HealRecord = { ...record, state: "arrived", arrivedAt: fresh[0].receivedAt, ...(answered ? { answer: answered.status } : {}) };
  if (agrees && changed) return { record: { ...next, state: "healed", healedAt: record.healedAt ?? now }, retry: false };
  if (answered && seen.truth !== null && now - (answered.respondedAt ?? now) >= BOOKS_SETTLE_MS) return { record: { ...next, state: "unchanged" }, retry: false };
  return { record: next, retry: false };
}

export interface HealDeps {
  store: Pick<ShopStore, "reserveResend" | "releaseResend" | "putHeal">;
  reads: Pick<PaypalReads, "resend">;
  shopWebhookId: string; // webhook S: a resend goes to the shop only
  now: () => number;
  log?: (line: Record<string, unknown>) => void;
  beforeSend?: () => Promise<void>; // throws to stop a resend that is about to be sent (the rate limit on real resends)
}

export type SendResult = { result: "sent"; record: HealRecord } | { result: "cap" } | { result: "busy" } | { result: "refused"; status: number };

// Counts the resend against the session's five, asks PayPal, and records it. `previous` continues a record (a retry); without it this
// is a new cycle. Nothing is written when PayPal does not accept: the count is given back.
export async function sendResend(deps: HealDeps, sid: string, p: { eid: string; captureId: string; kind: HealRecord["kind"]; seen: string[]; booksBefore: HealRecord["booksBefore"]; previous?: HealRecord }): Promise<SendResult> {
  const reserved = await deps.store.reserveResend(sid, p.eid, RESEND_CAP);
  if (reserved === "cap") return { result: "cap" };
  if (reserved === "busy") return { result: "busy" };
  try {
    await deps.beforeSend?.(); // the caller's limit on real resends: asked only now, when a resend is about to be sent (an error here gives the count back)
    await deps.reads.resend(p.eid, deps.shopWebhookId, RESEND_TIMEOUT_MS);
  } catch (e) {
    await deps.store.releaseResend(sid, p.eid);
    if (e instanceof PaypalError) {
      deps.log?.({ outcome: "resend_refused", eid: p.eid, paypalStatus: e.status, codes: e.codes });
      return { result: "refused", status: e.status };
    }
    throw e;
  }
  const at = deps.now();
  const record: HealRecord = p.previous
    ? { ...p.previous, state: "sent", sends: [...p.previous.sends, at] }
    : { eid: p.eid, captureId: p.captureId, kind: p.kind, state: "sent", seen: p.seen, sends: [at], booksBefore: p.booksBefore };
  await deps.store.putHeal(sid, record);
  return { result: "sent", record };
}
