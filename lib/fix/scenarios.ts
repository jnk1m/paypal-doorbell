// Real signed deliveries for the referee, and PayPal's own answer for each order (LOCAL ONLY, like the rest of the proof).
//
// Two sources:
//   pickScenarios      scripts/record-fix.ts: the freshest orders in the witness's whole record, whatever session they belong to
//   scenariosFromScan  scripts/record-run.ts: the orders of ONE recorded session, as its scan saw them (the witness copy of each delivery)
// The bodies are Sandbox data and stay out of the repository (like the replay of lib/cause/replay-source.ts): a scenario lives for the length
// of one run. What is stored is the result of the proof, not its inputs.
import { bookingOf, COMPLETED, REFUNDED } from "../shop/events.ts";
import type { ScanResult } from "../gaps/scan.ts";
import { parseEvent } from "../witness/precheck.ts";
import type { AttemptEntry, WitnessStore } from "../witness/store.ts";
import type { Delivery, Scenario } from "./referee.ts";

export type PickedScenario = Scenario & { truthStatus: string; ageHoursWhenPrepared: number; tids: string[] };

// PayPal's GET capture status in the shop's words.
export function truthOf(status: string): "paid" | "refunded" | undefined {
  if (status === "REFUNDED" || status === "PARTIALLY_REFUNDED") return "refunded";
  if (status === "COMPLETED") return "paid";
  return undefined;
}

export interface StoredRow {
  entry: AttemptEntry;
  capture: string;
  type: string;
}

export function rowOf(entry: AttemptEntry): StoredRow | undefined {
  if (entry.st !== "ok" || !entry.raw || entry.big) return undefined;
  try {
    const b = bookingOf(JSON.parse(entry.raw));
    return b ? { entry, capture: b.captureId, type: b.type } : undefined;
  } catch {
    return undefined;
  }
}

export function deliveryOf(entry: AttemptEntry, webhookId: string): Delivery {
  return { raw: entry.raw!, webhookId, headers: { transmissionId: entry.tid, transmissionTime: entry.h.time, transmissionSig: entry.h.sig, certUrl: entry.h.cert, authAlgo: entry.h.algo } };
}

// The webhook an entry was signed for (scripts/s4-acceptance.ts): before the demo app took the witness slot over, "D" meant the dev app's webhook.
export function webhookIdOfEntry(entry: AttemptEntry, ids: { demo: string; dev: string }): string {
  const DEMO_D_SINCE = Date.parse("2026-10-19T03:59:13Z");
  return entry.slot === "D-dev" || Date.parse(entry.h.time) < DEMO_D_SINCE ? ids.dev : ids.demo;
}

// `count` freshest orders with a payment and a refund stored, then `singles` freshest orders with only a payment (PayPal says COMPLETED): the
// singles show a handler that drops payments, which a payment-then-refund order hides (the refund overwrites the missing "paid"). An order
// whose capture PayPal cannot be asked about, or whose status is not paid/refunded, is skipped.
export async function pickScenarios(rows: StoredRow[], count: number, ids: { demo: string; dev: string }, getCapture: (id: string) => Promise<string>, now = Date.now(), singles = 0): Promise<PickedScenario[]> {
  const by = new Map<string, StoredRow[]>();
  for (const r of rows) by.set(r.capture, [...(by.get(r.capture) ?? []), r]);
  const newest = (rs: StoredRow[]) => Math.max(...rs.map((r) => Date.parse(r.entry.h.time)));
  const pairs = [...by.entries()]
    .filter(([, rs]) => rs.some((r) => r.type === COMPLETED) && rs.some((r) => r.type === REFUNDED))
    .map(([capture, rs]) => ({ capture, rs: [rs.find((r) => r.type === COMPLETED)!, rs.find((r) => r.type === REFUNDED)!].sort((a, b) => a.entry.at - b.entry.at) }))
    .sort((a, b) => newest(b.rs) - newest(a.rs));
  const alone = [...by.entries()]
    .filter(([, rs]) => rs.length === 1 && rs[0].type === COMPLETED)
    .map(([capture, rs]) => ({ capture, rs }))
    .sort((a, b) => newest(b.rs) - newest(a.rs));
  const out: PickedScenario[] = [];
  for (const [list, want, expect] of [[pairs, count, "refunded"], [alone, singles, "paid"]] as const) {
    let taken = 0;
    for (const p of list) {
      if (taken >= want) break;
      let truthStatus: string;
      try {
        truthStatus = await getCapture(p.capture);
      } catch {
        continue; // PayPal has no such capture for this app (an order of the other Sandbox app)
      }
      const truth = truthOf(truthStatus);
      if (truth !== expect) continue;
      taken++;
      out.push({ capture: p.capture, truth, truthStatus, deliveries: p.rs.map((r) => deliveryOf(r.entry, webhookIdOfEntry(r.entry, ids))), tids: p.rs.map((r) => r.entry.tid), ageHoursWhenPrepared: Math.max(...p.rs.map((r) => (now - Date.parse(r.entry.h.time)) / 3.6e6)) });
    }
  }
  return out;
}

// The orders of one recorded session as its scan saw them: every row PayPal answered for (`truth`), whose events the witness ALL heard, stored
// and still holds. The deliveries of a row are in the order the witness received them. A row with an event the witness never heard is left
// out (there is no real delivery to replay for it), and so is a delivery whose stored copy is gone or was never verified.
export async function scenariosFromScan(scan: ScanResult, witness: Pick<WitnessStore, "attempts">, webhookIdOf: (entry: AttemptEntry) => string | undefined): Promise<Scenario[]> {
  const out: Scenario[] = [];
  for (const row of scan.rows) {
    if (row.truth === null || row.events.length === 0) continue;
    const heard = row.events.map((e) => e.d);
    if (heard.some((h) => !h?.tid)) continue;
    const entries: AttemptEntry[] = [];
    for (const h of heard) {
      const entry = (await witness.attempts(h!.tid!))[0]; // the first attempt is the one that was verified and processed
      if (!entry || entry.st !== "ok" || !entry.raw || entry.big || !parseEvent(entry.raw).ok) break;
      entries.push(entry);
    }
    if (entries.length !== heard.length) continue;
    const webhookIds = entries.map((e) => webhookIdOf(e));
    if (webhookIds.some((w) => !w)) continue;
    entries.sort((a, b) => a.at - b.at);
    out.push({ capture: row.captureId, truth: row.truth, deliveries: entries.map((e) => deliveryOf(e, webhookIdOf(e)!)) });
  }
  return out;
}
