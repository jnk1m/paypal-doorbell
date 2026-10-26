// Writes fixtures/samples/*.json: SAMPLE snapshots that match the RunSnapshot contract, so the screens can be built and filmed-for-layout
// before the real recorded run exists. They are NOT a recording: the orders, ids and times are invented (ids start with SAMPLE_), the
// scan rows come from the real classifier (lib/gaps/classify.ts), and the causes are the real recorded cause answers read through the
// real checks, with the real diff lines of handlers/. lib/ui/source.ts is the one place that decides whether the screens use these or
// the real recording (lib/run/recorded.ts).
//
//   npx tsx lib/ui/build-samples.ts
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { confirmationOf } from "../cause/confirm.ts";
import { diagnose } from "../cause/cause.ts";
import { CAUSE_RECORDINGS_DIR } from "../run/recordings.ts";
import { shopInput } from "../cause/input.ts";
import type { SymptomClass } from "../cause/categories.ts";
import type { RecordedReplays } from "../cause/replay.ts";
import { classify, retriesPendingUntil, ringState, type EventEvidence } from "../gaps/classify.ts";
import type { ScanEvent, ScanResult, ScanRow } from "../gaps/scan.ts";
import { CATALOG, type ItemId } from "../shop/catalog.ts";
import { computeDiffs } from "../shop/diffs.ts";
import { MODE_FILE, PLANTED_LABEL } from "../shop/mode-files.ts";
import type { AttemptReport } from "../shop/reporter.ts";
import { isBroken, type BookEntry, type HealState, type Mode, type PlantedMode } from "../shop/types.ts";
import type { EventView, OrderView, SessionView } from "../shop/view.ts";
import type { Certificate, GapCause, Heartbeat, RecordedScenario, RunSnapshot } from "../run/snapshot.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const OUT = join(ROOT, "fixtures/samples");

// ---- a tiny clock ----------------------------------------------------------------------------------------------------------

const DAY = Date.UTC(2026, 9, 19, 0, 0, 0);
const at = (h: number, m: number, s = 0, ms = 0): number => DAY + (((h * 60 + m) * 60 + s) * 1000 + ms);

// ---- a world: orders, events, books ----------------------------------------------------------------------------------------

interface EvSpec {
  eid: string | null;
  heardAt?: number;
  attempts?: AttemptReport[] | null;
  listedAt?: number | null; // when PayPal's events list shows it (createTime); null = not listed
}

interface OrderSpec {
  n: number;
  item: ItemId;
  payAt: number;
  pay: EvSpec;
  refund?: { at: number; id: string; ev: EvSpec };
  book: BookEntry | null;
  heal?: { kind: "completed" | "refunded"; state: HealState; sends: number; arrivalSeconds?: number; answer?: number };
}

const capId = (n: number) => `SAMPLE_CAP_${String(n).padStart(4, "0")}`;
const rx = (tid: string, receivedAt: number, status: number, afterMs = 180): AttemptReport => ({ tid, attempt: `${tid}-${receivedAt}`, receivedAt, state: "responded", status, respondedAt: receivedAt + afterMs });
const book = (state: "paid" | "refunded", amount: string, eid: string, when: number): BookEntry => ({ state, amount, eid, at: when });

interface World {
  session: SessionView;
  scan: ScanResult;
}

