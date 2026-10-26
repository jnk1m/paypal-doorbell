// Which module runs for which mode. The handlers are real files at the repo root; a mode picks the module that executes.
// scripts/build-diffs.ts computes the diffs the AI will read from the paths in mode-files.ts (plan 5.4 #5).
import * as ackDrop from "../../handlers/ack-drop.ts";
import * as badBody from "../../handlers/bad-body.ts";
import * as good from "../../handlers/good.ts";
import * as lastWriteWins from "../../handlers/last-write-wins.ts";
import * as tidy from "../../handlers/tidy.ts";
import type { HandlerModule, Mode } from "./types.ts";

export { LAST_GOOD, MODE_FILE, PLANTED_LABEL } from "./mode-files.ts";

export const HANDLERS: Record<Mode, HandlerModule> = {
  good,
  ack_then_drop: ackDrop,
  bad_body: badBody,
  last_write_wins: lastWriteWins,
  wrong_webhook_id_setting: tidy,
};
