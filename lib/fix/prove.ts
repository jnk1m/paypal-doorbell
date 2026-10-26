// Record time only (scripts/record-run.ts; LOCAL, it starts the sandbox child process): the reviewed patch proven again on the signed deliveries of
// the session being recorded, the way the replay (lib/cause/replay.ts) is run again on them. The code checks belong to the patch and do not
// change, so they are carried over from the recorded result; the four controls and the signature-check baseline are run on this session's own
// orders. The patch itself is never asked of the model again and never changes: it is the file the owner reviewed, and its hash must match.
import type { ScanResult } from "../gaps/scan.ts";
import type { AttemptEntry, WitnessStore } from "../witness/store.ts";
import { deleteVerify } from "./baselines.ts";
import { CachedVerifier, Referee, type VerifyFn } from "./referee.ts";
import { controlsOf, sha256 } from "./result.ts";
import { scenariosFromScan } from "./scenarios.ts";
import { BASELINE_LABEL, claimOf, NOT_PROVEN_FIX_TEXT, type FixResult } from "./types.ts";

export interface SessionProofDeps {
  witness: Pick<WitnessStore, "attempts">;
  webhookIdOf: (entry: AttemptEntry) => string | undefined;
  verify: VerifyFn; // PayPal's verify-webhook-signature on stored deliveries (the only call to PayPal besides the scan's own reads)
  goodText: string; // the last good handler
  patchedText: (mode: FixResult["mode"]) => string | undefined; // the reviewed patched file
  now?: () => number;
}

// null: there is nothing to prove it on (the witness holds no usable order of this session) or the patched file is not the one that was reviewed.
// A throw: PayPal could not be asked. Either way the caller shows the recorded result.
export async function proveOnSession(deps: SessionProofDeps, arg: { recorded: FixResult; scan: ScanResult }): Promise<FixResult | null> {
  const { recorded, scan } = arg;
  const patched = deps.patchedText(recorded.mode);
  if (patched === undefined || sha256(patched) !== recorded.patchSha256) return null;
  const scenarios = await scenariosFromScan(scan, deps.witness, deps.webhookIdOf);
  if (scenarios.length === 0) return null;

  const referee = new Referee(scenarios, deps.goodText, new CachedVerifier(deps.verify));
  await referee.prepare(); // throws when PayPal cannot be asked or the good build satisfies no order
  const judged = await referee.judge(patched);
  if (judged.infra) throw new Error(`the fix could not be proven on this session: ${judged.infra.detail}`);
  const lazy = judged.pass ? await referee.judge(deleteVerify(patched)) : undefined;
  if (lazy?.infra) throw new Error(`the fix could not be proven on this session: ${lazy.infra.detail}`);

  const now = deps.now ?? Date.now;
  const proven = judged.pass && !!lazy;
  return {
    ...recorded,
    basis: "replayed",
    ranAt: now(),
    verdict: proven ? "proven" : "not_proven",
    claim: proven ? claimOf(referee.scenarioCount, judged.inputs) : NOT_PROVEN_FIX_TEXT,
    orders: proven ? referee.scenarioCount : 0,
    inputs: proven ? judged.inputs : 0,
    patch: proven ? recorded.patch : null,
    controls: judged.codeFailure ? recorded.controls.map((c) => ({ ...c, ok: false, n: 0 })) : controlsOf(judged),
    baseline: proven && lazy ? { id: "skips_signature_check", label: BASELINE_LABEL, controls: controlsOf(lazy) } : null,
  };
}
