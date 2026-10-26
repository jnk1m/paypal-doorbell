// convert-sealed.ts: the author shapes of the sealed sets become the harness's case shape; nothing the model sees changes; a cited line
// that is not a changed line stops the conversion; the manifest has the sealed format and hashes every file but itself.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { changedLines, convertHaLabel, convertHbLabel, convertSet, writeManifest } from "./convert-sealed.ts";
import { listCaseDirs, loadCase } from "./case.ts";

const DIFF = `diff --git a/src/app.js b/src/app.js
--- a/src/app.js
+++ b/src/app.js
@@ -1,3 +1,3 @@
 const x = 1;
-    await applyEvent(event);
+    res.sendStatus(200);
 done();
`;

const haLabel = {
  category: "WORK_AFTER_ACK",
  files: ["src/app.js"],
  files_before: ["src/app.js"],
  lines: [2],
  lines_before: [2],
  bug_text: ["res.sendStatus(200);"],
  bug_locations: [
    { side: "after", file: "src/app.js", line: 2, text: "res.sendStatus(200);" },
    { side: "before", file: "src/app.js", line: 2, text: "await applyEvent(event);" },
  ],
  decoy_lines: [{ file: "src/app.js", line: 1, text: "const x = 1;" }],
  mix: "keywordless",
  stack: "express",
  notes: "the author's explanation, never copied",
  line_numbering: "1-based",
};

const hbLabel = {
  id: "hb-1",
  category: "RAW_BODY_ALTERED",
  files: ["src/app.js"],
  lines: [{ file: "src/app.js", side: "after", line: 2, text: "res.sendStatus(200);" }],
  source: { ai_attributed_commit: true, language: "JavaScript", framework: "express" },
};

function writeCase(dir: string, label: unknown, symptom?: unknown) {
  mkdirSync(join(dir, "before"), { recursive: true });
  mkdirSync(join(dir, "after"), { recursive: true });
  writeFileSync(join(dir, "before", "app.js"), "const x = 1;\n    await applyEvent(event);\ndone();\n");
  writeFileSync(join(dir, "after", "app.js"), "const x = 1;\n    res.sendStatus(200);\ndone();\n");
  writeFileSync(join(dir, "diff.patch"), DIFF);
  writeFileSync(join(dir, "label.json"), JSON.stringify(label));
  if (symptom) writeFileSync(join(dir, "symptom.json"), JSON.stringify(symptom));
}

test("H-a label: after texts become lines, before texts altLines, one file, tags kept, notes and decoys dropped", () => {
  const out = convertHaLabel(haLabel);
  assert.deepEqual(out, { category: "WORK_AFTER_ACK", file: "src/app.js", altFiles: [], lines: ["res.sendStatus(200);"], altLines: ["await applyEvent(event);"], mix: "keywordless", stack: "express" });
  assert.ok(!("notes" in out) && !("decoy_lines" in out));
});

test("H-a label: NOT_IN_DIFF has no citation; a cause without a citation and a bug_text/bug_locations mismatch are refused", () => {
  const empty = { ...haLabel, category: "NOT_IN_DIFF", files: [], files_before: [], lines: [], lines_before: [], bug_text: [], bug_locations: [] };
  assert.deepEqual(convertHaLabel(empty), { category: "NOT_IN_DIFF", file: null, altFiles: [], lines: [], altLines: [], mix: "keywordless", stack: "express" });
  assert.throws(() => convertHaLabel({ ...haLabel, bug_text: [], bug_locations: [] }), /without a cited line/);
  assert.throws(() => convertHaLabel({ ...haLabel, bug_text: ["other"] }), /disagree/);
  assert.throws(() => convertHaLabel({ ...haLabel, category: "SOMETHING" }), /not one of the 8/);
});

test("H-a label: a route moved between files keeps the old file as an alternative", () => {
  const moved = { ...haLabel, files_before: ["src/old.js"], bug_locations: [haLabel.bug_locations[0], { side: "before", file: "src/old.js", line: 2, text: "await applyEvent(event);" }] };
  assert.deepEqual(convertHaLabel(moved).altFiles, ["src/old.js"]);
});

test("H-b label: lines[] objects split by side, the co-author flag and the stack become tags, a missing flag is refused", () => {
  assert.deepEqual(convertHbLabel(hbLabel), { category: "RAW_BODY_ALTERED", file: "src/app.js", altFiles: [], lines: ["res.sendStatus(200);"], altLines: [], ai_attributed_commit: true, stack: "express" });
  assert.throws(() => convertHbLabel({ ...hbLabel, source: { language: "JavaScript" } }), /ai_attributed_commit/);
  assert.equal(convertHbLabel({ ...hbLabel, source: { language: "JavaScript" } }, false).ai_attributed_commit, false, "the twin's flag may come from the map");
  const beforeOnly = { ...hbLabel, lines: [{ file: "src/app.js", side: "before", line: 2, text: "await applyEvent(event);" }] };
  assert.deepEqual(convertHbLabel(beforeOnly).altLines, ["await applyEvent(event);"]);
  assert.equal(convertHbLabel(beforeOnly).file, "src/app.js");
});

