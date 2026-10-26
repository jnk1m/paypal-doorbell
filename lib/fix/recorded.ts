// The recorded fix results a deployed function (and a recorded run) reads. This is the whole of "prove the fix" on Vercel:
//
//   - results.json holds one FixResult per planted mode. scripts/record-fix.ts made it on the owner's machine: one recorded model answer,
//     the code checks, and the replay controls run in a sandbox child process on real signed deliveries.
//   - reviewed.json holds the sha256 of each patched file the OWNER has read (scripts/fix-review.ts writes it). A proven result whose patch
//     hash is not in it is not served: model-written code reaches a screen only after a person read it.
//
// Nothing here calls a model, starts a process, compiles or runs a patch, or touches a network. The patch is data: lines of a diff. The
// patched file itself (fixtures/fix/patched/<mode>.handler.txt) is a text file that no code imports; it is read only by the local scripts.
// This file imports JSON statically, like lib/run/recorded.ts, so it is part of the deployed code. recorded.test.ts checks the import graph:
// nothing that reaches typescript, child_process or the model SDK.
import results from "../../fixtures/fix/results.json" with { type: "json" };
import reviewed from "../../fixtures/fix/reviewed.json" with { type: "json" };
import type { PlantedMode } from "../shop/types.ts";
import type { FixResult } from "./types.ts";

export interface FixStore {
  results: Partial<Record<PlantedMode, FixResult>>;
  reviewed: Partial<Record<PlantedMode, string>>; // mode -> sha256 of the patched file the owner read
}

export const STORE: FixStore = { results: results as unknown as FixStore["results"], reviewed: reviewed as FixStore["reviewed"] };

// The recorded fix for the cause the snapshot holds, or null: no record, a record for another cause (the diff or the cause recording changed
// since), or a proven patch nobody has reviewed. A recorded result is labelled "recorded": its controls ran earlier, not now.
export function recordedFix(mode: PlantedMode, causeRequestHash: string, store: FixStore = STORE): FixResult | null {
  const r = store.results[mode];
  if (!r || r.mode !== mode || r.causeRequestHash !== causeRequestHash) return null;
  if (r.verdict === "proven" && store.reviewed[mode] !== r.patchSha256) return null;
  return { ...r, basis: "recorded" };
}
