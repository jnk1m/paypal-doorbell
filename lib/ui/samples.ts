// The SAMPLE snapshots (fixtures/samples/*.json, written by lib/ui/build-samples.ts). They match the RunSnapshot contract but are invented
// orders with invented ids; they exist so the screens can be built before the real recorded run does. lib/ui/source.ts decides which one
// the screens use.
import lateOverwrite from "../../fixtures/samples/recorded-late_payment_overwrites.json" with { type: "json" };
import neverBooked from "../../fixtures/samples/recorded-refund_never_booked.json" with { type: "json" };
import rejected from "../../fixtures/samples/recorded-signature_rejected.json" with { type: "json" };
import empty from "../../fixtures/samples/state-empty.json" with { type: "json" };
import silent from "../../fixtures/samples/state-silent.json" with { type: "json" };
import type { RecordedScenario, RunSnapshot } from "../run/snapshot.ts";

// The JSON is written from typed objects, so reading it back as those types is a cast, not a guess; check.test.ts verifies the contract.
export const SAMPLE_SCENARIOS: RecordedScenario[] = [neverBooked, lateOverwrite, rejected] as unknown as RecordedScenario[];
export const SAMPLE_EMPTY = empty as unknown as RunSnapshot;
export const SAMPLE_SILENT = silent as unknown as RunSnapshot;
