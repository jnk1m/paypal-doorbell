// Ring again, as a script. A recorded run plays the REAL ring: each row's resends, the real waits between them and the real arrival time come
// from the heal data of the last recorded step (LedgerRow.ring). The only thing changed is time: a wait longer than 5 s is played as 1.3 s,
// and the page says so in small text (story.ts ringCopy). The arrival itself is played at its real length (clamped to 1.5 to 4.5 s).
//
// The script is pure: ringBeats() returns the beats with the delay before each one, and the screen only runs them. That makes the length, the
// order and the end state testable without a clock. The end state of the script is what a reader with reduced motion sees at once.
import type { LedgerRow, Phase } from "./story.ts";

export interface RowProg {
  state: "wait" | "tied" | "open";
  note: string;
}

export interface RingView {
  stage: "idle" | "running" | "done";
  phase: Phase; // where the resend of the row the path follows stands
  seq: number; // grows with every beat
  asks: number; // how many times the ask has gone out: the ripple at Doorbell restarts with each
  travel: { to: "shop" | "half"; ms: number }; // how the message moves in the phase "sent": all the way, or part of it (it did not arrive)
  rows: Record<number, RowProg>; // by order number
  announce: string; // for screen readers
}

export const IDLE_RING: RingView = { stage: "idle", phase: "idle", seq: 0, asks: 0, travel: { to: "shop", ms: 0 }, rows: {}, announce: "" };

export interface Beat {
  after: number; // ms to wait before this beat
  patch: Partial<Pick<RingView, "stage" | "phase" | "travel" | "announce">>;
  rows?: Record<number, RowProg>;
}

export const ASK_MS = 450; // the ripple and the ask
export const SHORTENED_MS = 1300; // a wait longer than 5 s, played short
export const PAUSE_MS = 900; // between two rows
export const TICK_MS = 100;

const seconds = (s: number): string => `${s.toFixed(1)} s`;
const arrivalMs = (s: number): number => Math.min(4500, Math.max(1500, Math.round(s * 1000)));

export function finalPhase(row: LedgerRow | undefined): Phase {
  return !row || !row.ring ? "idle" : row.ring.end === "tied" ? "saved" : "lost";
}

// What the ring leaves when it is over: every ringed row at its end state.
export function finalRows(ledger: LedgerRow[]): Record<number, RowProg> {
  const rows: Record<number, RowProg> = {};
  for (const r of ledger) if (r.ring) rows[r.n] = { state: r.ring.end === "tied" ? "tied" : "open", note: r.end.note ?? "" };
  return rows;
}

export function ringBeats(ledger: LedgerRow[], focalN: number | null, result: string): Beat[] {
  const plan = ledger.filter((r) => r.ring);
  const beats: Beat[] = [];
  if (plan.length === 0) return beats;
  let first = true;

  for (const row of plan) {
    const r = row.ring!;
    const focal = r.n === focalN;
    if (!first) beats.push({ after: PAUSE_MS, patch: {} });
    beats.push({
      after: 0,
      patch: first ? { stage: "running", announce: "Waiting for PayPal to deliver the event again." } : {},
      rows: { [r.n]: { state: "wait", note: "Waiting for the event to arrive." } },
    });
    first = false;

    for (let i = 0; i < r.sends; i++) {
      const last = i === r.sends - 1;
      const of = `Resend ${i + 1} of ${r.sends}`;
      const arrives = last && r.arrivalSeconds !== null;
      if (focal) beats.push({ after: i === 0 ? 0 : 300, patch: { phase: "ask" } });
      if (!arrives) {
        // a resend that PayPal accepted and that did not arrive: the message starts out and does not reach the shop
        beats.push({ after: focal ? ASK_MS : 300, patch: focal ? { phase: "sent", travel: { to: "half", ms: 1100 } } : {}, rows: { [r.n]: { state: "wait", note: `${of}, waiting for it to arrive.` } } });
        beats.push({ after: SHORTENED_MS, patch: {}, rows: last ? { [r.n]: { state: "wait", note: `${of}: nothing arrived in ${r.windowSec} s.` } } : undefined });
        continue;
      }
      const s = r.arrivalSeconds!;
      const ms = arrivalMs(s);
      beats.push({ after: focal ? ASK_MS : 300, patch: focal ? { phase: "sent", travel: { to: "shop", ms } } : {}, rows: { [r.n]: { state: "wait", note: `${of}, ${seconds(0)} since it was sent.` } } });
      for (let t = TICK_MS; t < ms; t += TICK_MS) {
        const shown = s * (t / ms);
        beats.push({ after: TICK_MS, patch: {}, rows: { [r.n]: { state: "wait", note: `${of}, ${seconds(shown)} since it was sent.` } } });
      }
      beats.push({ after: TICK_MS, patch: focal ? { phase: "arrived" } : {} });
    }

    // the end of this row: the books changed (tied) or did not
    beats.push({
      after: focal ? 450 : 300,
      patch: focal ? { phase: r.end === "tied" ? "saved" : "lost" } : {},
      rows: { [r.n]: { state: r.end === "tied" ? "tied" : "open", note: row.end.note ?? "" } },
    });
  }
  beats.push({ after: 400, patch: { stage: "done", announce: result } });
  return beats;
}

export function applyBeat(v: RingView, b: Beat): RingView {
  return { ...v, ...b.patch, seq: v.seq + 1, asks: b.patch.phase === "ask" ? v.asks + 1 : v.asks, rows: b.rows ? { ...v.rows, ...b.rows } : v.rows };
}

// The view a reader with reduced motion gets the moment Ring again is pressed, and the view the script ends on.
export function finalRing(ledger: LedgerRow[], focalN: number | null, result: string): RingView {
  const focal = ledger.find((r) => r.n === focalN);
  const phase = finalPhase(focal);
  return { stage: "done", phase, seq: 1, asks: 1, travel: { to: "shop", ms: 0 }, rows: finalRows(ledger), announce: result };
}

export const totalMs = (beats: Beat[]): number => beats.reduce((sum, b) => sum + b.after, 0);