function buildWorld(o: { sid: string; mode: Mode; startedAt: number; now: number; orders: OrderSpec[]; resendsUsed: number }): World {
  const orderViews: OrderView[] = [];
  const rows: ScanRow[] = [];
  const listing = { asked: true, read: true, events: 0 };
  for (const s of o.orders) {
    const amount = CATALOG[s.item].price;
    const parts = [
      { kind: "completed" as const, resourceId: capId(s.n), spec: s.pay, actionAt: s.payAt },
      ...(s.refund ? [{ kind: "refunded" as const, resourceId: s.refund.id, spec: s.refund.ev, actionAt: s.refund.at }] : []),
    ];
    const views: EventView[] = parts.map((p) => ({ kind: p.kind, resourceId: p.resourceId, eid: p.spec.eid, heard: p.spec.heardAt !== undefined ? { at: p.spec.heardAt, slot: "D" } : null, received: p.spec.attempts ?? null, noted: !!p.spec.attempts }));
    const expected = s.refund ? "refunded" : "paid";
    const lastAction = s.refund?.at ?? s.payAt;
    orderViews.push({
      n: s.n,
      item: s.item,
      itemName: CATALOG[s.item].name,
      amount,
      orderId: `SAMPLE_ORD_${String(s.n).padStart(4, "0")}`,
      captureId: capId(s.n),
      invoiceId: `SAMPLE-INV-${s.n}`,
      at: s.payAt,
      refundAt: s.refund?.at ?? null,
      paypal: s.refund ? "REFUNDED" : "COMPLETED",
      book: s.book,
      books: s.book?.state === expected ? "agree" : o.now - lastAction < 45_000 ? "waiting" : "differ",
      events: views,
    });

    const events: ScanEvent[] = parts.map((p) => {
      const listed = p.spec.listedAt !== undefined && p.spec.listedAt !== null && p.spec.listedAt <= o.now; // the list shows it only after its lag
      if (listed) listing.events++;
      const h = s.heal && s.heal.kind === p.kind ? { state: s.heal.state, sends: s.heal.sends, ...(s.heal.arrivalSeconds !== undefined ? { arrivalSeconds: s.heal.arrivalSeconds } : {}), ...(s.heal.answer !== undefined ? { answer: s.heal.answer } : {}) } : null;
      return { kind: p.kind, resourceId: p.resourceId, eid: p.spec.eid, d: p.spec.heardAt !== undefined ? { at: p.spec.heardAt, slot: "D" } : null, s: p.spec.attempts ?? null, listed, finding: null, ring: null, heal: h };
    });
    const row: ScanRow = { n: s.n, captureId: capId(s.n), itemName: CATALOG[s.item].name, amount, status: "TIED", truth: expected, paypalStatus: s.refund ? "REFUNDED" : "COMPLETED", refundStatus: s.refund ? "COMPLETED" : null, book: s.book, events };
    rows.push(row);

    if (s.book?.state === expected) continue;
    const kind = expected === "refunded" ? "refunded" : "completed";
    const ev = events.find((e) => e.kind === kind)!;
    const spec = parts.find((p) => p.kind === kind)!;
    const evidence: EventEvidence = {
      kind,
      now: o.now,
      actionAt: spec.actionAt,
      eid: ev.eid,
      d: ev.d ? { at: ev.d.at } : null,
      listed: ev.listed && spec.spec.listedAt ? { createTime: spec.spec.listedAt } : null,
      listingRead: true,
      attempts: ev.s,
      sNoted: !!ev.s,
      subscribed: undefined,
      books: s.book,
    };
    ev.finding = classify(evidence);
    row.status = ev.finding.cls === "UNVERIFIED" ? "UNVERIFIED" : "GAP";
    if (ev.finding.cls === "UNVERIFIED") row.waiting = ev.finding.waiting;
    ev.ring = ringState({ finding: ev.finding, eid: ev.eid, listed: ev.listed, retriesUntil: retriesPendingUntil(ev.s, o.now), inFlight: ev.heal?.state === "sent" || ev.heal?.state === "arrived", resendsUsed: o.resendsUsed, now: o.now });
  }

  const byClass: Record<string, number> = {};
  for (const r of rows) for (const e of r.events) if (e.finding) byClass[e.finding.cls] = (byClass[e.finding.cls] ?? 0) + 1;
  const scan: ScanResult = {
    session: { id: o.sid, mode: o.mode },
    at: o.now,
    durationMs: 2900,
    deadlineHit: false,
    rows,
    summary: { rows: rows.length, tied: rows.filter((r) => r.status === "TIED").length, gaps: rows.filter((r) => r.status === "GAP").length, unverified: rows.filter((r) => r.status === "UNVERIFIED").length, byClass },
    listing,
    calls: { captures: rows.length, refunds: rows.filter((r) => r.status === "GAP" && r.truth === "refunded").length, retries: 0 },
    resendsUsed: o.resendsUsed,
    reverify: null,
  };
  const session: SessionView = { session: { id: o.sid, mode: o.mode, planted: isBroken(o.mode), plantedLabel: PLANTED_LABEL, file: MODE_FILE[o.mode], at: o.startedAt }, orders: orderViews, now: o.now };
  return { session, scan };
}

