// The cached path is the default (plan 5.4 #6): the three planted modes have a recorded cause in fixtures/recordings/, so the hosted
// demo and these tests need no model, no key and no network. If a handler file or the prompt changes, the request hash changes, the
// recording is not found, and this test says how to make a new one (npx tsx scripts/s4-acceptance.ts record-causes).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderCause } from "../ui/render-helpers.ts";
import { computeDiffs } from "../shop/diffs.ts";
import { MODE_FILE } from "../shop/mode-files.ts";
import type { PlantedMode } from "../shop/types.ts";
import type { SymptomClass } from "./categories.ts";
import { diagnose } from "./cause.ts";
import { shopInput } from "./input.ts";
import { REPLAY_WINDOW_MS, replayOrRecorded, type RecordedReplays } from "./replay.ts";
import { ROOT } from "./test-helpers.ts";

const SYMPTOM: Record<PlantedMode, SymptomClass> = { bad_body: "all_401", ack_then_drop: "2xx_but_books_unchanged", last_write_wins: "2xx_but_books_unchanged" };
const EXPECTED: Record<PlantedMode, string> = { bad_body: "RAW_BODY_ALTERED", ack_then_drop: "WORK_AFTER_ACK", last_write_wins: "OTHER_CODE_CHANGE" };

for (const mode of Object.keys(SYMPTOM) as PlantedMode[]) {
  test(`the recorded cause of ${mode} is found by the default path and names a line of the file that runs`, async () => {
    const input = shopInput(mode, computeDiffs(ROOT), SYMPTOM[mode]);
    const r = await diagnose(input, { mode: "replay", log: () => undefined });
    assert.equal(r.status === "not_diagnosed" && r.reason, false, "no recording found: run npx tsx scripts/s4-acceptance.ts record-causes");
    assert.equal(r.status, "proposed");
    if (r.status !== "proposed") return;
    assert.equal(r.source, "recording");
    assert.equal(r.category, EXPECTED[mode]);
    for (const l of r.lines) {
      // A removed line's number counts in the OLD file (the last good handler), an added one's in the file that runs (A11). The card shows that file.
      assert.equal(l.shownFile, l.kind === "del" ? MODE_FILE.good : MODE_FILE[mode], `${l.id} ${l.kind}`);
      assert.equal(readFileSync(join(ROOT, l.shownFile), "utf8").split("\n")[l.no! - 1], l.text, `${l.shownFile}:${l.no} is the line the card quotes`);
      assert.equal(l.file, MODE_FILE[mode], "C1' still compares the diff file's own path");
    }
    const html = renderCause(r);
    for (const l of r.lines) assert.ok(html.includes(`>${l.shownFile}:${l.no}</span>`), `the page names ${l.shownFile}:${l.no}`);
    assert.ok(!html.includes(r.category), "the page prints the category in words, never the model's own code for it");
  });
}

test("the recorded replay results exist for all 3 modes, hold no body, and are what 'outside the window' shows", async () => {
  const recorded = JSON.parse(readFileSync(join(ROOT, "fixtures/replay/recorded.json"), "utf8")) as RecordedReplays;
  assert.deepEqual(Object.keys(recorded).sort(), ["ack_then_drop", "bad_body", "last_write_wins"]);
  for (const [mode, r] of Object.entries(recorded)) {
    assert.equal(r!.verdict, "CONFIRMED BY REPLAY", mode);
    assert.equal(r!.basis, "replayed");
    assert.ok(!JSON.stringify(r).includes('"raw"') && !JSON.stringify(r).includes("paypal-transmission-sig"));
    const old = Date.now() - REPLAY_WINDOW_MS - 3600_000;
    const shown = await replayOrRecorded({ mode: mode as PlantedMode, deliveries: [{ raw: "{}", webhookId: "X", headers: { transmissionId: "t", transmissionTime: new Date(old).toISOString(), transmissionSig: "s", certUrl: "c", authAlgo: "a" } }] }, async () => {
      throw new Error("must not be called");
    }, recorded);
    assert.equal(shown.basis, "recorded");
  }
});
