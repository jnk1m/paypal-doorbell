// The state gallery (plan 10.1 #8, R22): the states the screens can be in, side by side, from the same components and the same data as the real
// screens. The five marks, the path while Ring again runs (and when it fails), the rows of the ledger, the three states of the cause, each reason
// Ring again can be off, each thing that can happen after a resend, the certificate in its three colors, and the quiet states. Nothing here calls
// anything; it is for looking and for the screenshots. The samples (invented data) are used only where the recording has no such state.
import type { Metadata } from "next";
import type { CauseResult } from "../../../lib/cause/cause.ts";
import { NOT_DIAGNOSED_TEXT, NOT_PROVEN_TEXT } from "../../../lib/cause/categories.ts";
import type { Ring } from "../../../lib/gaps/classify.ts";
import type { RunSnapshot } from "../../../lib/run/snapshot.ts";
import type { HealState } from "../../../lib/shop/types.ts";
import { NO_ORDERS_BODY, NO_ORDERS_TITLE, PAUSED_NOTICE, SILENT_BODY, SILENT_TITLE, UNAVAILABLE_NOTICE } from "../../../lib/ui/copy.ts";
import { TermPlanner } from "../../../lib/ui/glossary.ts";
import { healWords, ringWords } from "../../../lib/ui/phrases.ts";
import { IDLE_RING, type RingView } from "../../../lib/ui/ring.ts";
import { SAMPLE_SCENARIOS } from "../../../lib/ui/samples.ts";
import { SCENARIOS } from "../../../lib/ui/source.ts";
import { buildPanel, certView, modeLine, type MarkKind, type Panel } from "../../../lib/ui/story.ts";
import { Mark, Tick } from "../../_components/marks.tsx";
import { PathPanel } from "../../_components/path-panel.tsx";
import { Quiet } from "../../_components/quiet.tsx";
import { RichText } from "../../_components/rich-text.tsx";
import { SiteFooter } from "../../_components/site-footer.tsx";
import { TopBar } from "../../_components/top-bar.tsx";
import { plainRich } from "../../../lib/ui/rich.ts";

export const metadata: Metadata = { title: "States | Doorbell" };

function Spec({ label, note, children }: { label: string; note?: string; children: React.ReactNode }) {
  return (
    <div className="spec">
      <h3>{label}</h3>
      {note ? <p className="small">{note}</p> : null}
      {children}
    </div>
  );
}

const MARKS: [MarkKind, string, string][] = [
  ["ghost", "Not traced yet", "nothing is known about this hop"],
  ["ink", "Starting point", "where the story begins"],
  ["ok", "Worked", "this hop did what it should; navy, and green only when the certificate says green"],
  ["bad", "Went wrong", "this is where the books and PayPal part"],
  ["wait", "Waiting", "a resend is on its way, or the row is not provable yet"],
];

const ring = (phase: RingView["phase"], stage: RingView["stage"], rows: RingView["rows"]): RingView => ({ ...IDLE_RING, stage, phase, seq: 1, asks: phase === "idle" ? 0 : 1, rows });

const live = (s: RunSnapshot): RunSnapshot => ({ ...s, mode: "LIVE", recordedAt: null, step: null });

