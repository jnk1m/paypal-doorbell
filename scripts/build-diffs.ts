// Computes, from the real handler files, the diff last-good -> each planted bug (and the setting-bug deploy), and writes lib/shop/diffs.generated.json.
// Runs before `next build` and `next dev` (package.json) and fails the build if a handler file is not plain ASCII.
//   npx tsx scripts/build-diffs.ts
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { citableLines, writeDiffs } from "../lib/shop/diffs.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "lib/shop/diffs.generated.json");
const bundle = writeDiffs(root, out);
for (const d of [...bundle.diffs, ...bundle.settingDiffs]) {
  const lines = d.hunks.flatMap((h) => h.lines);
  console.log(`diffs: ${d.mode.padEnd(24)} ${d.from} -> ${d.to}: ${d.hunks.length} hunk(s), ${lines.filter((l) => l.kind === "add").length} added, ${lines.filter((l) => l.kind === "del").length} removed, ${citableLines(d).length} citable`);
}