test("changed lines: +/- lines without the file headers, normalised", () => {
  assert.deepEqual([...changedLines(DIFF)], ["await applyEvent(event);", "res.sendStatus(200);"]);
});

test("convertSet (ha): the frozen loader reads the output, trees and diff are byte-identical, manifest hashes every file but itself", () => {
  const tmp = mkdtempSync(join(tmpdir(), "convert-"));
  try {
    writeCase(join(tmp, "ha", "cases", "ha-01"), haLabel, { symptom: "2xx_but_books_unchanged", deliveries: { attempts: 3, status_counts: { "200": 3 }, ledger_rows_changed: 0 } });
    const r = convertSet({ kind: "ha", from: join(tmp, "ha"), to: join(tmp, "ha-run") });
    assert.equal(r.cases, 1);
    const dirs = listCaseDirs(join(tmp, "ha-run"));
    assert.equal(dirs.length, 1);
    const c = loadCase(dirs[0]);
    assert.equal(c.id, "ha-01");
    assert.equal(c.symptom, "2xx_but_books_unchanged");
    assert.deepEqual(JSON.parse(readFileSync(join(tmp, "ha-run", "ha-01", "symptom.json"), "utf8")), { class: "2xx_but_books_unchanged", symptom: "2xx_but_books_unchanged" }, "both the harness's key and the B2 command line's key");
    assert.deepEqual(c.label, { category: "WORK_AFTER_ACK", file: "src/app.js", lines: ["res.sendStatus(200);"], altFiles: [], altLines: ["await applyEvent(event);"], tags: { mix: "keywordless", stack: "express" } });
    assert.equal(c.diff, DIFF);
    assert.equal(c.after["app.js"], readFileSync(join(tmp, "ha", "cases", "ha-01", "after", "app.js"), "utf8"));
    const manifest = readFileSync(join(tmp, "ha-run", "MANIFEST.sha256"), "utf8");
    const lines = manifest.trimEnd().split("\n");
    assert.equal(lines.length, 5, "before/app.js, after/app.js, diff.patch, label.json, symptom.json");
    assert.equal(r.manifest.files, 5);
    assert.ok(lines.every((l) => /^[0-9a-f]{64}  ha-01\/[^.]/.test(l)), "sealed format, no ./ prefix");
    assert.equal(createHash("sha256").update(manifest).digest("hex"), r.manifest.sha256);
    assert.ok(!manifest.includes("MANIFEST.sha256"));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("convertSet (hb): the variant subfolder is read, the class comes from --symptoms, a cited line outside the diff stops it", () => {
  const tmp = mkdtempSync(join(tmpdir(), "convert-"));
  try {
    writeCase(join(tmp, "hb", "cases", "hb-1", "nocomment"), hbLabel);
    writeCase(join(tmp, "hb", "cases", "hb-1"), { ...hbLabel, lines: [{ file: "src/app.js", side: "after", line: 9, text: "not in the diff" }] });
    const r = convertSet({ kind: "hb", from: join(tmp, "hb"), to: join(tmp, "hb-run"), sub: "nocomment", symptoms: { "hb-1": "all_401" } });
    assert.equal(r.cases, 1);
    const c = loadCase(listCaseDirs(join(tmp, "hb-run"))[0]);
    assert.equal(c.symptom, "all_401");
    assert.deepEqual(c.label.tags, { ai_attributed_commit: true, stack: "express" });
    assert.throws(() => convertSet({ kind: "hb", from: join(tmp, "hb"), to: join(tmp, "hb-run-2"), symptoms: { "hb-1": "all_401" } }), /not a changed line/);
    assert.throws(() => convertSet({ kind: "hb", from: join(tmp, "hb"), to: join(tmp, "hb-run-3"), sub: "nocomment", symptoms: {} }), /symptom class/);
    assert.throws(() => convertSet({ kind: "hb", from: join(tmp, "hb"), to: join(tmp, "hb", "run"), sub: "nocomment", symptoms: { "hb-1": "all_401" } }), /inside --from/);
    assert.throws(() => convertSet({ kind: "hb", from: join(tmp, "hb"), to: join(tmp, "hb-run"), sub: "nocomment", symptoms: { "hb-1": "all_401" } }), /not empty/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("writeManifest is deterministic and byte-ordered", () => {
  const tmp = mkdtempSync(join(tmpdir(), "manifest-"));
  try {
    mkdirSync(join(tmp, "b"));
    writeFileSync(join(tmp, "b", "x"), "1");
    writeFileSync(join(tmp, "a"), "2");
    writeFileSync(join(tmp, "Z"), "3");
    const first = writeManifest(tmp);
    const text = readFileSync(join(tmp, "MANIFEST.sha256"), "utf8");
    assert.deepEqual(text.trimEnd().split("\n").map((l) => l.slice(66)), ["Z", "a", "b/x"]);
    assert.deepEqual(writeManifest(tmp), first);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
