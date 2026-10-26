// The replay chip is tied to the cause it is shown next to (plan 5.4 #3): green only when the replay can confirm THAT cause, and it says
// when the result is a recording.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderCause } from "../ui/render-helpers.ts";
import { computeDiffs } from "../shop/diffs.ts";
import type { PlantedMode } from "../shop/types.ts";
import type { SymptomClass } from "./categories.ts";
import { diagnose, type CauseResult } from "./cause.ts";
import { CONFIRMABLE, confirmationOf } from "./confirm.ts";
import { shopInput } from "./input.ts";
import type { RecordedReplays, ReplayResult } from "./replay.ts";
import { answering, idOfText, openGate, ROOT } from "./test-helpers.ts";

const MODES: PlantedMode[] = ["bad_body", "ack_then_drop", "last_write_wins"];
const SYMPTOM: Record<PlantedMode, SymptomClass> = { bad_body: "all_401", ack_then_drop: "2xx_but_books_unchanged", last_write_wins: "2xx_but_books_unchanged" };
const recorded = JSON.parse(readFileSync(join(ROOT, "fixtures/replay/recorded.json"), "utf8")) as RecordedReplays;
const bundle = computeDiffs(ROOT);
type Proposed = Extract<CauseResult, { status: "proposed" }>;

async function causeOf(mode: PlantedMode, category: string, cite: string): Promise<Proposed> {
  const input = shopInput(mode, bundle, SYMPTOM[mode]);
  const r = await diagnose(input, { mode: "live", gate: openGate(), log: () => undefined, model: answering({ category, file: input.diff.files[0].path, lineIds: [idOfText(input, cite)], hunkId: "" }) as never });
  assert.equal(r.status, "proposed", `${mode} ${category}`);
  return r as Proposed;
}

test("the table: each planted bug is confirmed as the one category it is", () => {
  assert.deepEqual(CONFIRMABLE, { bad_body: ["RAW_BODY_ALTERED"], ack_then_drop: ["WORK_AFTER_ACK"], last_write_wins: ["OTHER_CODE_CHANGE"] });
});

test("a bad_body diff, a model that says WRONG_WEBHOOK_ID about the canonical(...) line: it passes C2 and C1', and the chip is NOT green", async () => {
  const cause = await causeOf("bad_body", "WRONG_WEBHOOK_ID", "canonical(JSON.parse(ctx.rawBody))");
  const confirmation = confirmationOf(cause, recorded.bad_body);
  assert.deepEqual([confirmation.confirmed, confirmation.chip, confirmation.note], [false, "NOT CONFIRMED", "Replay supports a different cause."]);
  const html = renderCause(cause, recorded.bad_body);
  assert.ok(!html.includes("Confirmed by replay"), "the replay does not confirm this cause");
  assert.match(html, />Not confirmed</);
  assert.match(html, /Replay supports a different cause\./);
});

test("the same diff with the category the replay does confirm: green", async () => {
  const cause = await causeOf("bad_body", "RAW_BODY_ALTERED", "canonical(JSON.parse(ctx.rawBody))");
  assert.deepEqual(confirmationOf(cause, recorded.bad_body), { confirmed: true, chip: "CONFIRMED BY REPLAY" });
  const html = renderCause(cause, recorded.bad_body);
  assert.match(html, />Confirmed by replay</);
});

test("every planted mode: its own cause is confirmed by its own replay and by no other mode's replay (3 x 3)", async () => {
  const own: Record<PlantedMode, [string, string]> = { bad_body: ["RAW_BODY_ALTERED", "canonical(JSON.parse"], ack_then_drop: ["WORK_AFTER_ACK", "queue.push(event)"], last_write_wins: ["OTHER_CODE_CHANGE", "rank(current.state) > rank(booking.state)"] };
  for (const mode of MODES) {
    const cause = await causeOf(mode, own[mode][0], own[mode][1]);
    for (const replayMode of MODES) {
      const c = confirmationOf(cause, recorded[replayMode]);
      assert.equal(c.confirmed, mode === replayMode, `${mode} cause against the ${replayMode} replay`);
    }
  }
});

test("any other category is not confirmed by any replay", async () => {
  // build proposals directly: the chip function only reads category and the replay
  const fake = (category: Proposed["category"]) => ({ status: "proposed", category }) as unknown as Proposed;
  for (const mode of MODES) {
    for (const category of ["RAW_BODY_ALTERED", "WRONG_WEBHOOK_ID", "WORK_AFTER_ACK", "EVENT_TYPE_DROPPED", "APP_OR_ENV_MISMATCH", "ENDPOINT_PATH_CHANGED", "OTHER_CODE_CHANGE"] as const) {
      assert.equal(confirmationOf(fake(category), recorded[mode]).confirmed, CONFIRMABLE[mode].includes(category), `${mode} ${category}`);
    }
  }
});

test("a recorded result says so on the chip itself, confirmed or not; a missing or failed replay is NOT CONFIRMED", async () => {
  const cause = await causeOf("ack_then_drop", "WORK_AFTER_ACK", "queue.push(event)");
  const asRecorded = (r: ReplayResult): ReplayResult => ({ ...r, basis: "recorded" });
  assert.equal(confirmationOf(cause, asRecorded(recorded.ack_then_drop!)).chip, "CONFIRMED BY REPLAY · recorded");
  assert.equal(confirmationOf(cause, recorded.ack_then_drop).chip, "CONFIRMED BY REPLAY", "a replay done now carries no suffix");
  const html = renderCause(cause, asRecorded(recorded.ack_then_drop!));
  assert.match(html, /Confirmed by replay · recorded/);
  assert.match(html, /recorded result/);
  const failed: ReplayResult = { ...asRecorded(recorded.ack_then_drop!), verdict: "NOT CONFIRMED", reason: "expectation_not_met" };
  assert.deepEqual(confirmationOf(cause, failed), { confirmed: false, chip: "NOT CONFIRMED · recorded", note: "The replay did not separate the good build from the bad one." });
  assert.equal(confirmationOf(cause, undefined).chip, "NOT CONFIRMED");
  const mismatchRecorded = confirmationOf(await causeOf("bad_body", "WRONG_WEBHOOK_ID", "canonical(JSON.parse(ctx.rawBody))"), asRecorded(recorded.bad_body!));
  assert.equal(mismatchRecorded.chip, "NOT CONFIRMED · recorded");
});
