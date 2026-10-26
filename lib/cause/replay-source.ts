// Where a replay gets its real deliveries: the witness's own record (lib/witness/store.ts), by transmission id. A reference holds only
// ids; the signed bodies stay in Redis (they expire with it) and are never copied into the repository.
import { parseEvent } from "../witness/precheck.ts";
import type { AttemptEntry, WitnessStore } from "../witness/store.ts";
import type { PlantedMode } from "../shop/types.ts";
import type { ReplayCase, ReplayDelivery } from "./replay.ts";

export interface ReplayRef {
  mode: PlantedMode;
  tids: string[]; // in the order the events really arrived
}

export async function loadReplayCase(store: Pick<WitnessStore, "attempts">, ref: ReplayRef, webhookIdOf: (entry: AttemptEntry) => string | undefined): Promise<ReplayCase> {
  const deliveries: ReplayDelivery[] = [];
  for (const tid of ref.tids) {
    // The first element is the attempt that was verified and processed (witness store, R2).
    const entry = (await store.attempts(tid))[0];
    if (!entry) throw new Error(`replay ${ref.mode}: the witness has no record of transmission ${tid.slice(0, 8)} (expired?)`);
    if (entry.st !== "ok") throw new Error(`replay ${ref.mode}: transmission ${tid.slice(0, 8)} was never verified by the witness`);
    if (!entry.raw || entry.big) throw new Error(`replay ${ref.mode}: transmission ${tid.slice(0, 8)} has no stored body`);
    if (!parseEvent(entry.raw).ok) throw new Error(`replay ${ref.mode}: transmission ${tid.slice(0, 8)} does not hold a PayPal event`);
    const webhookId = webhookIdOf(entry);
    if (!webhookId) throw new Error(`replay ${ref.mode}: no webhook id for slot ${entry.slot}`);
    deliveries.push({ raw: entry.raw, webhookId, headers: { transmissionId: entry.tid, transmissionTime: entry.h.time, transmissionSig: entry.h.sig, certUrl: entry.h.cert, authAlgo: entry.h.algo } });
  }
  return { mode: ref.mode, deliveries };
}
