// The witness's hook for the shop (S2): when the witness D has verified and stored the first attempt of a delivery that is about a
// shop order, note it under the resource it is about, so the stamp screen can ask "did D hear this?" before it knows the event id.
// One Redis command per such delivery; deliveries about anything else cost none. It reads the stored entry, never the request.
import { parseEvent } from "../witness/precheck.ts";
import type { AttemptEntry } from "../witness/store.ts";
import { bookingOf } from "./events.ts";
import type { Heard, ShopStore } from "./store.ts";

export function noteWhatWitnessHeard(store: Pick<ShopStore, "noteHeard">): (entry: AttemptEntry) => Promise<void> {
  return async (entry) => {
    if (entry.raw === undefined) return;
    const parsed = parseEvent(entry.raw);
    if (!parsed.ok) return;
    const booking = bookingOf(parsed.parsed.event);
    if (!booking) return;
    const heard: Heard = { eid: entry.eid, tid: entry.tid, at: entry.at, slot: entry.slot };
    await store.noteHeard({ resourceId: booking.resourceId, type: booking.type }, heard);
  };
}
