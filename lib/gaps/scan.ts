// The gap finder (R3). For one session: ask PayPal again, by id, what each order is (the truth), compare it with the shop's books and with
// what the witness D heard, what PayPal's event list shows and what the shop S reported, and give every difference an evidence class.
//
//   - Every capture is read again from PayPal: concurrency 5, one retry per read, 10 s for the whole scan. A read that failed (or never
//     ran before the deadline) makes its row UNVERIFIED. It is never TIED: a row is TIED only when PayPal's answer agrees with the books.
//   - The refund is read as well for a row that differs; it adds the refund's status and cannot turn a found gap into UNVERIFIED.
//   - The webhooks are hints. PayPal's answer to the re-query is the truth; webhook bodies are never used to decide a verdict.
//   - Classification is classify.ts. Nothing here is decided by a model.
//
// The scan is called by the page's polling (no cron, no background work). It also moves the heal records along and gives the witness
// quarantine its re-verify (R1: quarantined deliveries are re-verified within 6 hours only if something calls it).
import { COMPLETED, REFUNDED } from "../shop/events.ts";
import { summarizeReport, type AttemptReport } from "../shop/reporter.ts";
import type { ShopStore } from "../shop/store.ts";
import type { BookEntry, HealRecord, Mode } from "../shop/types.ts";
import { buildView, type EventView, type OrderView, type SessionView } from "../shop/view.ts";
import { errorFields } from "../web/http.ts";
import { classify, retriesPendingUntil, ringState, type Finding, type Ring, type Waiting } from "./classify.ts";
import { isDenied, judgeDispute, openDisputes, subscriptionOf, type AppWebhook, type BookedDispute, type DisputeReads, type DisputeView, type ListedDisputeEvent, type PaypalDispute } from "./disputes.ts";
import { assessHeal, sendResend } from "./heal.ts";
import type { ListedEvent, PaypalReads } from "./reads.ts";

export const SCAN_DEADLINE_MS = 10_000;
export const SCAN_CONCURRENCY = 5;
const LIST_LEAD_MS = 120_000; // the list is asked from this long before the session's first order

export interface ScanDeps {
  store: ShopStore;
  reads: PaypalReads;
  shopWebhookId: string; // webhook S
  disputes?: { reads: DisputeReads; booked?: (captureId: string) => Promise<BookedDispute[]> }; // absent: the scan does not look for disputes. booked: the shop's dispute book; the demo shop keeps none
  reverify?: () => Promise<unknown>; // the witness quarantine's re-verify, called by every scan
  now?: () => number;
  deadlineMs?: number;
  concurrency?: number;
  log?: (line: Record<string, unknown>) => void;
}

export interface ScanOptions {
  only?: string; // scan just this capture (the ring uses it)
  advance?: boolean; // move heal records along, and send a retry when one is due (default true)
  listing?: boolean; // read PayPal's event list even when every row agrees (the snapshot needs it for the witness heartbeat); default: only when something differs
}

export type RowStatus = "TIED" | "GAP" | "UNVERIFIED";
type Truth = "paid" | "refunded";
const RANK: Record<RowStatus, number> = { TIED: 0, UNVERIFIED: 1, GAP: 2 };

export interface ScanEvent {
  kind: "completed" | "refunded";
  resourceId: string;
  eid: string | null;
  d: EventView["heard"];
  s: AttemptReport[] | null;
  listed: boolean;
  listedAt?: number; // PayPal's own create_time of the event, from its event list, ms. PayPal's event time, NOT a send time or a delivery time.
  finding: Finding | null; // only for the event the books are waiting for
  ring: Ring | null;
  heal: HealView | null;
}

// Where a resend stands. sentAt: when PayPal accepted each resend, in order (sends is their count). arrivedAt: when the first resent delivery
// reached the shop, when it has. Both are only there when known.
export interface HealView {
  state: HealRecord["state"];
  sends: number;
  sentAt?: number[];
  arrivedAt?: number;
  arrivalSeconds?: number;
  answer?: number;
}

const healView = (r: HealRecord): HealView => ({ state: r.state, sends: r.sends.length, sentAt: [...r.sends], ...(r.arrivedAt !== undefined ? { arrivedAt: r.arrivedAt } : {}) });

