// The owner's review of the recorded patches (LOCAL). A proven patch reaches a screen only after a person has read it: lib/fix/recorded.ts serves a
// proven result only when fixtures/fix/reviewed.json holds the sha256 of its patched file. This script is the only thing that writes that file.
//
//   npx tsx scripts/fix-review.ts                 show every recorded result: the diff, each check and control, the baseline, and whether it is approved
//   npx tsx scripts/fix-review.ts approve <mode>[,<mode>]   after the owner has read the diff: approve the patched file as it is on disk now
//   npx tsx scripts/fix-review.ts revoke <mode>[,<mode>]    take an approval back
//
// Approving refuses when the patched file on disk is not the file the result was proven on, or when the diff stored in the result is not the diff of
// that file: what the owner read is what is shown.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { normalizeSource } from "../lib/cause/hygiene.ts";
import { readPatched, readResults, readReviewed, REPO_ROOT, writeReviewed } from "../lib/fix/files.ts";
import { patchView, sha256 } from "../lib/fix/result.ts";
import type { PlantedMode } from "../lib/shop/types.ts";

const MODES: PlantedMode[] = ["ack_then_drop", "bad_body", "last_write_wins"];
const [command, which] = process.argv.slice(2);
const results = readResults();
const reviewed = readReviewed();
const wanted = (which?.split(",") ?? []) as PlantedMode[];
for (const m of wanted) if (!MODES.includes(m)) throw new Error(`"${m}" is not one of ${MODES.join(", ")}`);

if (command === "approve" || command === "revoke") {
  if (wanted.length === 0) throw new Error(`usage: fix-review.ts ${command} <mode>[,<mode>]`);
  for (const mode of wanted) {
    if (command === "revoke") {
      delete reviewed[mode];
      console.log(`${mode}: approval removed`);
      continue;
    }
    const r = results[mode];
    const file = readPatched(mode);
    if (!r || r.verdict !== "proven") throw new Error(`${mode}: there is no proven result to approve`);
    if (file === undefined) throw new Error(`${mode}: fixtures/fix/patched/${mode}.handler.txt is missing`);
    if (sha256(file) !== r.patchSha256) throw new Error(`${mode}: the patched file on disk is not the file the result was proven on (${sha256(file).slice(0, 12)} vs ${r.patchSha256.slice(0, 12)}); record it again`);
    // The diff on the screen must be the diff of the file, line for line: recompute it from the file and the bad deploy that the result names.
    const bad = normalizeSource(readFileSync(join(REPO_ROOT, r.patch!.file), "utf8")).text;
    if (JSON.stringify(patchView(r.patch!.file, bad, file)) !== JSON.stringify(r.patch)) throw new Error(`${mode}: the diff stored in the result is not the diff of the patched file against ${r.patch!.file}; record it again`);
    reviewed[mode] = r.patchSha256;
    console.log(`${mode}: approved ${r.patchSha256.slice(0, 12)}`);
  }
  writeReviewed(reviewed);
  process.exit(0);
}

for (const mode of MODES) {
  const r = results[mode];
  if (!r) {
    console.log(`\n=== ${mode}: nothing recorded\n`);
    continue;
  }
  const file = readPatched(mode);
  const approved = reviewed[mode] === r.patchSha256;
  console.log(`\n=== ${mode}: ${r.verdict.toUpperCase()}${r.verdict === "proven" ? (approved ? " · APPROVED" : " · not approved (nothing is shown until it is)") : ""}`);
  console.log(`    model ${r.model}, prompt ${r.promptVersion}, answer ${r.fixRequestHash.slice(0, 12)} recorded ${new Date(r.recordedAt).toISOString()}, controls ran ${new Date(r.ranAt).toISOString()}`);
  console.log(`    ${r.claim}`);
  for (const c of r.checks) console.log(`    check   ${c.ok ? "pass" : "FAIL"}  ${c.label}`);
  for (const c of r.controls) console.log(`    control ${c.ok ? "pass" : "FAIL"}  ${c.label} (${c.n})`);
  if (r.baseline) for (const c of r.baseline.controls) console.log(`    baseline ${c.ok ? "pass" : "FAIL"}  ${c.label} (${c.n})  [${r.baseline.label}]`);
  if (r.patch) {
    console.log(`\n    diff of ${r.patch.file} (+${r.patch.added} -${r.patch.removed}), proposed by Claude:`);
    r.patch.hunks.forEach((h, i) => {
      if (i > 0) console.log("    ...");
      for (const l of h) console.log(`    ${l.kind === "add" ? "+" : l.kind === "del" ? "-" : " "} ${l.text}`);
    });
  }
  if (file !== undefined) console.log(`\n    the whole patched file (fixtures/fix/patched/${mode}.handler.txt, ${file.split("\n").length - 1} lines, sha256 ${sha256(file).slice(0, 12)}):\n${file.split("\n").map((l) => `    | ${l}`).join("\n")}`);
}
