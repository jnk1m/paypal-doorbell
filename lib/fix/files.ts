// Where the proof's files live (LOCAL ONLY: the scripts and the tests read and write them; a deployed function imports fixtures/fix/*.json
// through recorded.ts instead).
//
//   fixtures/fix/results.json            one FixResult per planted mode (recorded.ts serves it)
//   fixtures/fix/reviewed.json           mode -> sha256 of the patched file the owner has read
//   fixtures/fix/patched/<mode>.handler.txt   the whole patched file that was proven, as TEXT: nothing imports it, nothing outside the sandbox runs it
//   fixtures/fix-recordings/<hash>.json  the model's recorded answers (llm.ts)
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PlantedMode } from "../shop/types.ts";
import type { FixResult } from "./types.ts";

export const REPO_ROOT = new URL("../../", import.meta.url).pathname;
export const FIX_FIXTURES = join(REPO_ROOT, "fixtures/fix");
export const FIX_RECORDINGS = join(REPO_ROOT, "fixtures/fix-recordings");
export const RESULTS_FILE = join(FIX_FIXTURES, "results.json");
export const REVIEWED_FILE = join(FIX_FIXTURES, "reviewed.json");

export const patchedPath = (mode: PlantedMode): string => join(FIX_FIXTURES, "patched", `${mode}.handler.txt`);

export function readPatched(mode: PlantedMode): string | undefined {
  const file = patchedPath(mode);
  return existsSync(file) ? readFileSync(file, "utf8") : undefined;
}

export function writePatched(mode: PlantedMode, text: string): void {
  mkdirSync(join(FIX_FIXTURES, "patched"), { recursive: true });
  writeFileSync(patchedPath(mode), text);
}

const readJson = <T>(file: string): T => JSON.parse(readFileSync(file, "utf8")) as T;
const writeJson = (file: string, value: unknown): void => writeFileSync(file, `${JSON.stringify(value, null, 1)}\n`);

export const readResults = (): Partial<Record<PlantedMode, FixResult>> => readJson(RESULTS_FILE);
export const writeResults = (results: Partial<Record<PlantedMode, FixResult>>): void => writeJson(RESULTS_FILE, results);
export const readReviewed = (): Partial<Record<PlantedMode, string>> => readJson(REVIEWED_FILE);
export const writeReviewed = (reviewed: Partial<Record<PlantedMode, string>>): void => writeJson(REVIEWED_FILE, reviewed);
