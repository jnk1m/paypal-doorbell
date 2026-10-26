// The live lane in the states a judge meets, from the recorded run's snapshots in a seeded lane (lib/ui/live.ts LiveSeed): nothing is probed, polled or
// sent, so it needs no token. /dev/live?state=order shows an order in flight, and so on; without a state, the list of them. For looking and for the screenshots.
import type { Metadata } from "next";
import type { RunSnapshot } from "../../../lib/run/snapshot.ts";
import { CATALOG } from "../../../lib/shop/catalog.ts";
import { ALL_MODES } from "../../../lib/shop/types.ts";
import { failureNote, failureOf, NOT_RUNG, type LiveSeed } from "../../../lib/ui/live.ts";
import { disputeSeed, notProvenSeed, selfHealedSeed } from "../../../lib/ui/live-seeds.ts";
import { TermPlanner } from "../../../lib/ui/glossary.ts";
import { SCENARIOS, allStories } from "../../../lib/ui/source.ts";
import { modeLine } from "../../../lib/ui/story.ts";
import { LiveLane } from "../../_components/live-lane.tsx";
import { TopBar } from "../../_components/top-bar.tsx";

export const metadata: Metadata = { title: "Live states | Doorbell" };

const A = SCENARIOS[0].steps; // the dropped refund: the incident (with a proven fix), the fix, the ring in progress, the end
const live = (i: number): RunSnapshot => ({ ...structuredClone(A[i]), mode: "LIVE", recordedAt: null, step: null });
// every open row's refund event in a state of PayPal's list
function listed(s: RunSnapshot, isListed: boolean): RunSnapshot {
  for (const row of s.scan!.rows) for (const e of row.events) if (e.finding && row.status !== "TIED") Object.assign(e, { listed: isListed, ring: { state: isListed ? "ready" : "not_listed", label: "Ring again" } });
  return s;
}
const base: LiveSeed = { sid: "9f3a1c52-demo", everPlanted: true };
const gaps = (isListed: boolean): LiveSeed => ({ ...base, snap: listed(live(0), isListed), diag: live(0), fixed: null });
const fixed = (isListed: boolean): LiveSeed => ({ ...base, snap: listed(live(1), isListed), diag: live(0), fixed: live(1) });

const STATES: Record<string, { what: string; seed: () => LiveSeed }> = {
  order: { what: "an order is being placed", seed: () => ({ ...base, snap: null, everPlanted: false, pending: { kind: "order", target: Object.keys(CATALOG)[0] } }) },
  mode: { what: "the handler is being changed", seed: () => ({ ...gaps(true), pending: { kind: "mode", target: ALL_MODES.find((m) => m === "good")! } }) },
  refund: { what: "a refund is being asked for", seed: () => ({ ...base, snap: live(0), diag: null, pending: { kind: "refund" } }) },
  waiting: { what: "the working handler is on, PayPal has not listed the refund event: Ring again is off and says why", seed: () => fixed(false) },
  ready: { what: "the event is listed: Ring again is on, and the proposed fix is under the gaps", seed: () => fixed(true) },
  ring: { what: "Ring again is being sent", seed: () => ({ ...fixed(true), pending: { kind: "ring" } }) },
  refused: {
    what: "the server refused the ring after all",
    seed: () => ({ ...fixed(true), note: { step: 4, tone: "info", message: NOT_RUNG, reasons: ["PayPal has not listed the refund event yet, usually 1 to 3 minutes after the refund (median about 80 s, up to 163 s measured). A resend needs it listed, so Ring again unlocks when it is."] } }),
  },
  failed: { what: "a request failed", seed: () => ({ ...gaps(true), note: failureNote("refund", failureOf(500, "Something went wrong.")) }) },
  notproven: { what: "the setting bug is on, the gaps are found and the AI named no line: the reason is under each gap", seed: notProvenSeed },
  selfhealed: { what: "PayPal's own retry reached the fixed shop before Ring again was allowed: the rows are tied and the Ring again chapter says so, with no resend", seed: selfHealedSeed },
  dispute: { what: "a $48.00 dispute that PayPal lists and the books do not show: no webhook of the app asks for dispute events, so there is no handler, replay, fix or event to ring, and Ring again says why", seed: disputeSeed },
};

export default async function LiveStatesPage({ searchParams }: { searchParams: Promise<{ state?: string }> }) {
  const { state } = await searchParams;
  const chosen = state ? STATES[state] : undefined;
  if (!chosen) {
    return (
      <>
        <TopBar bar={modeLine(new TermPlanner(), { mode: "LIVE", recordedAt: null })} />
        <main id="main" className="gal">
          <h1 className="focal">Live lane states</h1>
          <ul className="list dash">
            {Object.entries(STATES).map(([key, s]) => (
              <li key={key}>
                <a href={`/dev/live?state=${key}`}>{key}</a>: {s.what}
              </li>
            ))}
          </ul>
        </main>
      </>
    );
  }
  return <LiveLane stories={allStories()} seed={chosen.seed()} />;
}