export interface ScanRow {
  n: number;
  captureId: string;
  itemName: string;
  amount: string;
  status: RowStatus;
  waiting?: Waiting; // why a row is UNVERIFIED
  truth: Truth | null; // what PayPal's re-query says; null when it did not answer
  paypalStatus: string | null;
  refundStatus: string | null;
  book: BookEntry | null;
  events: ScanEvent[];
  disputes?: DisputeView[]; // the open disputes PayPal lists on this capture; only present when there is one
}

export interface ScanResult {
  session: { id: string; mode: Mode };
  at: number;
  durationMs: number;
  deadlineHit: boolean;
  rows: ScanRow[];
  summary: { rows: number; tied: number; gaps: number; unverified: number; byClass: Record<string, number> };
  listing: { asked: boolean; read: boolean; events: number };
  calls: { captures: number; refunds: number; retries: number };
  disputeReads?: { asked: number; unreadable: number }; // only when the scan looks for disputes: captures asked, and those whose dispute list was not read (denied, failed, or not reached before the deadline)
  resendsUsed: number;
  reverify: unknown;
}

const truthOf = (status: string): Truth | null => (status === "COMPLETED" ? "paid" : status === "REFUNDED" ? "refunded" : null);
const typeOf = (kind: "completed" | "refunded") => (kind === "completed" ? COMPLETED : REFUNDED);

// The result of `work`, or `fallback` once the deadline has passed (`onLate` is told). The work keeps running; nothing waits for it.
async function until<T>(work: Promise<T>, deadlineAt: number, now: () => number, fallback: T, onLate: () => void): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<T>((resolve) => {
    timer = setTimeout(() => {
      onLate();
      resolve(fallback);
    }, Math.max(0, deadlineAt - now()));
  });
  try {
    return await Promise.race([work, late]);
  } finally {
    clearTimeout(timer);
  }
}

export async function scanSession(deps: ScanDeps, sid: string, session: { mode: Mode; at: number }, opts: ScanOptions = {}): Promise<ScanResult> {
  return (await scanSessionWithView(deps, sid, session, opts)).scan;
}

