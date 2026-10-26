// A11, first clause: the line the AI would cite is the line of the file that runs (plan 5.4 #5, R11).
// The diffs are computed from the real handler files by the same function the build runs (scripts/build-diffs.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { citableLines, computeDiffs, isCodeLine, splitLines, writeDiffs } from "./diffs.ts";
import { HANDLERS, LAST_GOOD, MODE_FILE } from "./modes.ts";
import { ALL_MODES, MODES, SETTING_MODES, isPlanted } from "./types.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
// Read independently of the code under test: split on newlines and count from 1, as an editor does.
const lineAt = (root: string, id: string): string | undefined => {
  const at = id.lastIndexOf(":");
  return readFileSync(join(root, id.slice(0, at)), "utf8").split("\n")[Number(id.slice(at + 1)) - 1];
};

test("A11: every line id in every diff names the same text at that line of the file it names, and the file is the one that runs (100%)", () => {
  const { diffs } = computeDiffs(ROOT);
  assert.equal(diffs.length, MODES.filter(isPlanted).length);
  let checked = 0;
  for (const d of diffs) {
    assert.equal(d.from, MODE_FILE[LAST_GOOD]);
    assert.equal(d.to, MODE_FILE[d.mode]);
    for (const line of d.hunks.flatMap((h) => h.lines)) {
      assert.equal(lineAt(ROOT, line.id), line.text, `${line.id} (${line.kind})`);
      // Added and unchanged lines belong to the bad handler (what runs in that mode); removed lines to the last-good one.
      assert.equal(line.id.slice(0, line.id.lastIndexOf(":")), line.kind === "del" ? d.from : d.to, line.id);
      checked++;
    }
  }
  assert.ok(checked >= 40, `only ${checked} lines were checked`);
});

test("A11: the module that runs for a mode is the file the diff for that mode was computed from", () => {
  const sources = new Set<string>();
  for (const mode of ALL_MODES) {
    const source = new URL(HANDLERS[mode].SOURCE).pathname;
    assert.ok(source.endsWith(`/${MODE_FILE[mode]}`), `${mode} runs ${source}, the diff reads ${MODE_FILE[mode]}`);
    sources.add(source);
  }
  assert.equal(sources.size, ALL_MODES.length, "five modes, five different files");
});

test("A11: an added line is in the file that runs and not in the last-good one; a removed line is the other way round", () => {
  const { diffs } = computeDiffs(ROOT);
  for (const d of diffs) {
    const good = splitLines(readFileSync(join(ROOT, d.from), "utf8"));
    const bad = splitLines(readFileSync(join(ROOT, d.to), "utf8"));
    for (const l of citableLines(d)) {
      if (l.kind === "add") assert.ok(bad.includes(l.text) && !good.includes(l.text), `${l.id} is added`);
      else assert.ok(good.includes(l.text) && !bad.includes(l.text), `${l.id} is removed`);
    }
  }
});

test("A11: the planted change of each bug is among the lines the AI may cite, comments and blank lines are not", () => {
  const { diffs } = computeDiffs(ROOT);
  const cited = (mode: string) => citableLines(diffs.find((d) => d.mode === mode)!);
  assert.ok(cited("bad_body").some((l) => l.kind === "add" && l.text.includes("canonical(JSON.parse(ctx.rawBody))")));
  assert.ok(cited("ack_then_drop").some((l) => l.kind === "add" && l.text.includes("queue.push(event)")));
  assert.ok(cited("last_write_wins").some((l) => l.kind === "del" && l.text.includes("rank(current.state) > rank(booking.state)")));
  for (const d of diffs) {
    for (const l of citableLines(d)) assert.ok(l.text.trim() !== "" && !l.text.trim().startsWith("//"), `${l.id} is code`);
    assert.ok(citableLines(d).length >= 1, `${d.mode} has something to cite`);
  }
});

test("build-diffs: the file it writes holds the same diffs, and a handler with a character outside printable ASCII stops the build", () => {
  const out = mkdtempSync(join(tmpdir(), "doorbell-diffs-"));
  const written = writeDiffs(ROOT, join(out, "diffs.json"));
  assert.deepEqual(JSON.parse(readFileSync(join(out, "diffs.json"), "utf8")), JSON.parse(JSON.stringify(computeDiffs(ROOT))));
  assert.equal(Object.keys(written.files).length, ALL_MODES.length);

  const copy = mkdtempSync(join(tmpdir(), "doorbell-handlers-"));
  cpSync(join(ROOT, "handlers"), join(copy, "handlers"), { recursive: true });
  const file = join(copy, MODE_FILE.bad_body);
  writeFileSync(file, readFileSync(file, "utf8").replace("alphabetical", "alphabétical"));
  assert.throws(() => computeDiffs(copy), /handlers\/bad-body\.ts:\d+ has a character outside printable ASCII/);
});

test("build-diffs: the generated file the app reads (when there is one) is not stale against the handler files", () => {
  const generated = join(ROOT, "lib/shop/diffs.generated.json");
  if (!existsSync(generated)) return; // written by `npm run build` / `npm run dev`; absent on a fresh clone
  assert.deepEqual(JSON.parse(readFileSync(generated, "utf8")), JSON.parse(JSON.stringify(computeDiffs(ROOT))), "a handler file changed after the last build: run npx tsx scripts/build-diffs.ts");
});

// ---- the setting bug: a deploy whose code change is only a comment -----------------------------------------------------------------------

test("the setting bug's diff: one hunk, one comment line reworded, every line id names that text in that file, and not one line can be cited", () => {
  const { diffs, settingDiffs } = computeDiffs(ROOT);
  assert.equal(settingDiffs.length, SETTING_MODES.length);
  assert.ok(!diffs.some((d) => (SETTING_MODES as readonly string[]).includes(d.mode)), "kept out of `diffs`, which the code-bug tests walk");
  const [d] = settingDiffs;
  assert.deepEqual([d.mode, d.from, d.to], ["wrong_webhook_id_setting", "handlers/good.ts", "handlers/tidy.ts"]);
  assert.equal(d.hunks.length, 1);
  assert.equal(d.hunks[0].id, "handlers/tidy.ts#1");
  const lines = d.hunks[0].lines;
  for (const line of lines) {
    assert.equal(lineAt(ROOT, line.id), line.text, `${line.id} (${line.kind})`);
    assert.equal(line.id.slice(0, line.id.lastIndexOf(":")), line.kind === "del" ? d.from : d.to, line.id);
  }
  const changed = lines.filter((l) => l.kind !== "ctx");
  assert.deepEqual(changed.map((l) => [l.kind, l.id]), [["del", "handlers/good.ts:1"], ["add", "handlers/tidy.ts:1"]]);
  assert.ok(changed.every((l) => !isCodeLine(l.text)), "both changed lines are comments");
  assert.equal(citableLines(d).length, 0, "no changed code line: whatever the model answers, nothing can be cited");
});

test("the setting bug's handler is good.ts with its first line (a comment) reworded and nothing else: the code that runs is the working code", () => {
  const good = readFileSync(join(ROOT, MODE_FILE.good), "utf8").split("\n");
  const tidy = readFileSync(join(ROOT, MODE_FILE.wrong_webhook_id_setting), "utf8").split("\n");
  assert.equal(tidy.length, good.length);
  assert.ok(good[0].startsWith("//") && tidy[0].startsWith("//") && good[0] !== tidy[0]);
  assert.deepEqual(tidy.slice(1), good.slice(1));
});
