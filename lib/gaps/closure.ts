// How a TIED row was closed when no resend of ours reached the shop. Read from the one row the scan returns, never from the lane's memory:
// the event that last wrote the books (row.book.eid) has a 2xx try whose receive-to-answer window contains the time of that write (book.at), so that
// try is the one that closed the row, and every try before it was either answered with an error or crashed. When an earlier try shares the
// transmission id of the closing one, it is PayPal's own retry that closed the row; a new transmission id is a delivery nobody here asked for.
//
// It is silent (null) whenever a part of this cannot be read or does not hold: a try still in flight, an earlier try that was answered 2xx (the books
// were then written by something else), a write that falls outside the closing try's window, or a heal record that shows a resend of ours arrived.
// A heal record WITHOUT the resend's arrival says only that a resend was asked for and never confirmed to reach the shop, so it does not hide a closure.
//
// The row cannot say WHEN the shop was fixed (the store keeps no time for a mode change), so nothing here says "after the fix": a screen may say that only
// from what it remembers itself.
import type { AttemptReport } from "../shop/reporter.ts";
import type { HealView, ScanRow } from "./scan.ts";

export interface Closure {
  kind: "paypal_retry" | "other_delivery";
  event: "completed" | "refunded"; // the event that closed it
  tryNo: number; // 1-based place of the answered-2xx try among this event's tries, in arrival order
  sinceFirstSec: number; // from the first try of the event to the one that closed the row
  at: number; // when the closing try reached the shop, ms
  status: number; // what the shop answered to it
  failed: (number | null)[]; // what the earlier tries ended in: the status the shop answered, or null for a crash
}

const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

export const is2xx = (a: AttemptReport): boolean => a.state === "responded" && num(a.status) && a.status >= 200 && a.status < 300;
const arrivedAt = (a: AttemptReport): number => a.receivedAt ?? a.respondedAt ?? 0;

// A heal record carries the resend's arrival when the reporter saw the resent delivery reach the shop (HealView.arrivedAt).
export const healArrived = (h: HealView | null | undefined): boolean => num(h?.arrivedAt);

// A try this code can reason about: it has an id, a time, and a state that is either answered (with a status) or not.
const readable = (a: unknown): a is AttemptReport => {
  const t = a as Partial<AttemptReport> | null;
  if (!t || typeof t !== "object" || typeof t.tid !== "string" || !num(t.receivedAt ?? t.respondedAt)) return false;
  if (t.state === "responded") return num(t.status) && num(t.respondedAt);
  return t.state === "crashed" || t.state === "in_flight";
};

// null: the row is not TIED, its books have no entry, a resend of ours arrived, the event that wrote them has no 2xx try around the write, that try
// was the first, or an earlier try is not a plain failure (2xx, still in flight, or unreadable). Never throws on a malformed row.
export function closureOf(row: ScanRow): Closure | null {
  const book = row?.book;
  if (row?.status !== "TIED" || !book || typeof book.eid !== "string" || !num(book.at)) return null;
  const events = Array.isArray(row.events) ? row.events : null;
  if (!events || events.some((e) => !e || typeof e !== "object" || healArrived(e.heal))) return null; // an event that cannot be read might hold the resend
  const ev = events.find((e) => typeof e.eid === "string" && e.eid === book.eid);
  if (!ev || (ev.kind !== "completed" && ev.kind !== "refunded") || !Array.isArray(ev.s) || !ev.s.every(readable)) return null;
  const tries = [...ev.s].sort((a, b) => arrivedAt(a) - arrivedAt(b));
  const k = tries.findIndex((a) => is2xx(a) && num(a.receivedAt) && a.receivedAt <= book.at && book.at <= a.respondedAt!);
  if (k < 1) return null; // no closing try, or it was the first: nothing failed before it
  const before = tries.slice(0, k);
  if (before.some((a) => a.state === "in_flight" || is2xx(a))) return null; // undecided, or the row was open for another reason
  const closing = tries[k];
  return {
    kind: before.some((a) => a.tid === closing.tid) ? "paypal_retry" : "other_delivery",
    event: ev.kind,
    tryNo: k + 1,
    sinceFirstSec: Math.max(0, Math.round((arrivedAt(closing) - arrivedAt(tries[0])) / 1000)),
    at: arrivedAt(closing),
    status: closing.status!,
    failed: before.map((a) => (a.state === "responded" ? a.status! : null)),
  };
}
