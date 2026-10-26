// Adds "what the patch leaves behind" (lib/fix/leftovers.ts) to the fix results that were recorded before it existed (LOCAL, no network, no model call):
//
//   npx tsx scripts/fix-leftovers.ts            write it into fixtures/fix/results.json and into every fix of fixtures/recorded-run/*.json
//   npx tsx scripts/fix-leftovers.ts --check    change nothing; exit 1 and say which result lacks it or holds another value
//
// It is derived data: the patched file the owner reviewed (fixtures/fix/patched/<mode>.handler.txt, checked against the result's patchSha256) diffed against
// handlers/good.ts. A result whose patched file is not the reviewed one is left alone and reported. Run it after a recording that was made without it
// (scripts/record-run.ts copies what fixtures/fix/results.json holds, so a recording made after this has it already).
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readPatched, readResults, REPO_ROOT, writeResults } from "../lib/fix/files.ts";
import { leftoversOf } from "../lib/fix/leftovers.ts";
import { sha256 } from "../lib/fix/result.ts";
import type { FixResult, Leftover } from "../lib/fix/types.ts";
import type { PlantedMode } from "../lib/shop/types.ts";

const check = process.argv.includes("--check");
const good = readFileSync(join(REPO_ROOT, "handlers/good.ts"), "utf8");
const problems: string[] = [];

// The leftovers of a result, or undefined when there is nothing to say (not proven) or the patched file on disk is not the reviewed one.
function leftoversFor(r: FixResult, where: string): Leftover[] | undefined {
  if (r.verdict !== "proven") return undefined;
  const patched = readPatched(r.mode);
  if (patched === undefined || sha256(patched) !== r.patchSha256) {
    problems.push(`${where}: the patched file for ${r.mode} is not the reviewed one (sha256 ${r.patchSha256.slice(0, 8)}), so nothing was added`);
    return undefined;
  }
  return leftoversOf(good, patched);
}

function apply(r: FixResult, where: string): boolean {
  const want = leftoversFor(r, where);
  if (want === undefined || JSON.stringify(r.leftovers) === JSON.stringify(want)) return false;
  problems.push(`${where}: ${r.leftovers === undefined ? "has no leftovers" : "holds other leftovers than the patched file gives"}`);
  r.leftovers = want;
  return true;
}

const results = readResults();
let changed = false;
for (const [mode, r] of Object.entries(results) as [PlantedMode, FixResult][]) changed = apply(r, `fixtures/fix/results.json ${mode}`) || changed;
if (changed && !check) writeResults(results);

const dir = join(REPO_ROOT, "fixtures/recorded-run");
for (const name of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
  const file = join(dir, name);
  const scenario = JSON.parse(readFileSync(file, "utf8")) as { steps: { causes: { fix?: FixResult }[] }[] };
  let touched = false;
  scenario.steps.forEach((step, i) => step.causes.forEach((c, k) => c.fix && (touched = apply(c.fix, `${name} step ${i + 1} cause ${k + 1}`) || touched)));
  if (touched && !check) writeFileSync(file, `${JSON.stringify(scenario, null, 1)}\n`);
}

for (const p of problems) console.log(p);
if (problems.length === 0) console.log("every fix result already holds the leftovers of its reviewed patched file");
else if (check) process.exit(1);
else console.log("written");