// ---- the certificate and the witness, from the scan -------------------------------------------------------------------------

const money2 = (minor: number): string => `${Math.floor(minor / 100)}.${String(minor % 100).padStart(2, "0")}`;
const minorOf = (v: string): number => Math.round(Number(v) * 100);
const s = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

function certificateOf(scan: ScanResult): Certificate {
  const { rows } = scan;
  const gapRows = rows.filter((r) => r.status === "GAP");
  const refundGaps = gapRows.filter((r) => r.truth === "refunded");
  const tied = rows.filter((r) => r.status === "TIED").length;
  const unverified = rows.filter((r) => r.status === "UNVERIFIED").length;
  const checked = tied + gapRows.length;
  const pct = Math.floor((checked / rows.length) * 100);
  const minor = refundGaps.reduce((sum, r) => sum + minorOf(r.amount), 0);
  const stamp = gapRows.length > 0 ? "red" : unverified > 0 || checked < rows.length ? "amber" : "green";
  const notInBooks = `$${money2(minor)} across ${s(refundGaps.length, "refund")} not in books`;
  const stampText = stamp === "red" ? `${s(gapRows.length, "gap")} · ${notInBooks}` : stamp === "amber" ? `Tied on ${tied}/${rows.length} · ${unverified} unverified` : `Tied on ${tied}/${rows.length} of what we can see`;
  const nowhere = rows.flatMap((r) => r.events).filter((e) => e.finding?.cls === "NO_EVENT_FOUND").length;
  const inLag = rows.filter((r) => r.waiting === "absence_window").length;
  const header = `Checked ${checked} of ${rows.length} captures (${pct}%) · ${unverified} too new to verify · ${notInBooks}.`;
  const ownerView = [
    `We looked at ${s(rows.length, "sale")} in the Maple Mug books and asked PayPal about each one.`,
    tied === rows.length ? `All ${rows.length} agree with PayPal's own answer.` : `${s(tied, "sale")} agree${tied === 1 ? "s" : ""} with PayPal's own answer.`,
    ...(refundGaps.length > 0 ? [`${s(refundGaps.length, "refund")}, $${money2(minor)} in total, ${refundGaps.length === 1 ? "is" : "are"} not in your books. PayPal says the customer was refunded; your books still say they paid.`] : []),
    ...(unverified > 0 ? [`${s(unverified, "sale")} ${unverified === 1 ? "is" : "are"} too new to judge. Ask again in a few minutes.`] : []),
    "What we could not check: orders that were approved but never charged cannot be counted, and the last 2 hours of PayPal's own history were not used.",
  ];
  return {
    stamp,
    stampText,
    header,
    numbers: { rows: rows.length, checked, tied, gaps: gapRows.length, unverified, healed: 0, coveragePct: pct, moneyNotInBooks: money2(minor), refundsNotInBooks: refundGaps.length, byClass: scan.summary.byClass },
    limits: [
      `Events found nowhere (PayPal making them cannot be proven): ${nowhere}.`,
      `Rows inside the events list lag (80 to 163 s), where a missing event cannot be claimed yet: ${inLag}.`,
      "Re-queries that failed: 0.",
    ],
    footnote:
      "Approved but never captured orders cannot be counted (PayPal has no list for them). An event that is not in PayPal's events list cannot be proven to have existed. Transaction Search runs 97 to 128 minutes late, so the last 2 hours were not used. This certificate is not signed.",
    ownerView,
    scopeAt: scan.at,
    signed: false,
  };
}

