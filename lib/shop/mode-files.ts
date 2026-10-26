// Which handler file runs for which mode, as repo-relative paths. No imports of the handlers themselves, so the build script can
// read this without loading any of them. lib/shop/modes.ts pairs each path with the module that executes.
import type { Mode } from "./types.ts";

export const MODE_FILE: Record<Mode, string> = {
  good: "handlers/good.ts",
  ack_then_drop: "handlers/ack-drop.ts",
  bad_body: "handlers/bad-body.ts",
  last_write_wins: "handlers/last-write-wins.ts",
  wrong_webhook_id_setting: "handlers/tidy.ts", // the code is good.ts with one comment reworded; what is wrong is a setting (webhook.ts)
};

// The mode the planted bugs are compared against.
export const LAST_GOOD: Mode = "good";

// The label the screen shows next to every mode that is a bug (DO NOT CHANGE 8).
export const PLANTED_LABEL = "planted by us";