// The same scan, and the session view it was built on (the snapshot shows both; reading the view again would cost the Redis reads twice).
export async function scanSessionWithView(deps: ScanDeps, sid: string, session: { mode: Mode; at: number }, opts: ScanOptions = {}): Promise<{ scan: ScanResult; view: SessionView }> {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? (() => undefined);
  const started = now();
  const deadlineAt = started + (deps.deadlineMs ?? SCAN_DEADLINE_MS);
  const timeoutFor = () => Math.max(300, Math.min(deadlineAt - now(), 8_000));
  const calls = { captures: 0, refunds: 0, retries: 0 };
  let deadlineHit = false; // the scan stopped waiting for PayPal at the deadline
  const late = () => {
    deadlineHit = true;
  };

  // The witness quarantine is re-verified on every scan, alongside the PayPal reads, and bounded by the same deadline.
  const reverifyP = deps.reverify
    ? until(
        deps.reverify().catch((e) => {
          log({ outcome: "reverify_failed", ...errorFields(e) });
          return { error: "re-verify failed" };
        }),
        deadlineAt,
        now,
        { error: "re-verify did not finish before the deadline" },
        () => undefined,
      )
    : Promise.resolve(undefined);

  const [view, heals] = await Promise.all([buildView(deps.store, sid, session, started), deps.store.heals(sid)]);
  const orders = view.orders.filter((o) => !opts.only || o.captureId === opts.only);

  // ---- 1. the re-query: the capture of every row, then the refund of the rows that look different ----
  const looksDifferent = (o: OrderView) => o.book?.state !== (o.paypal === "REFUNDED" ? "refunded" : "paid"); // by the shop's own record of what it did
  const reading = new Map<string, { status: string } | "failed">();
  const refundReading = new Map<string, string>();

  const read = async <T>(call: (timeoutMs: number) => Promise<T>, what: string, id: string): Promise<T | undefined> => {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (now() >= deadlineAt - 200) return undefined;
      try {
        return await call(timeoutFor());
      } catch (e) {
        log({ outcome: "requery_failed", what, id, attempt, ...errorFields(e) });
        if (attempt === 0) calls.retries++;
      }
    }
    return undefined;
  };

  let listingP: Promise<ListedEvent[] | null> | undefined;
  const startListing = () =>
    (listingP ??= deps.reads
      .listedEvents(Math.min(...orders.map((o) => o.at), started) - LIST_LEAD_MS, timeoutFor())
      .catch((e) => {
        log({ outcome: "event_list_failed", ...errorFields(e) });
        return null;
      }));
  const healing = orders.some((o) => o.events.some((ev) => ev.eid && heals.records[ev.eid]));
  if (orders.some(looksDifferent) || healing || (opts.listing && orders.length > 0)) startListing(); // overlaps with the re-query

  const jobs = [
    ...orders.map((o) => ({ kind: "capture" as const, id: o.captureId, captureId: o.captureId })),
    ...orders.filter((o) => o.paypal === "REFUNDED" && looksDifferent(o)).map((o) => ({ kind: "refund" as const, id: o.events.find((e) => e.kind === "refunded")?.resourceId ?? "", captureId: o.captureId })),
  ].filter((j) => j.id);
  let next = 0;
  const worker = async () => {
    while (next < jobs.length && now() < deadlineAt - 200) {
      const job = jobs[next++];
      if (job.kind === "capture") {
        calls.captures++;
        const c = await read((t) => deps.reads.capture(job.id, t), "capture", job.id);
        reading.set(job.captureId, c ?? "failed");
      } else {
        calls.refunds++;
        const r = await read((t) => deps.reads.refund(job.id, t), "refund", job.id);
        if (r) refundReading.set(job.captureId, r.status);
      }
    }
  };

  // The dispute list of every capture, in a pool of its own (so the capture reads keep the time they had) with the same concurrency, retry and deadline.
  // A refusal of the app (401/403) is not retried and stops the asking for this scan: every other capture would be refused the same way.
  const dReads = deps.disputes?.reads;
  const disputeReading = new Map<string, PaypalDispute[]>();
  let disputesAsked = 0;
  let disputesDenied = false;
  let nextDispute = 0;
  const disputeWorker = async () => {
    while (dReads && !disputesDenied && nextDispute < orders.length && now() < deadlineAt - 200) {
      const captureId = orders[nextDispute++].captureId;
      disputesAsked++;
      for (let attempt = 0; attempt < 2; attempt++) {
        if (now() >= deadlineAt - 200) break;
        try {
          disputeReading.set(captureId, await dReads.disputesOfCapture(captureId, timeoutFor()));
          break;
        } catch (e) {
          log({ outcome: "requery_failed", what: "disputes", id: captureId, attempt, ...errorFields(e) });
          if (isDenied(e)) {
            disputesDenied = true;
            break;
          }
          if (attempt === 0) calls.retries++;
        }
      }
    }
  };
  const poolSize = (jobCount: number) => Math.min(deps.concurrency ?? SCAN_CONCURRENCY, jobCount);
  await until(Promise.all([...Array.from({ length: poolSize(jobs.length) }, worker), ...Array.from({ length: dReads ? poolSize(orders.length) : 0 }, disputeWorker)]), deadlineAt, now, undefined, late);

  const truthOfRow = (o: OrderView): { status: string | null; truth: Truth | null } => {
    const r = reading.get(o.captureId);
    return !r || r === "failed" ? { status: null, truth: null } : { status: r.status, truth: truthOf(r.status) };
  };
  if (orders.some((o) => {
    const { truth } = truthOfRow(o);
    return truth !== null && o.book?.state !== truth;
  })) startListing();
  const listing = listingP ? await until(listingP, deadlineAt, now, null, late) : [];
  const listingRead = listing !== null;
  const listedBy = new Map<string, ListedEvent>();
  for (const l of listing ?? []) listedBy.set(`${l.resourceId}|${l.type}`, l);
  const listedFor = (captureId: string, resourceId: string, type: string) => listedBy.get(`${resourceId}|${type}`) ?? (listing ?? []).find((l) => l.captureId === captureId && l.type === type);

  // The shop webhook's subscription is asked for only when an event exists that the shop has no record of.
  let subscribed: string[] | null | undefined;
  const subscription = async (): Promise<string[] | null> => {
    if (subscribed === undefined) subscribed = await until(deps.reads.subscribedTypes(deps.shopWebhookId, timeoutFor()).catch(() => null), deadlineAt, now, null, late);
    return subscribed;
  };

  // ---- 2. the rows ----
  const rows: ScanRow[] = [];
  const parts = new Map<ScanEvent, { order: OrderView; view: EventView | undefined; row: ScanRow }>();
  for (const o of orders) {
    const { status: paypalStatus, truth } = truthOfRow(o);
    const events: ScanEvent[] = o.events.map((ev) => {
      const listed = listedFor(o.captureId, ev.resourceId, typeOf(ev.kind));
      const eid = ev.eid ?? listed?.eid ?? null;
      const record = eid ? heals.records[eid] : undefined;
      return { kind: ev.kind, resourceId: ev.resourceId, eid, d: ev.heard, s: ev.received, listed: !!listed, ...(listed ? { listedAt: listed.createTime } : {}), finding: null, ring: null, heal: record ? healView(record) : null };
    });
    const row: ScanRow = { n: o.n, captureId: o.captureId, itemName: o.itemName, amount: o.amount, status: "TIED", truth, paypalStatus, refundStatus: refundReading.get(o.captureId) ?? null, book: o.book, events };
    rows.push(row);
    o.events.forEach((ev, i) => parts.set(events[i], { order: o, view: ev, row }));

    if (truth === null) {
      row.status = "UNVERIFIED";
      row.waiting = paypalStatus === null ? "requery_failed" : "status_not_modeled";
      continue;
    }
    if (o.book?.state === truth) continue; // TIED: PayPal's answer and the books agree
    if (truth === "paid" && o.book?.state === "refunded") {
      row.status = "UNVERIFIED"; // the books are ahead of PayPal: not something the shop does
      row.waiting = "status_not_modeled";
      continue;
    }

    // A difference. The event the books are waiting for: the refund when PayPal says refunded, otherwise the payment.
    const kind = truth === "refunded" ? "refunded" : "completed";
    let event = events.find((e) => e.kind === kind);
    if (!event) {
      // PayPal says refunded and the shop has no refund of its own on record (refunded outside the shop): the list may still know the event.
      const l = listedFor(o.captureId, "", REFUNDED);
      event = { kind, resourceId: l?.resourceId ?? "", eid: l?.eid ?? null, d: null, s: null, listed: !!l, ...(l ? { listedAt: l.createTime } : {}), finding: null, ring: null, heal: null };
      events.push(event);
      parts.set(event, { order: o, view: undefined, row });
    }
    const type = typeOf(kind);
    const listed = listedFor(o.captureId, event.resourceId, type);
    const noted = parts.get(event)!.view?.noted ?? false;
    const types = !event.s && !noted && (event.d !== null || !!listed) ? await subscription() : undefined;
    event.finding = classify({
      kind,
      now: now(),
      actionAt: kind === "refunded" ? (o.refundAt ?? o.at) : o.at,
      eid: event.eid,
      d: event.d ? { at: event.d.at } : null,
      listed: listed ? { createTime: listed.createTime } : null,
      listingRead,
      attempts: event.s,
      sNoted: noted,
      subscribed: types ? types.includes(type) || types.includes("*") : undefined, // PayPal lists an all-events webhook as the single type "*" (probe 2026-10-20)
      books: o.book,
    });
    row.status = event.finding.cls === "UNVERIFIED" ? "UNVERIFIED" : "GAP";
    if (event.finding.cls === "UNVERIFIED") row.waiting = event.finding.waiting;
  }

  // ---- 2b. disputes: an open dispute makes its row a GAP or an unverified row (a dispute the shop booked leaves the row as it is) ----
  if (dReads) {
    const open = rows.flatMap((row) => openDisputes(disputeReading.get(row.captureId) ?? []).map((d) => ({ row, d })));
    if (open.length > 0) {
      // Evidence is looked up once for the scan, and only what the classifier needs: the webhooks' subscriptions always; PayPal's list of CREATED
      // events only when the shop's webhook subscribes or that could not be read (an unsubscribed webhook is a final fact without it).
      const failed = (what: string) => (e: unknown): null => {
        log({ outcome: what, ...errorFields(e) });
        return null;
      };
      const webhooks: AppWebhook[] | null = await until(dReads.appWebhooks(timeoutFor()).catch(failed("webhooks_failed")), deadlineAt, now, null, late);
      const events: ListedDisputeEvent[] | "unread" | "not_needed" =
        subscriptionOf(webhooks, deps.shopWebhookId).shop === false
          ? "not_needed"
          : ((await until(dReads.listedDisputeEvents(Math.min(...open.map((x) => x.d.createdAt)) - LIST_LEAD_MS, timeoutFor()).catch(failed("dispute_event_list_failed")), deadlineAt, now, null, late)) ?? "unread");
      for (const { row, d } of open) {
        const event = events === "unread" ? "unread" : events === "not_needed" ? null : (events.find((e) => e.disputeId === d.disputeId) ?? null);
        const report = event !== "unread" && event !== null ? (await deps.store.reports([event.eid]))[0] : null;
        const view = judgeDispute(d, {
          now: now(),
          booked: (await deps.disputes!.booked?.(row.captureId)) ?? [],
          webhooks,
          shopWebhookId: deps.shopWebhookId,
          event,
          attempts: summarizeReport(report, now()),
        });
        row.disputes = [...(row.disputes ?? []), view];
        // The row takes the worse of what the payment compare said and what the dispute says. A GAP by dispute replaces "not modelled" (PENDING).
        if (RANK[view.status] > RANK[row.status]) {
          row.status = view.status;
          if (view.status === "GAP") delete row.waiting;
          else row.waiting = view.finding?.waiting;
        }
      }
    }
  }

  // ---- 3. heal records: arrival, the books read again, a retry when nothing arrived in 60 s ----
  for (const [event, { order, row }] of parts) {
    const record = event.eid ? heals.records[event.eid] : undefined;
    if (record && event.eid && opts.advance !== false) {
      const assessed = assessHeal(record, now(), { attempts: event.s, books: order.book, truth: row.truth });
      let current = assessed.record;
      if (assessed.retry) {
        if (!event.listed) {
          current = { ...assessed.record, state: "lost" }; // the event is not in the list (any more): it cannot be sent again
        } else if (deadlineAt - now() > 2_500) {
          const sent = await sendResend({ store: deps.store, reads: deps.reads, shopWebhookId: deps.shopWebhookId, now, log }, sid, { eid: event.eid, captureId: order.captureId, kind: event.kind, seen: record.seen, booksBefore: record.booksBefore, previous: assessed.record });
          if (sent.result === "sent") current = sent.record;
          else if (sent.result !== "busy") current = { ...assessed.record, state: "lost" }; // the session's five are spent, or PayPal refused: no further sends
        }
      }
      if (JSON.stringify(current) !== JSON.stringify(record)) await deps.store.putHeal(sid, current);
      event.heal = healView(current);
      if (current.arrivedAt !== undefined) {
        const sentBefore = [...current.sends].reverse().find((s) => s <= current.arrivedAt!);
        if (sentBefore !== undefined) event.heal.arrivalSeconds = Math.round((current.arrivedAt - sentBefore) / 100) / 10;
      }
      if (current.answer !== undefined) event.heal.answer = current.answer;
      heals.records[event.eid] = current;
    }
  }
  for (const event of parts.keys()) {
    if (!event.finding) continue;
    const t = now();
    const record = event.eid ? heals.records[event.eid] : undefined;
    event.ring = ringState({
      finding: event.finding,
      eid: event.eid,
      listed: event.listed,
      retriesUntil: retriesPendingUntil(event.s, t),
      inFlight: record?.state === "sent" || record?.state === "arrived",
      resendsUsed: heals.resends,
      now: t,
    });
  }

  const reverify = await reverifyP;
  const byClass: Record<string, number> = {};
  for (const r of rows) for (const e of r.events) if (e.finding) byClass[e.finding.cls] = (byClass[e.finding.cls] ?? 0) + 1;
  const scan: ScanResult = {
    session: { id: sid, mode: session.mode },
    at: started,
    durationMs: now() - started,
    deadlineHit,
    rows,
    summary: { rows: rows.length, tied: rows.filter((r) => r.status === "TIED").length, gaps: rows.filter((r) => r.status === "GAP").length, unverified: rows.filter((r) => r.status === "UNVERIFIED").length, byClass },
    listing: { asked: listingP !== undefined, read: listingRead && listingP !== undefined, events: listing?.length ?? 0 },
    calls,
    ...(dReads ? { disputeReads: { asked: disputesAsked, unreadable: orders.filter((o) => !disputeReading.has(o.captureId)).length } } : {}),
    resendsUsed: heals.resends,
    reverify,
  };
  return { scan, view };
}
