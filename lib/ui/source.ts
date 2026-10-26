// THE ONE IMPORT POINT for what the screens play back as a recorded run (R12: no network, no keys). It is the REAL recording captured from the
// deployed shop (fixtures/recorded-run, read by lib/run/recorded.ts), never the invented samples. The samples (fixtures/samples, built by
// lib/ui/build-samples.ts) stay for the state gallery and for tests that need a snapshot the recording does not have; those import them from
// lib/ui/samples.ts explicitly.
import { MODEL_ID } from "../core/llm.ts";
import { ALL_RECORDED_SCENARIOS, DISPUTE_SCENARIO, RECORDED_SCENARIOS } from "../run/recorded.ts";
import type { RecordedScenario } from "../run/snapshot.ts";
import { disputeStoryOf } from "./dispute-story.ts";
import { SCENARIO_LABEL } from "./phrases.ts";
import { storyOfScenario, type Story } from "./story.ts";

export const SCENARIOS: readonly RecordedScenario[] = RECORDED_SCENARIOS;

// Every recorded run, the four with a planted bug and then the dispute nobody heard (which is not a RecordedScenario: it has no planted mode).
export const ALL_SCENARIOS = ALL_RECORDED_SCENARIOS;

export const scenarioLabel = (s: { id: string; title: string }): string => SCENARIO_LABEL[s.id] ?? s.title;

// The three recorded runs as stories, in the order a visitor meets them. Built on the server: the browser gets the story, not the recording.
// MODEL_ID is the model of the config (the recordings were made with it: the recording's name is a hash that includes it). It is read here, on the server,
// and handed to the story: lib/ui/story.ts is bundled for the browser and must not import the module that reaches the AI SDK.
export const recordedStories = (): Story[] => SCENARIOS.map((s) => storyOfScenario(s, scenarioLabel(s), { model: MODEL_ID }));

// The pages that list every run (the landing, the live lane's recorded fallback): the four stories above, then the dispute story (lib/ui/dispute-story.ts).
// recordedStories() stays the four planted-bug runs: the tests of what a planted bug looks like loop over it.
export const allStories = (): Story[] => [...recordedStories(), disputeStoryOf(DISPUTE_SCENARIO, scenarioLabel(DISPUTE_SCENARIO))];
