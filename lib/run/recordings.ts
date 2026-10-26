// Where the product reads the cause recordings (the model's recorded answers) from at run time.
//
// lib/core/llm.ts derives its default folder from import.meta.url. That is right on a developer's machine, but in a bundled server function
// the URL names where the file was at build time, which is not where the deployed function runs, so a deployed function could answer every
// cause with "no recording". llm.ts is frozen for the evaluation (eval/harness/FREEZE.json), so it is not changed: every place where the
// product asks for a cause passes this folder as `dir` instead. A test (recordings.test.ts) fails if a product call site forgets to.
//
// process.cwd() is the project root in `next dev`, `next start`, `npm test`, the scripts, and in a deployed function, where next.config.ts
// ships fixtures/recordings/*.json at those paths (outputFileTracingIncludes).
import { join } from "node:path";

export const CAUSE_RECORDINGS_DIR = join(/*turbopackIgnore: true*/ process.cwd(), "fixtures/recordings/");
