// C3, the replay check (R25, plan 5.4 #3). The strongest of the three checks, and the only one that is a test rather than a reading:
// take REAL signed deliveries that the witness stored and run them, in the order they really arrived, through the good build and through
// the bad build -- the real files in handlers/, in this process -- and compare what each answers (HTTP status) and what each leaves in
// the books. "CONFIRMED BY REPLAY" means the two builds differ on real events exactly the way the planted bug predicts; anything else is
// "NOT CONFIRMED". Both builds verify the signature the way the shop does, by PayPal's verify endpoint (never offline: the server does not
// fetch URLs from headers, DO NOT CHANGE 2), so a replay is only possible while PayPal still accepts the stored signature. Past the
// replay window the result shown is the recorded one, labelled as recorded; with no recording it is NOT CONFIRMED.
//
// This runs only files of ours. It never executes a visitor's code.
import { bookingOf } from "../shop/events.ts";
import { HANDLERS } from "../shop/modes.ts";
import type { VerifyParams } from "../pay/paypal.ts";
import type { BookEntry, HandlerContext, PlantedMode } from "../shop/types.ts";

// How long a stored signature is known to stay verifiable. Plan 5.4 assumes 24 h; F15 had been seen to 34 min and S3 to 0.96 h. On
// 2026-10-19 all 251 stored deliveries re-verified, the oldest at 4.9 h (docs/measurements/s4-reverify-run1.json); on 2026-10-20 all 266
// re-verified, the oldest at 25.25 h (docs/measurements/s5-reverify-24h.json), so 24 h is measured. Older than 25.25 h is not. A replay
// older than this shows the recorded result instead.
export const REPLAY_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface ReplayDelivery {
  raw: string; // the body exactly as PayPal sent it
  headers: { transmissionId: string; transmissionTime: string; transmissionSig: string; certUrl: string; authAlgo: string };
  webhookId: string; // the webhook the signature was made for
}

export interface ReplayCase {
  mode: PlantedMode;
  deliveries: ReplayDelivery[]; // in the order they really arrived
}

export interface BuildOutcome {
  statuses: number[]; // one per delivery
  book: "paid" | "refunded" | null; // what the books say about the order afterwards; null = nothing was booked
}

export type Verdict = "CONFIRMED BY REPLAY" | "NOT CONFIRMED";

export interface ReplayResult {
  mode: PlantedMode;
  verdict: Verdict;
  basis: "replayed" | "recorded" | "none"; // none: outside the window and nothing recorded
  reason?: "expectation_not_met" | "verify_unavailable" | "outside_window_no_recording";
  ranAt: number; // when the replay really ran (for a recorded result: when it was recorded)
  events: { types: string[]; ids: string[] };
  good: BuildOutcome;
  bad: BuildOutcome;
  expectation: string; // fixed sentence per mode
}

export type VerifyFn = (p: VerifyParams) => Promise<string | undefined>;

const all = (statuses: number[], pred: (s: number) => boolean) => statuses.length > 0 && statuses.every(pred);
const ok2xx = (s: number) => s >= 200 && s < 300;

// What each planted bug must look like next to the good build on real events (plan 5.4 #3, A25).
const EXPECT: Record<PlantedMode, { text: string; holds: (good: BuildOutcome, bad: BuildOutcome) => boolean }> = {
  bad_body: {
    text: "The good build answers 200 and books the events; the bad build answers 401 and books nothing.",
    holds: (g, b) => all(g.statuses, ok2xx) && g.book !== null && all(b.statuses, (s) => s === 401) && b.book === null,
  },
  ack_then_drop: {
    text: "Both builds answer 200; the good build books the events, the bad build books nothing.",
    holds: (g, b) => all(g.statuses, ok2xx) && all(b.statuses, ok2xx) && g.book !== null && b.book === null,
  },
  last_write_wins: {
    text: "Both builds answer 200 to a refund followed by a late payment; the good build keeps the order refunded, the bad build overwrites it with paid.",
    holds: (g, b) => all(g.statuses, ok2xx) && all(b.statuses, ok2xx) && g.book === "refunded" && b.book === "paid",
  },
};

async function runBuild(mode: "good" | PlantedMode, c: ReplayCase, verify: VerifyFn, now: () => number): Promise<BuildOutcome> {
  const books = new Map<string, BookEntry>();
  const statuses: number[] = [];
  let capture: string | undefined;
  for (const d of c.deliveries) {
    const ctx: HandlerContext = {
      rawBody: d.raw,
      verify: (event) => verify({ authAlgo: d.headers.authAlgo, certUrl: d.headers.certUrl, transmissionId: d.headers.transmissionId, transmissionSig: d.headers.transmissionSig, transmissionTime: d.headers.transmissionTime, webhookId: d.webhookId, webhookEvent: event }),
      books: { get: async (id) => books.get(id) ?? null, set: async (id, entry) => void books.set(id, entry) },
      now,
    };
    try {
      statuses.push((await HANDLERS[mode].handleWebhook(ctx)).status);
    } catch (e) {
      if (e instanceof VerifyUnavailable) throw e;
      statuses.push(500); // a handler that throws answers 500, as the shop's webhook route would
    }
    try {
      capture ??= bookingOf(JSON.parse(d.raw))?.captureId;
    } catch {
      /* a body that is not JSON books nothing */
    }
  }
  return { statuses, book: capture ? (books.get(capture)?.state ?? null) : null };
}