export default function StatesPage() {
  const [a, , c] = SCENARIOS;
  const red = a.steps[0];
  const fixed = a.steps[1];
  const end = a.steps[a.steps.length - 1];
  const rejectedEnd = c.steps[c.steps.length - 1];
  const amber = SAMPLE_SCENARIOS.flatMap((s) => s.steps).find((s) => s.certificate?.stamp === "amber");

  const base = buildPanel({ before: red, fixed, after: end, mode: "script" });
  const panel: Panel = base.panel;
  const n = panel.subject?.n ?? 2;
  const rejected = buildPanel({ before: c.steps[0], fixed: c.steps[1], after: rejectedEnd, mode: "script" }).panel;

  // The cause in its three states, on the same path.
  const withCause = (cause: CauseResult): Panel => {
    const s = structuredClone(red);
    s.causes = s.causes.map((x) => ({ ...x, cause, replay: null, confirmation: null }));
    return buildPanel({ before: s, fixed: null, after: null, mode: "live" }).panel;
  };
  const notProven: CauseResult = { status: "not_proven", reason: "comment_line", text: NOT_PROVEN_TEXT, promptVersion: "gallery", requestHash: "" };
  const notDiagnosed: CauseResult = { status: "not_diagnosed", reason: "timeout", text: NOT_DIAGNOSED_TEXT, promptVersion: "gallery", requestHash: "" };

  const phases: [string, string, RingView][] = [
    ["Ready", "Ring again has not been pressed.", IDLE_RING],
    ["Resend accepted, waiting", "PayPal accepted the resend; the elapsed seconds count.", ring("sent", "running", { [n]: { state: "wait", note: "Resend 1 of 1, 1.8 s since it was sent." } })],
    ["Delivered, books not yet read", "The delivery reached the shop; the books are checked next.", ring("arrived", "running", { [n]: { state: "wait", note: "Resend 1 of 1, 3.3 s since it was sent." } })],
    ["Books changed", "The books now agree with PayPal.", ring("saved", "done", { [n]: { state: "tied", note: "Arrived 3.3 s after PayPal accepted the resend." } })],
    ["Resend accepted, not delivered", "Nothing arrived; the gap stays open.", ring("lost", "done", { [n]: { state: "open", note: "Resend accepted, not delivered." } })],
  ];

  const ringReasons: [string, Ring][] = [
    ["Ready", { state: "ready", label: "Ring again" }],
    ["Retries pending", { state: "retries_pending", label: "PayPal is still retrying on its own", waitMs: 95_000 }],
    ["Not listed yet", { state: "not_listed", label: "Cannot auto-heal" }],
    ["No event found", { state: "cannot_heal", label: "Cannot auto-heal" }],
    ["Not provable yet", { state: "wait", label: "Not provable yet", waitMs: 270_000 }],
    ["Resend in progress", { state: "in_progress", label: "Resent, waiting for it to arrive" }],
    ["Limit reached", { state: "cap_reached", label: "Resend limit reached (5 per session)" }],
  ];
  const heals: [string, HealState, number, boolean][] = [
    ["Resend accepted, waiting", "sent", 1, false],
    ["Delivered, books being checked", "arrived", 1, false],
    ["Delivered, books still differ", "unchanged", 1, false],
    ["Resend accepted, not delivered", "lost", 3, false],
    ["Healed, the row is tied", "healed", 1, true],
    ["Healed claimed, the row is not tied", "healed", 1, false],
  ];

  const certs = [
    ["Red", "at least one gap", certView(live(red), red, false, plainRich)],
    ["Amber", "no gap, but a row is still too new to verify", amber ? certView(live(amber), amber, true, plainRich) : null],
    ["Green", "covered, nothing unverified, no gap: the only place green appears", certView(live(end), red, true, plainRich)],
  ] as const;

  const bar = modeLine(new TermPlanner(), live(red));

  return (
    <>
      <TopBar bar={bar} />
      <main id="main" className="gal">
        <h1 className="focal">States</h1>
        <p className="lead">The states the screens can be in, from the same components and data as the real screens. Each state is a shape and words first; color never carries one alone.</p>

        <section aria-labelledby="g-marks">
          <h2 id="g-marks">Marks</h2>
          <div className="marks">
            {MARKS.map(([kind, name, note]) => (
              <div key={kind}>
                <Mark kind={kind} />
                <span>
                  {name}
                  <span className="small"> {note}</span>
                </span>
              </div>
            ))}
          </div>
        </section>

        <section aria-labelledby="g-ring">
          <h2 id="g-ring">The path while Ring again runs</h2>
          <div className="specimens">
            {phases.map(([label, note, r]) => (
              <Spec key={label} label={label} note={note}>
                <PathPanel panel={panel} chapter={6} fixed ring={r} motion={false} />
              </Spec>
            ))}
          </div>
        </section>

        <section aria-labelledby="g-cause">
          <h2 id="g-cause">The cause</h2>
          <div className="specimens">
            <Spec label="Proposed, checked and replayed" note="the lines of the change, and the two checks that passed">
              <PathPanel panel={panel} chapter={3} fixed ring={IDLE_RING} motion={false} />
            </Spec>
            <Spec label="Cause not proven" note="a check failed; the gap stands on its own">
              <PathPanel panel={withCause(notProven)} chapter={3} fixed ring={IDLE_RING} motion={false} />
            </Spec>
            <Spec label="Not diagnosed" note="the AI step did not run; nothing about the cause is claimed">
              <PathPanel panel={withCause(notDiagnosed)} chapter={3} fixed ring={IDLE_RING} motion={false} />
            </Spec>
            <Spec label="The replay" note="the same real events through the good and the bad build">
              <PathPanel panel={panel} chapter={4} fixed ring={IDLE_RING} motion={false} />
            </Spec>
          </div>
        </section>

        <section aria-labelledby="g-ledger">
          <h2 id="g-ledger">The ledger</h2>
          <div className="specimens">
            <Spec label="Gaps open, the fix deployed" note="two rows differ from PayPal, one is tied">
              <PathPanel panel={panel} chapter={5} fixed ring={IDLE_RING} motion={false} />
            </Spec>
            <Spec label="After Ring again, one row still open" note="one row tied again; the other stays a gap, and it says why">
              <PathPanel panel={rejected} chapter={7} fixed ring={{ ...IDLE_RING, stage: "done", phase: "saved", asks: 1 }} motion={false} />
            </Spec>
          </div>
        </section>

        <section aria-labelledby="g-ringoff">
          <h2 id="g-ringoff">Ring again, and why it can be off</h2>
          <div className="specimens">
            {ringReasons.map(([label, r]) => {
              const w = ringWords(r);
              return (
                <Spec key={label} label={label} note={w.enabled ? "the button is on" : "the button is off, and says why"}>
                  <p className="body">{w.enabled ? "Ring again" : w.reason}</p>
                </Spec>
              );
            })}
            {heals.map(([label, state, sends, tied]) => {
              const w = healWords({ state, sends, arrivalSeconds: 3.3, answer: 200 }, tied);
              return (
                <Spec key={label} label={w.title} note={label}>
                  <p className="body">{w.detail}</p>
                </Spec>
              );
            })}
          </div>
        </section>

        <section aria-labelledby="g-cert">
          <h2 id="g-cert">The certificate</h2>
          <div className="specimens">
            {certs.map(([label, note, cv]) =>
              cv ? (
                <Spec key={label} label={label} note={note}>
                  <div data-cert={cv.stamp === "green" ? "green" : "none"} className="cert-spec">
                    <p className="lead">{cv.focal}</p>
                    <p className="body">{cv.lead}</p>
                    <ul className="list ticks">
                      {cv.checks.map((k, i) => (
                        <li key={i}>
                          <Tick done={k.done} />
                          <RichText r={k.rich} />
                        </li>
                      ))}
                    </ul>
                  </div>
                </Spec>
              ) : null,
            )}
          </div>
        </section>

        <section aria-labelledby="g-quiet">
          <h2 id="g-quiet">Quiet states</h2>
          <div className="specimens">
            <Spec label="Loading" note="while the first snapshot is on its way">
              <Quiet kind="ghost" title="Loading">
                Reading the books and asking PayPal takes a few seconds.
              </Quiet>
            </Spec>
            <Spec label="Working" note="a live run in progress; a real clock, nothing sped up">
              <Quiet title="Working">23 s since your last action. A run takes about 60 s.</Quiet>
            </Spec>
            <Spec label="Error" note="the live service did not answer; the page stays as it was">
              <Quiet kind="bad" title="Doorbell could not read this">
                HTTP 500. Nothing on this page was changed. The recorded run needs no network.
              </Quiet>
            </Spec>
            <Spec label="Live lane unavailable" note="falls back to the recorded run">
              <Quiet kind="ghost" title={UNAVAILABLE_NOTICE} />
            </Spec>
            <Spec label="Live lane paused" note="the pool is spent or closed">
              <Quiet kind="ghost" title={PAUSED_NOTICE} />
            </Spec>
            <Spec label="No orders" note="nothing to check yet">
              <Quiet kind="ghost" title={NO_ORDERS_TITLE}>
                {NO_ORDERS_BODY}
              </Quiet>
            </Spec>
            <Spec label="Witness silent" note="silence is not health">
              <Quiet kind="wait" title={SILENT_TITLE}>
                {SILENT_BODY}
              </Quiet>
            </Spec>
          </div>
        </section>
      </main>
      <SiteFooter live={false} />
    </>
  );
}