function heartbeatOf(scan: ScanResult, lastDeliveryAt: number, state: Heartbeat["state"] = "ok"): Heartbeat {
  const ago = Math.round((scan.at - lastDeliveryAt) / 1000);
  if (state === "silent") return { lastDeliveryAt, listedMissedByWitness: null, state, text: `Witness: no delivery for ${Math.round(ago / 60)} min · nothing to compare` };
  return { lastDeliveryAt, listedMissedByWitness: 0, state, text: `Witness: last delivery ${ago} s ago · events list shows 0 the witness missed` };
}

// ---- causes: the real recorded answers, read through the real checks ---------------------------------------------------------

const SYMPTOM: Record<PlantedMode, SymptomClass> = { bad_body: "all_401", ack_then_drop: "2xx_but_books_unchanged", last_write_wins: "2xx_but_books_unchanged" };
const recorded = JSON.parse(readFileSync(join(ROOT, "fixtures/replay/recorded.json"), "utf8")) as RecordedReplays;
const bundle = computeDiffs(ROOT);

async function causeFor(mode: PlantedMode, captureId: string, replayed: boolean): Promise<GapCause> {
  const cause = await diagnose(shopInput(mode, bundle, SYMPTOM[mode]), { mode: "replay", dir: CAUSE_RECORDINGS_DIR, log: () => undefined });
  if (cause.status !== "proposed") throw new Error(`no recorded cause for ${mode}: ${cause.status}`);
  const replay = replayed ? { ...recorded[mode]!, basis: "recorded" as const } : null;
  return { captureId, mode, cause, replay, confirmation: confirmationOf(cause, replay ?? undefined) };
}

// ---- the three scenarios -----------------------------------------------------------------------------------------------------

const TID = (n: string) => `SAMPLE-TID-${n}`;

interface Step {
  now: number;
  mode: Mode;
  orders: OrderSpec[];
  resendsUsed: number;
  causes: "none" | "proposed" | "confirmed";
  title: string;
  lastDelivery: number;
}

async function snapshots(planted: PlantedMode, sid: string, startedAt: number, steps: Step[]): Promise<RunSnapshot[]> {
  const out: RunSnapshot[] = [];
  for (let i = 0; i < steps.length; i++) {
    const st = steps[i];
    const w = buildWorld({ sid, mode: st.mode, startedAt, now: st.now, orders: st.orders, resendsUsed: st.resendsUsed });
    const causes: GapCause[] = [];
    if (st.causes !== "none") for (const r of w.scan.rows) if (r.status === "GAP" || r.events.some((e) => e.heal)) causes.push(await causeFor(planted, r.captureId, st.causes === "confirmed"));
    out.push({
      mode: "RECORDED RUN",
      recordedAt: st.now,
      step: { index: i + 1, of: steps.length, title: st.title },
      session: w.session,
      scan: w.scan,
      causes,
      certificate: certificateOf(w.scan),
      heartbeat: heartbeatOf(w.scan, st.lastDelivery),
    });
  }
  return out;
}