class VerifyUnavailable extends Error {}

// Runs both builds on the deliveries. verify is PayPal's endpoint in the product (tests pass a stand-in).
export async function replayNow(c: ReplayCase, verify: VerifyFn, now: () => number = Date.now): Promise<ReplayResult> {
  // A verify call that fails (PayPal down, timeout) is not a verdict about the builds: it ends the replay as NOT CONFIRMED, reason verify_unavailable.
  const guarded: VerifyFn = async (p) => {
    try {
      return await verify(p);
    } catch {
      throw new VerifyUnavailable("verify failed");
    }
  };
  const events = { types: [] as string[], ids: [] as string[] };
  for (const d of c.deliveries) {
    try {
      const e = JSON.parse(d.raw) as { id?: unknown; event_type?: unknown };
      events.ids.push(typeof e.id === "string" ? e.id : "?");
      events.types.push(typeof e.event_type === "string" ? e.event_type : "?");
    } catch {
      events.ids.push("?");
      events.types.push("?");
    }
  }
  const base = { mode: c.mode, ranAt: now(), events, expectation: EXPECT[c.mode].text };
  try {
    const good = await runBuild("good", c, guarded, now);
    const bad = await runBuild(c.mode, c, guarded, now);
    const holds = EXPECT[c.mode].holds(good, bad);
    return { ...base, verdict: holds ? "CONFIRMED BY REPLAY" : "NOT CONFIRMED", basis: "replayed", ...(holds ? {} : { reason: "expectation_not_met" as const }), good, bad };
  } catch (e) {
    if (!(e instanceof VerifyUnavailable)) throw e;
    const none: BuildOutcome = { statuses: [], book: null };
    return { ...base, verdict: "NOT CONFIRMED", basis: "replayed", reason: "verify_unavailable", good: none, bad: none };
  }
}

export type RecordedReplays = Partial<Record<PlantedMode, ReplayResult>>;

// The age of a case is the age of its oldest delivery's transmission time: PayPal checks the signature against that.
export function caseAgeMs(c: ReplayCase, now: number): number {
  const times = c.deliveries.map((d) => Date.parse(d.headers.transmissionTime)).filter((t) => Number.isFinite(t));
  return times.length === 0 ? Infinity : now - Math.min(...times);
}

// Inside the window: replay for real. Outside it: the recorded result, labelled as recorded, or NOT CONFIRMED when there is none.
export async function replayOrRecorded(c: ReplayCase, verify: VerifyFn, recorded: RecordedReplays, now: () => number = Date.now, windowMs: number = REPLAY_WINDOW_MS): Promise<ReplayResult> {
  if (caseAgeMs(c, now()) <= windowMs) return replayNow(c, verify, now);
  const rec = recorded[c.mode];
  if (rec) return { ...rec, basis: "recorded" };
  const none: BuildOutcome = { statuses: [], book: null };
  return { mode: c.mode, verdict: "NOT CONFIRMED", basis: "none", reason: "outside_window_no_recording", ranAt: now(), events: { types: [], ids: [] }, good: none, bad: none, expectation: EXPECT[c.mode].text };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// When a replay ran, from its own `ranAt` and not from the fact that it is on the screen: "just now" only for the first seconds, then the age,
// then (past 90 minutes) the date. A result that was kept for a later poll, or recorded days ago and played back in the recorded run, says so.
export function replayAge(ranAt: number, now: number): string {
  const s = Math.round((now - ranAt) / 1000);
  if (s < 10) return "just now"; // also a result from a clock a little ahead of ours
  if (s < 90) return `${s} s ago`;
  const min = Math.round(s / 60);
  if (min < 90) return `${min} min ago`;
  const d = new Date(ranAt);
  return `on ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.toISOString().slice(11, 16)} UTC`;
}

// The line under the chip, built from fixed words. `now` is the time of the screen (default: now); a test or a page that renders a stored result
// passes its own.
export function replaySentence(r: ReplayResult, now: number = Date.now()): string {
  const label = r.basis === "recorded" ? `recorded result (${new Date(r.ranAt).toISOString().slice(0, 16).replace("T", " ")} UTC)` : r.basis === "replayed" ? `replayed ${replayAge(r.ranAt, now)}` : "no result";
  const cell = (o: BuildOutcome) => `${o.statuses.join("/") || "-"}, books ${o.book ?? "unchanged"}`;
  return r.basis === "none" ? `Replay window passed and no result was recorded (${label}).` : `Good build: ${cell(r.good)}. Bad build: ${cell(r.bad)}. (${label})`;
}
