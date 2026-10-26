// The diffs the cause step reads at run time: the file scripts/build-diffs.ts wrote from the real handler files before `next build` / `next dev`.
// It is imported (not read from disk), so it is part of the deployed code on every platform. The file is generated, not committed: `npm run
// typecheck` and `npm run build` write it first; on a fresh clone run `npx tsx scripts/build-diffs.ts`.
import generated from "./diffs.generated.json" with { type: "json" };
import type { DiffBundle } from "./diffs.ts";

export const diffBundle: DiffBundle = generated as DiffBundle;