// Scenario 1: ack_then_drop. Two refunds reach the shop, the handler answers 200 and books nothing.
async function refundNeverBooked(): Promise<RecordedScenario> {
  const base = (): OrderSpec[] => [
    { n: 1, item: "ethiopia-250", payAt: at(8, 0, 10), pay: { eid: "WH-S1-PAY-1", heardAt: at(8, 0, 21), attempts: [rx(TID("1a"), at(8, 0, 21), 200)], listedAt: at(8, 1, 40) }, book: book("paid", "18.00", "WH-S1-PAY-1", at(8, 0, 21)) },
    { n: 4, item: "colombia-250", payAt: at(8, 0, 40), pay: { eid: "WH-S1-PAY-4", heardAt: at(8, 0, 52), attempts: [rx(TID("4a"), at(8, 0, 52), 200)], listedAt: at(8, 2, 5) }, book: book("paid", "16.50", "WH-S1-PAY-4", at(8, 0, 52)) },
    { n: 5, item: "house-250", payAt: at(8, 0, 55), pay: { eid: "WH-S1-PAY-5", heardAt: at(8, 1, 6), attempts: [rx(TID("5a"), at(8, 1, 6), 200)], listedAt: at(8, 2, 20) }, book: book("paid", "14.00", "WH-S1-PAY-5", at(8, 1, 6)) },
  ];
  const lost = (n: number, refundAt: number, heard: number): OrderSpec => ({
    n,
    item: "gift-set",
    payAt: at(8, 1, n === 2 ? 2 : 20),
    pay: { eid: `WH-S1-PAY-${n}`, heardAt: at(8, 1, n === 2 ? 13 : 31), attempts: [rx(TID(`${n}a`), at(8, 1, n === 2 ? 13 : 31), 200)], listedAt: at(8, 2, 30) },
    refund: { at: refundAt, id: `SAMPLE_REF_${n}`, ev: { eid: `WH-S1-REF-${n}`, heardAt: heard, attempts: [rx(TID(`${n}r`), heard, 200)], listedAt: heard + 84_000 } },
    book: book("paid", "48.00", `WH-S1-PAY-${n}`, at(8, 1, n === 2 ? 13 : 31)), // the refund event was answered 200 and never booked
  });
  const healed = (n: number, refundAt: number, heard: number, arrivedAt: number): OrderSpec => ({
    ...lost(n, refundAt, heard),
    refund: { at: refundAt, id: `SAMPLE_REF_${n}`, ev: { eid: `WH-S1-REF-${n}`, heardAt: heard, attempts: [rx(TID(`${n}r`), heard, 200), rx(TID(`${n}r2`), arrivedAt, 200)], listedAt: heard + 84_000 } },
    book: book("refunded", "48.00", `WH-S1-REF-${n}`, arrivedAt + 400),
    heal: { kind: "refunded", state: "healed", sends: 1, arrivalSeconds: 2.8, answer: 200 },
  });
  const gaps = [lost(2, at(8, 2, 9), at(8, 2, 20)), lost(3, at(8, 2, 15), at(8, 2, 26))];
  const steps: Step[] = [
    { now: at(8, 4, 5), mode: "ack_then_drop", orders: [base()[0], ...gaps, ...base().slice(1)], resendsUsed: 0, causes: "none", title: "Doorbell finds 2 gaps", lastDelivery: at(8, 2, 26) },
    { now: at(8, 4, 41), mode: "ack_then_drop", orders: [base()[0], ...gaps, ...base().slice(1)], resendsUsed: 0, causes: "confirmed", title: "The cause, checked by replay", lastDelivery: at(8, 2, 26) },
    { now: at(8, 6, 2), mode: "good", orders: [base()[0], healed(2, at(8, 2, 9), at(8, 2, 20), at(8, 5, 23)), healed(3, at(8, 2, 15), at(8, 2, 26), at(8, 5, 26)), ...base().slice(1)], resendsUsed: 2, causes: "confirmed", title: "Fix it, ring again, read the certificate", lastDelivery: at(8, 5, 26) },
  ];
  const steps3 = steps.map((x) => ({ ...x, orders: [...x.orders].sort((a, b) => a.n - b.n) }));
  return { id: "refund_never_booked", title: "Refund never booked", plantedMode: "ack_then_drop", capturedAt: at(8, 0, 0), steps: await snapshots("ack_then_drop", "sample-session-1", at(8, 0, 0), steps3), paypalIds: [] };
}

