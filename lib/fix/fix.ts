// "Prove the fix", the whole step for one confirmed code bug (LOCAL ONLY: it calls the model, compiles model-written code and runs it in the
// sandbox child process; scripts/record-fix.ts is its only caller, and a deployed function never imports it):
//
//   cause (recorded, lib/cause)  ->  fix request  ->  the model's edits (recorded, one call)  ->  code checks (check.ts)
//     ->  referee: the patched handler in the sandbox on real signed deliveries, three controls and PayPal's own answer (referee.ts)
//     ->  baseline: the same patch with its signature check removed must FAIL the tampered control
//     ->  FixResult (result.ts)
//
// One call, no second round. A failed check or control is not retried and not shown: the result says "not proven" and carries no patch.
import type { CauseInput } from "../cause/prompt.ts";
import type { CauseResult } from "../cause/cause.ts";
import { MODEL_ID } from "../core/llm.ts";
import type { PlantedMode } from "../shop/types.ts";
import { deleteVerify } from "./baselines.ts";
import { checkFix, fixTarget, problemSentences, type FixCheckResult } from "./check.ts";
import { FixOutput, type Edit } from "./edits.ts";
import { callFixLlm, type FixCall, type Ledger } from "./llm.ts";
import { buildFixRequest } from "./prompt.ts";
import type { RefereeResult, Referee } from "./referee.ts";
import { buildResult } from "./result.ts";
import type { FixResult } from "./types.ts";

export type ProposedCause = Extract<CauseResult, { status: "proposed" }>;

export interface FixAttempt {
  result: FixResult;
  edits: Edit[];
  patched: string | undefined;
  call: Pick<FixCall<unknown>, "source" | "usage" | "costUsd" | "hash" | "recordedAt">;
  checked: FixCheckResult;
  problems: string[]; // fixed sentences about whatever failed, for the log
  referee?: RefereeResult;
  signatureBaseline?: RefereeResult;
}

export class FixInfraError extends Error {
  constructor(detail: string) {
    super(`the fix could not be judged because PayPal could not be asked: ${detail}`);
    this.name = "FixInfraError";
  }
}

export async function proveFix(args: {
  mode: PlantedMode;
  input: CauseInput; // the cause step's input: the diff, the bad file, the symptom class
  cause: ProposedCause;
  referee: Referee;
  llm: { dir: string; live: boolean; ledger?: Ledger };
  now?: () => number;
}): Promise<FixAttempt> {
  const { mode, input, cause } = args;
  const now = args.now ?? Date.now;
  const bad = input.files[0];
  const req = buildFixRequest({ diff: input.diff, badPath: bad.path, badText: bad.text, symptom: input.symptom, category: cause.category, cited: cause.lines });
  const call = await callFixLlm(req, FixOutput, { ...args.llm, caseId: `${mode}` });
  const edits = call.output.edits;
  const target = fixTarget(input.diff, bad.text);
  const checked = checkFix(target, new Set(cause.lines.map((l) => l.id)), edits);

  let referee: RefereeResult | undefined;
  let signatureBaseline: RefereeResult | undefined;
  if (checked.ok) {
    referee = await args.referee.judge(checked.patched!);
    if (referee.infra) throw new FixInfraError(referee.infra.detail);
    if (referee.pass) {
      signatureBaseline = await args.referee.judge(deleteVerify(checked.patched!));
      if (signatureBaseline.infra) throw new FixInfraError(signatureBaseline.infra.detail);
    }
  }
  const result = buildResult({
    mode,
    causeRequestHash: cause.requestHash,
    fixRequestHash: call.hash,
    promptVersion: req.version,
    model: MODEL_ID,
    recordedAt: Date.parse(call.recordedAt),
    ranAt: now(),
    basis: "replayed", // the controls just ran; the lookup that serves a stored result labels it "recorded"
    file: bad.path,
    bad: bad.text,
    good: args.referee.goodTs,
    checks: checked,
    patched: checked.patched,
    referee,
    signatureBaseline,
    orders: args.referee.scenarioCount,
  });
  const problems = [...problemSentences(checked), ...(referee?.codeFailure ? [`The patched file did not run: ${referee.codeFailure.reason}.`] : []), ...(referee && !referee.pass && !referee.codeFailure ? ["A replay control failed."] : [])];
  return { result, edits, patched: checked.patched, call: { source: call.source, usage: call.usage, costUsd: call.costUsd, hash: call.hash, recordedAt: call.recordedAt }, checked, problems, referee, signatureBaseline };
}
