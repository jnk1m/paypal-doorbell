// The hosted default (R12, plan 5.6): six real runs, played back (five with a planted bug, one with a dispute nobody heard; the 401 bug has two recordings with different endings). Each is a RecordedScenario of 3-5 RunSnapshot steps that scripts/record-run.ts
// captured from the deployed shop (real PayPal Sandbox events, the real gap finder, the recorded model answer, a real replay).
//
// This module reads no environment variable and makes no network or Redis call: the scenarios are JSON files imported statically, so they are
// part of the deployed code and a visitor can step through them with Upstash, PayPal and the model all unreachable. The RUN screen builds
// on this and on nothing else. (recorded.test.ts proves it with an emptied process.env and a fetch that throws.)
import causeNotInCode from "../../fixtures/recorded-run/cause_not_in_code.json" with { type: "json" };
import disputeNeverHeard from "../../fixtures/recorded-run/dispute_never_heard.json" with { type: "json" };
import lateOverwrite from "../../fixtures/recorded-run/late_payment_overwrites.json" with { type: "json" };
import refundNeverBooked from "../../fixtures/recorded-run/refund_never_booked.json" with { type: "json" };
import signatureRejected from "../../fixtures/recorded-run/signature_rejected.json" with { type: "json" };
import resendNotDelivered from "../../fixtures/recorded-run/resend_not_delivered.json" with { type: "json" };
import type { RecordedDisputeScenario, RecordedScenario, RunSnapshot } from "./snapshot.ts";

// In the order a visitor meets them: the shop that drops a refund first (plan 5.6: "ack_then_drop is the lead"); the 401 bug twice, first the run
// where the proven fix and Ring again tie both rows, then the earlier run of the same bug where PayPal accepted a resend and never delivered it;
// last, the one where the AI does not confirm a cause (the breaking change is a setting, and the deploy changed only a comment).
export const RECORDED_SCENARIOS: readonly RecordedScenario[] = [refundNeverBooked, lateOverwrite, signatureRejected, resendNotDelivered, causeNotInCode] as unknown as RecordedScenario[];

// The fifth run is about no planted bug: a dispute at PayPal that the shop was never going to hear about. It is a type of its own (snapshot.ts), so
// nothing keyed by the four planted modes has to learn it, and it is not in RECORDED_SCENARIOS; the screens that list every run take both.
export const DISPUTE_SCENARIO: RecordedDisputeScenario = disputeNeverHeard as unknown as RecordedDisputeScenario;
export const ALL_RECORDED_SCENARIOS: readonly (RecordedScenario | RecordedDisputeScenario)[] = [...RECORDED_SCENARIOS, DISPUTE_SCENARIO];

export function recordedScenario(id: RecordedScenario["id"]): RecordedScenario {
  const found = RECORDED_SCENARIOS.find((s) => s.id === id);
  if (!found) throw new Error(`no recorded scenario "${id}"`); // a typo in the code, not a runtime condition
  return found;
}

// Step `index` (0-based) of a scenario; an index past either end gives the first or the last step.
export function recordedStep(scenario: RecordedScenario, index: number): RunSnapshot {
  return scenario.steps[Math.max(0, Math.min(scenario.steps.length - 1, Math.trunc(index) || 0))];
}