// Scenario 2: last_write_wins. The refund arrives first; a payment event that arrives after it writes "paid" on top. The last step shows an
// amber stamp: the gap is healed, one row is still too new to verify.
async function latePaymentOverwrites(): Promise<RecordedScenario> {
  const plain = (n: number, item: ItemId, payAt: number, heard: number, eid: string, amount: string): OrderSpec => ({ n, item, payAt, pay: { eid, heardAt: heard, attempts: [rx(TID(`${n}a`), heard, 200)], listedAt: heard + 80_000 }, book: book("paid", amount, eid, heard) });
  const common = (): OrderSpec[] => [plain(1, "house-250", at(8, 20, 0), at(8, 20, 11), "WH-S2-PAY-1", "14.00"), plain(3, "colombia-250", at(8, 20, 20), at(8, 20, 31), "WH-S2-PAY-3", "16.50"), plain(4, "ethiopia-250", at(8, 20, 40), at(8, 20, 51), "WH-S2-PAY-4", "18.00")];
  // n2: refund event first (08:21:51), then the original payment event again (08:21:54): books end on "paid".
  const refundFirst = at(8, 21, 51);
  const late = at(8, 21, 54);
  const n2 = (healedAt?: number): OrderSpec => ({
    n: 2,
    item: "gift-set",
    payAt: at(8, 20, 5),
    pay: { eid: "WH-S2-PAY-2", heardAt: late, attempts: [rx(TID("2a"), at(8, 20, 16), 200), rx(TID("2b"), late, 200)], listedAt: at(8, 21, 20) },
    refund: { at: at(8, 21, 40), id: "SAMPLE_REF_2", ev: { eid: "WH-S2-REF-2", heardAt: refundFirst, attempts: [rx(TID("2r"), refundFirst, 200), ...(healedAt ? [rx(TID("2r2"), healedAt, 200)] : [])], listedAt: at(8, 23, 5) } },
    book: healedAt ? book("refunded", "48.00", "WH-S2-REF-2", healedAt + 400) : book("paid", "48.00", "WH-S2-PAY-2", late),
    ...(healedAt ? { heal: { kind: "refunded" as const, state: "healed" as const, sends: 1, arrivalSeconds: 3.1, answer: 200 } } : {}),
  });
  // n5: a refund asked a minute ago: PayPal says refunded, nobody has the event yet, so the row is not provable yet.
  const n5: OrderSpec = { n: 5, item: "house-250", payAt: at(8, 24, 10), pay: { eid: "WH-S2-PAY-5", heardAt: at(8, 24, 21), attempts: [rx(TID("5a"), at(8, 24, 21), 200)], listedAt: at(8, 25, 40) }, refund: { at: at(8, 26, 12), id: "SAMPLE_REF_5", ev: { eid: null, listedAt: null } }, book: book("paid", "14.00", "WH-S2-PAY-5", at(8, 24, 21)) };
  const early = (): OrderSpec[] => [...common(), n2()].sort((a, b) => a.n - b.n);
  const steps: Step[] = [
    { now: at(8, 23, 20), mode: "last_write_wins", orders: early(), resendsUsed: 0, causes: "none", title: "Doorbell finds 1 gap", lastDelivery: late },
    { now: at(8, 23, 55), mode: "last_write_wins", orders: early(), resendsUsed: 0, causes: "confirmed", title: "The cause, checked by replay", lastDelivery: late },
    { now: at(8, 27, 8), mode: "good", orders: [...common(), n2(at(8, 25, 2)), n5].sort((a, b) => a.n - b.n), resendsUsed: 1, causes: "confirmed", title: "Fix it, ring again, read the certificate", lastDelivery: at(8, 26, 12) },
  ];
  return { id: "late_payment_overwrites", title: "Late payment overwrites a refund", plantedMode: "last_write_wins", capturedAt: at(8, 20, 0), steps: await snapshots("last_write_wins", "sample-session-2", at(8, 20, 0), steps), paypalIds: [] };
}

