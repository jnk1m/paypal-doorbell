// The witness's heartbeat (R26, plan 10.1 #2): the witness is checked the way it checks everybody else. It is compared with PayPal's own
// event list, and the sentence in the status band says what that comparison found.
//
//   "Witness: last delivery 12 s ago · events list shows 0 the witness missed"
//
//   missed   PayPal's list has events (of types the witness subscribed to) that the witness never heard. This is the F6 kind of loss: a
//            webhook registered a moment ago got 3 of 7 events, the other 4 were listed and never delivered (docs/measurements, fixtures/probe/witness-gap.json).
//   silent   the last delivery is over 30 minutes old, or there is none, or the list could not be read: there is nothing to compare, and
//            the text says so. A quiet witness looks exactly like a healthy one; silence is not health.
//   ok       a recent delivery and no listed event the witness missed.
// `missed` wins over `silent`: a witness that went quiet while PayPal listed events it never heard is the case this exists to show.
//
// Nothing is read for it. The scan has already asked PayPal's list (the snapshot route makes it ask) and already knows which events the
// witness heard (the shop's "D heard" notes), so the heartbeat is computed from the ScanResult and the session view: no extra Redis command.
import type { ScanResult } from "../gaps/scan.ts";
import type { Heartbeat } from "../run/snapshot.ts";
import { COMPLETED, REFUNDED } from "../shop/events.ts";
import type { SessionView } from "../shop/view.ts";

export const SILENT_AFTER_MS = 30 * 60_000;
// PayPal makes its first delivery within seconds and its retries over about 160 s (F2, F5). An event listed less than 3 minutes ago may
// still be on its way, so it is not counted as missed yet.
export const MISSED_GRACE_MS = 3 * 60_000;

export interface ListedForHeartbeat {
  eid: string;
  type: string;
  createTime: number; // ms
}

export interface HeartbeatInput {
  now: number;
  listed: readonly ListedForHeartbeat[] | null; // PayPal's event list; null = it could not be read
  heard: Iterable<string>; // ids of the events the witness verified
  lastDeliveryAt: number | null;
  subscribedTypes?: readonly string[] | null; // the witness webhook's subscription ("*" = every type); null or missing = every type counts
}

// Listed events of a type the witness subscribes to, old enough to have been delivered, that the witness never heard.
export function witnessMisses(input: Pick<HeartbeatInput, "now" | "listed" | "heard" | "subscribedTypes">): { missed: ListedForHeartbeat[]; pending: number } {
  if (input.listed === null) return { missed: [], pending: 0 };
  const heard = new Set(input.heard);
  const subscribed = input.subscribedTypes ? new Set(input.subscribedTypes) : null;
  const everything = subscribed?.has("*") ?? false; // PayPal lists an all-events webhook as the single type "*" (probe 2026-10-20), and it hears every type
  const missed: ListedForHeartbeat[] = [];
  let pending = 0;
  for (const e of input.listed) {
    if (subscribed && !everything && !subscribed.has(e.type)) continue;
    if (heard.has(e.eid)) continue;
    if (input.now - e.createTime < MISSED_GRACE_MS) pending++;
    else missed.push(e);
  }
  return { missed, pending };
}

export function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 90) return `${s} s ago`;
  const min = Math.round(s / 60);
  return min < 90 ? `${min} min ago` : `${Math.round(min / 60)} h ago`;
}

export function heartbeatOf(input: HeartbeatInput): Heartbeat {
  const { now, lastDeliveryAt } = input;
  const { missed } = witnessMisses(input);
  const count = input.listed === null ? null : missed.length;
  const last = lastDeliveryAt === null ? "no delivery heard yet" : `last delivery ${ago(now - lastDeliveryAt)}`;
  const quiet = lastDeliveryAt === null || now - lastDeliveryAt > SILENT_AFTER_MS;

  if (count !== null && count > 0) return { lastDeliveryAt, listedMissedByWitness: count, state: "missed", text: `Witness: ${last} · events list shows ${count} the witness never heard` };
  if (count === null) return { lastDeliveryAt, listedMissedByWitness: null, state: "silent", text: `Witness: ${last} · events list could not be read: nothing to compare` };
  if (quiet) return { lastDeliveryAt, listedMissedByWitness: 0, state: "silent", text: `Witness: ${last} · silence is not health: nothing to compare` };
  return { lastDeliveryAt, listedMissedByWitness: 0, state: "ok", text: `Witness: ${last} · events list shows 0 the witness missed` };
}

// From what a snapshot already holds. The witness here is D, the webhook that subscribes to every payment type; the events compared are
// this session's (the ones the scan could look up in PayPal's list). The scan reads the list only when it is asked to (ScanOptions.listing);
// without that read the answer is "could not be read".
export function heartbeatOfScan(scan: ScanResult, view: Pick<SessionView, "orders">): Heartbeat {
  const timeOf = new Map<string, { at: number; refundAt: number | null }>(view.orders.map((o) => [o.captureId, { at: o.at, refundAt: o.refundAt }]));
  const listed: ListedForHeartbeat[] = [];
  const heard: string[] = [];
  let lastDeliveryAt: number | null = null;
  for (const row of scan.rows) {
    const when = timeOf.get(row.captureId);
    for (const e of row.events) {
      if (e.d) lastDeliveryAt = Math.max(lastDeliveryAt ?? 0, e.d.at);
      if (!e.eid) continue;
      if (e.d) heard.push(e.eid);
      if (e.listed && when) listed.push({ eid: e.eid, type: e.kind === "completed" ? COMPLETED : REFUNDED, createTime: e.listedAt ?? (e.kind === "completed" ? when.at : (when.refundAt ?? when.at)) });
    }
  }
  return heartbeatOf({ now: scan.at, listed: scan.listing.read ? listed : null, heard, lastDeliveryAt });
}
