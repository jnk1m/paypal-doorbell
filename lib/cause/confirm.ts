// Which causes a replay can confirm (plan 5.4 #3). A replay runs the good build and one planted bad build on real events and shows that
// they differ the way THAT bug predicts. It says nothing about any other cause the model might name for the same diff: a bad_body diff
// that fails the signature on every delivery is confirmed as RAW_BODY_ALTERED, and the same green chip must not be shown next to
// "WRONG_WEBHOOK_ID" just because that answer also passed C2 and C1'. So the chip is a function of the cause AND the replay, in one
// place, with fixed words only.
import type { Category } from "./categories.ts";
import type { CauseResult } from "./cause.ts";
import type { ReplayResult } from "./replay.ts";
import type { PlantedMode } from "../shop/types.ts";

// The category each planted bug is. (last_write_wins removes a guard that no named category describes, so it is OTHER_CODE_CHANGE.)
export const CONFIRMABLE: Record<PlantedMode, readonly Category[]> = {
  bad_body: ["RAW_BODY_ALTERED"],
  ack_then_drop: ["WORK_AFTER_ACK"],
  last_write_wins: ["OTHER_CODE_CHANGE"],
};

export interface Confirmation {
  confirmed: boolean;
  chip: string; // the words on the chip
  note?: string; // a fixed line under it, when the chip is not green
}

export const CHIP_CONFIRMED = "CONFIRMED BY REPLAY";
export const CHIP_NOT_CONFIRMED = "NOT CONFIRMED";
const RECORDED = " · recorded"; // a result from an earlier run, not a replay done now

export function confirmationOf(cause: Extract<CauseResult, { status: "proposed" }>, replay?: ReplayResult): Confirmation {
  if (!replay) return { confirmed: false, chip: CHIP_NOT_CONFIRMED, note: "No replay result for this cause yet." };
  const suffix = replay.basis === "recorded" ? RECORDED : "";
  if (replay.verdict !== "CONFIRMED BY REPLAY") return { confirmed: false, chip: `${CHIP_NOT_CONFIRMED}${suffix}`, note: "The replay did not separate the good build from the bad one." };
  if (!CONFIRMABLE[replay.mode].includes(cause.category)) return { confirmed: false, chip: `${CHIP_NOT_CONFIRMED}${suffix}`, note: "Replay supports a different cause." };
  return { confirmed: true, chip: `${CHIP_CONFIRMED}${suffix}` };
}