// Scenario 3: bad_body. The shop answers 401 three times to each refund event, 34 s and 160 s apart; the Sandbox then gives up. After the fix,
// one resend never arrives and one is still on its way: the stamp stays red.
async function signatureRejected(): Promise<RecordedScenario> {
  const plain = (n: number, item: ItemId, payAt: number, heard: number, eid: string, amount: string): OrderSpec => ({ n, item, payAt, pay: { eid, heardAt: heard, attempts: [rx(TID(`${n}a`), heard, 200)], listedAt: heard + 82_000 }, book: book("paid", amount, eid, heard) });
  const rejected = (n: number, item: ItemId, amount: string, refundAt: number, first: number, extra?: Partial<OrderSpec>): OrderSpec => ({
    ...plain(n, item, at(8, 40, n === 2 ? 5 : 20), at(8, 40, n === 2 ? 16 : 31), `WH-S3-PAY-${n}`, amount),
    refund: { at: refundAt, id: `SAMPLE_REF_${n}`, ev: { eid: `WH-S3-REF-${n}`, heardAt: first, attempts: [rx(TID(`${n}r`), first, 401, 120), rx(TID(`${n}r`), first + 34_000, 401, 120), rx(TID(`${n}r`), first + 160_000, 401, 120)], listedAt: first + 83_000 } },
    ...extra,
  });
  const a = at(8, 42, 9);
  const b = at(8, 42, 15);
  const before = (): OrderSpec[] => [plain(1, "house-250", at(8, 39, 40), at(8, 39, 51), "WH-S3-PAY-1", "14.00"), rejected(2, "gift-set", "48.00", at(8, 42, 3), a), rejected(3, "colombia-250", "16.50", at(8, 42, 9), b), plain(4, "ethiopia-250", at(8, 39, 55), at(8, 40, 6), "WH-S3-PAY-4", "18.00")].sort((x, y) => x.n - y.n);
  const after = (): OrderSpec[] => [
    plain(1, "house-250", at(8, 39, 40), at(8, 39, 51), "WH-S3-PAY-1", "14.00"),
    rejected(2, "gift-set", "48.00", at(8, 42, 3), a, { heal: { kind: "refunded", state: "lost", sends: 3 } }),
    rejected(3, "colombia-250", "16.50", at(8, 42, 9), b, { heal: { kind: "refunded", state: "sent", sends: 1 } }),
    plain(4, "ethiopia-250", at(8, 39, 55), at(8, 40, 6), "WH-S3-PAY-4", "18.00"),
  ];
  const steps: Step[] = [
    { now: at(8, 45, 20), mode: "bad_body", orders: before(), resendsUsed: 0, causes: "none", title: "Doorbell finds 2 gaps", lastDelivery: b + 160_000 },
    { now: at(8, 45, 55), mode: "bad_body", orders: before(), resendsUsed: 0, causes: "confirmed", title: "The cause, checked by replay", lastDelivery: b + 160_000 },
    { now: at(8, 49, 40), mode: "good", orders: after(), resendsUsed: 4, causes: "confirmed", title: "Fix it, ring again, read the certificate", lastDelivery: at(8, 48, 52) },
  ];
  return { id: "signature_rejected", title: "Signature rejected, 401 ×3", plantedMode: "bad_body", capturedAt: at(8, 39, 40), steps: await snapshots("bad_body", "sample-session-3", at(8, 39, 40), steps), paypalIds: [] };
}

// ---- the extra states for the gallery -----------------------------------------------------------------------------------------

function emptyState(): RunSnapshot {
  return {
    mode: "RECORDED RUN",
    recordedAt: at(8, 0, 0),
    step: null,
    session: { session: { id: "sample-session-0", mode: "good", planted: false, plantedLabel: PLANTED_LABEL, file: MODE_FILE.good, at: at(8, 0, 0) }, orders: [], now: at(8, 0, 30) },
    scan: null,
    causes: [],
    certificate: null,
    heartbeat: { lastDeliveryAt: at(7, 58, 0), listedMissedByWitness: 0, state: "ok", text: "Witness: last delivery 150 s ago · events list shows 0 the witness missed" },
  };
}

function write(name: string, value: unknown): void {
  writeFileSync(join(OUT, name), `${JSON.stringify(value, null, 1)}\n`);
  console.log("wrote", name);
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const one = await refundNeverBooked();
  const two = await latePaymentOverwrites();
  const three = await signatureRejected();
  write("recorded-refund_never_booked.json", one);
  write("recorded-late_payment_overwrites.json", two);
  write("recorded-signature_rejected.json", three);
  write("state-empty.json", emptyState());
  // The witness silent: the amber snapshot with a heartbeat that says there was no recent delivery.
  const amber = two.steps[2];
  write("state-silent.json", { ...amber, step: null, heartbeat: heartbeatOf(amber.scan!, amber.scan!.at - 47 * 60_000, "silent") });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
