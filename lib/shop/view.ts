// What the stamp screen shows for one session: its orders, what the books say, and per event the three things we can tell apart
// (the witness D heard it / the shop S received it / what S answered). Nothing here decides a verdict; the gap finder (S3) does.
import { CATALOG, isItemId } from "./catalog.ts";
import { COMPLETED, REFUNDED } from "./events.ts";
import { MODE_FILE, PLANTED_LABEL } from "./mode-files.ts";
import { summarizeReport, type AttemptReport } from "./reporter.ts";
import type { EventRef, ShopStore } from "./store.ts";
import { isBroken, type BookEntry, type Mode } from "./types.ts";

// How long after an order or a refund the books are given before a difference counts as one. PayPal's first delivery takes a median of 11 s (F2).
export const SETTLE_MS = 45_000;

export interface EventView {
  kind: "completed" | "refunded";
  resourceId: string;
  eid: string | null;
  heard: { at: number; slot: string; tid?: string } | null; // D, the witness; tid is the transmission id D stored it under (the replay finds the signed delivery by it)
  received: AttemptReport[] | null; // S, the shop's reporter; null = no record at all
  noted: boolean; // S's webhook noted receiving this event (it can be true while the reporter has no record)
}

export interface OrderView {
  n: number;
  item: string;
  itemName: string;
  amount: string;
  orderId: string;
  captureId: string;
  invoiceId: string;
  at: number;
  refundAt: number | null; // when the shop asked PayPal to refund it
  paypal: "COMPLETED" | "REFUNDED"; // what our own calls to PayPal left it as
  book: BookEntry | null;
  books: "agree" | "waiting" | "differ";
  events: EventView[];
}

export interface SessionView {
  session: { id: string; mode: Mode; planted: boolean; plantedLabel: string; file: string; at: number };
  orders: OrderView[];
  now: number;
}

export async function buildView(store: ShopStore, sid: string, session: { mode: Mode; at: number }, now: number): Promise<SessionView> {
  const [orders, books] = await Promise.all([store.orders(sid), store.books(sid)]);
  const refs: { ref: EventRef; kind: EventView["kind"]; capture: string }[] = orders.flatMap((o) => [
    { ref: { resourceId: o.captureId, type: COMPLETED }, kind: "completed" as const, capture: o.captureId },
    ...(o.refund ? [{ ref: { resourceId: o.refund.id, type: REFUNDED }, kind: "refunded" as const, capture: o.captureId }] : []),
  ]);
  const lookup = await store.lookup(refs.map((r) => r.ref));
  const eidOf = (i: number) => lookup.received[i] ?? lookup.heard[i]?.eid ?? null;
  const eids = [...new Set(refs.map((_, i) => eidOf(i)).filter((e): e is string => e !== null))];
  const records = new Map(eids.map((e, i) => [e, i] as const));
  const raw = await store.reports(eids);

  const eventViews = new Map<string, EventView[]>();
  refs.forEach((r, i) => {
    const eid = eidOf(i);
    const view: EventView = {
      kind: r.kind,
      resourceId: r.ref.resourceId,
      eid,
      heard: lookup.heard[i] ? { at: lookup.heard[i]!.at, slot: lookup.heard[i]!.slot, tid: lookup.heard[i]!.tid } : null,
      received: eid ? summarizeReport(raw[records.get(eid)!], now) : null,
      noted: lookup.received[i] !== null,
    };
    eventViews.set(r.capture, [...(eventViews.get(r.capture) ?? []), view]);
  });

  return {
    session: { id: sid, mode: session.mode, planted: isBroken(session.mode), plantedLabel: PLANTED_LABEL, file: MODE_FILE[session.mode], at: session.at },
    orders: orders.map((o) => {
      const book = books[o.captureId] ?? null;
      const expected = o.refund ? "refunded" : "paid";
      const lastAction = o.refund?.at ?? o.at;
      return {
        n: o.n,
        item: o.item,
        itemName: isItemId(o.item) ? CATALOG[o.item].name : o.item,
        amount: o.amount,
        orderId: o.orderId,
        captureId: o.captureId,
        invoiceId: o.invoiceId,
        at: o.at,
        refundAt: o.refund?.at ?? null,
        paypal: o.refund ? "REFUNDED" : "COMPLETED",
        book,
        books: book?.state === expected ? "agree" : now - lastAction < SETTLE_MS ? "waiting" : "differ",
        events: eventViews.get(o.captureId) ?? [],
      };
    }),
    now,
  };
}
