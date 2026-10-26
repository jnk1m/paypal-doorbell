// The live judge lane's client logic, without React: how a failed call is read, how requests are headed, how often to poll, and how the
// snapshots it gets become the panel of the story (lib/ui/story.ts). The lane uses the existing shop routes (session, order, refund, mode,
// ring) and POST /api/shop/snapshot, which returns a RunSnapshot.
import type { Ring, RingState, Waiting } from "../gaps/classify.ts";
import type { RunSnapshot } from "../run/snapshot.ts";
import { LIVE_FAILED, type LIVE_PENDING } from "./copy.ts";
import type { RingView, RowProg } from "./ring.ts";
import { IDLE_RING } from "./ring.ts";
import { liveDisputePanel } from "./dispute-story.ts";
import { buildPanel, closedByItself, healOf, type ChapterNo, type Panel, type Phase } from "./story.ts";
import { healWords, ringWords } from "./phrases.ts";

// The same keys as the old /stamp screen, so a token entered there is found here.
export const TOKEN_KEY = "doorbell.live";
export const SESSION_KEY = "doorbell.session";

export type LiveFailureKind =
  | "unavailable" // the snapshot route does not exist (404 / 405): the live lane is not deployed
  | "paused" // 429 / 503: the live pool is closed or spent
  | "token" // 401: the token was not accepted
  | "session" // 403 / 410: this session is not valid any more
  | "network" // the request never got an answer
  | "error"; // anything else

export interface LiveFailure {
  kind: LiveFailureKind;
  status?: number;
  message: string;
}

export function failureOf(status: number, bodyMessage?: string): LiveFailure {
  const message = bodyMessage ?? `HTTP ${status}`;
  if (status === 404 || status === 405) return { kind: "unavailable", status, message };
  if (status === 429 || status === 503) return { kind: "paused", status, message };
  if (status === 401) return { kind: "token", status, message };
  if (status === 403 || status === 410) return { kind: "session", status, message };
  return { kind: "error", status, message };
}

export const networkFailure = (): LiveFailure => ({ kind: "network", message: "The request did not reach the server." });

// Headers for the shop routes: the live token, the session when there is one, JSON when there is a body.
export function liveHeaders(token: string, session: string, withBody: boolean): Record<string, string> {
  return { "x-live-token": token, ...(session ? { "x-session": session } : {}), ...(withBody ? { "content-type": "application/json" } : {}) };
}

// A RunSnapshot, as far as the screens need to trust it. Anything else (an HTML 404 page, an error object) is not one.
export function isRunSnapshot(v: unknown): v is RunSnapshot {
  if (typeof v !== "object" || v === null) return false;
  const s = v as Partial<RunSnapshot>;
  return (s.mode === "LIVE" || s.mode === "RECORDED RUN" || s.mode === "CASE FILE") && typeof s.session === "object" && s.session !== null && Array.isArray(s.causes);
}

// What a poll compares to tell "nothing changed": the snapshot without what changes on every call by itself, so an idle session backs off instead of polling
// fast forever. That is the times (scan.at, durationMs, session.now), the countdown of a wait (ring.waitMs), the heartbeat's "12 s ago" (its text counts from
// the last delivery; the state and the counts beside it stay in the key), the seconds left that a finding's own sentence counts down (finding.why: "336 s left";
// its class, flag and waiting reason stay in the key), and the result of the witness quarantine's re-check (scan.reverify: it runs on a server instance once in
// 30 s, and says "skipped" in between, whichever session polls). The screen still shows the newest snapshot every time: this only paces the poll.
export function snapshotKey(s: RunSnapshot): string {
  const calm = s.heartbeat ? { ...s, heartbeat: { ...s.heartbeat, text: "" } } : s;
  return JSON.stringify(calm, (k, v) => (k === "at" || k === "durationMs" || k === "now" || k === "scopeAt" || k === "lastDeliveryAt" || k === "waitMs" || k === "why" || k === "reverify" ? undefined : v));
}

// How fast the lane polls (A13 item 9: each poll costs 7 Redis commands, lib/run/poll-cost.ts, and a session should cost at most 60 in 10 minutes).
//   moving   a finding is not final, or a resend is on its way: 3 s, 6 s, then 12 s
//   waiting  the page waits for PayPal's own clock (its event list, its own retries, a row too new to call): 5 s, 10 s, then 20 s
//   idle     nothing is waited for: 5 s, then twice as long each time nothing changed, up to 5 minutes. A returning tab polls at once (live-lane.tsx).
// The first poll is at once, and every action starts the ladder again.
export type Pace = "moving" | "waiting" | "idle";
export const IDLE_MAX_MS = 300_000;
export function pollDelayMs(unchangedPolls: number, pace: Pace): number {
  if (pace === "moving") return 3_000 * 2 ** Math.min(unchangedPolls, 2); // 3, 6, 12 s
  if (pace === "waiting") return 5_000 * 2 ** Math.min(unchangedPolls, 2); // 5, 10, 20 s
  return Math.min(IDLE_MAX_MS, 5_000 * 2 ** Math.min(unchangedPolls, 6)); // 5, 10, 20, 40, 80, 160, 300 s
}

// What the screens show before the first snapshot of a live session has arrived: no orders, no scan, no certificate.
export function emptyLive(sessionId = ""): RunSnapshot {
  return {
    mode: "LIVE",
    recordedAt: null,
    step: null,
    session: { session: { id: sessionId, mode: "good", planted: false, plantedLabel: "planted by us", file: "handlers/good.ts", at: 0 }, orders: [], now: 0 },
    scan: null,
    causes: [],
    certificate: null,
    heartbeat: null,
  };
}

// Is a row of this snapshot still moving (a finding that is not final, or a resend on its way)? The poll runs fast while it is.
export function hasOpenRow(s: RunSnapshot): boolean {
  const rows = s.scan?.rows ?? [];
  return rows.some((row) => row.status !== "TIED" && row.events.some((e) => e.finding && !e.finding.final)) || rows.some((row) => row.events.some((e) => e.heal?.state === "sent" || e.heal?.state === "arrived"));
}

// What the snapshot says the page is waiting for. The states below end by themselves within minutes (PayPal lists an event after 80 to 163 s and retries for
// about 163 s; an absence is called after 6 minutes), so a wait never keeps the lane at the waiting pace for long. A row that stays unverified for good (a state
// the shop does not book, a report that never lands) is not a wait.
const WAITS_ON_PAYPAL: readonly RingState[] = ["not_listed", "retries_pending", "in_progress", "wait"];
const STAYS_UNVERIFIED: readonly (Waiting | undefined)[] = ["status_not_modeled", "reporter_record_missing"];
export function paceOf(s: RunSnapshot): Pace {
  if (hasOpenRow(s)) return "moving";
  const waiting = (s.scan?.rows ?? []).some(
    (row) =>
      (row.status === "UNVERIFIED" && !STAYS_UNVERIFIED.includes(row.waiting)) ||
      (row.status !== "TIED" && (row.events.some((e) => e.finding && e.ring && WAITS_ON_PAYPAL.includes(e.ring.state)) || (row.disputes ?? []).some((d) => d.status !== "TIED" && d.ring?.state === "wait"))),
  );
  return waiting ? "waiting" : "idle";
}

// ---- the five steps of the lane ----------------------------------------------------------------------------------------------------------------------

export type LiveStepState = "done" | "current" | "todo";

// 1 a session exists, 2 an order exists, 3 a planted bug has been on (it can be off again: that is the fix), 4 an order was refunded, 5 Doorbell has
// scanned a refunded order. The first step that is not done is the current one.
export function liveSteps(s: RunSnapshot, o: { hasSession: boolean; everPlanted: boolean }): LiveStepState[] {
  const orders = s.session.orders;
  const done = [o.hasSession, orders.length > 0, s.session.session.planted || o.everPlanted, orders.some((x) => x.refundAt !== null), s.scan !== null && orders.some((x) => x.refundAt !== null)];
  const current = done.findIndex((d) => !d);
  return done.map((d, i) => (d ? "done" : i === current ? "current" : "todo"));
}

// ---- from snapshots to the panel ------------------------------------------------------------------------------------------------------------------------

// The lane keeps the last snapshot that carried a cause (the diagnosis), because the cause belongs to the planted handler: once the judge turns
// the bug off the snapshot has none, and the path should still be able to say why. A cause that is "not proven" is a diagnosis too (it is all
// the setting bug ever has), so it is kept; without it the chapters about the cause and the fix would vanish once that bug is turned off. But
// every gap is diagnosed under the session's CURRENT mode, so after a switch from one bug straight to another the old gaps come back "not
// diagnosed" or "not proven" for a mode that did not make them: such a snapshot never replaces a diagnosis made under another mode.
export function remember(diag: RunSnapshot | null, current: RunSnapshot): RunSnapshot | null {
  if (current.causes.some((c) => c.cause.status === "proposed")) return current;
  if (current.causes.length === 0) return diag;
  return diag === null || diag.session.session.mode === current.session.session.mode ? current : diag;
}

// ...and the first snapshot after the bug was turned off, which is the moment of the fix: the gaps are still open in it, and it is where Ring again starts from.
export function rememberFixed(fixed: RunSnapshot | null, diag: RunSnapshot | null, current: RunSnapshot): RunSnapshot | null {
  if (fixed) return fixed;
  return diag && diag !== current && !current.session.session.planted ? current : null;
}

export function livePanel(current: RunSnapshot, diag: RunSnapshot | null, fixed: RunSnapshot | null): { panel: Panel; ring: ReturnType<typeof buildPanel>["ring"] } {
  const { panel, ring, focus } = buildPanel({ before: diag ?? current, fixed, after: current, mode: "live" });
  // A dispute is no event: the path follows one only when it has no gap of an event to follow (nothing at all, or a row that has already closed).
  const dispute = !focus || focus.row.status === "TIED" ? liveDisputePanel(current) : null;
  return { panel: dispute ?? panel, ring };
}

// The chapter the panel opens on: the path as soon as there is a gap, the fix once the bug is off, the ring once something was resent, or once the row
// the path follows closed with no ring (PayPal's own retry reached the fixed shop): that chapter says what happened.
export function liveChapter(panel: Panel, current: RunSnapshot): ChapterNo {
  if (!panel.subject) return 1;
  if ((current.scan?.rows ?? []).some((r) => r.events.some((e) => e.heal))) return 6;
  if (closedByItself(current.scan?.rows.find((r) => r.n === panel.subject!.n))) return 6;
  if (panel.available[5]) return 5;
  return 2;
}

const phaseOfHeal = (state: string | undefined): Phase => (state === "sent" ? "sent" : state === "arrived" || state === "unchanged" ? "arrived" : state === "healed" ? "saved" : state === "lost" ? "lost" : "idle");

// The ring as the live session shows it: read from the heal records, never scripted. A focal row that is TIED with no heal record closed with no ring: the
// chapter is done and the books are right ("saved"), but nothing was asked, so no ask is counted.
export function liveRing(current: RunSnapshot, focalN: number | null): RingView {
  const rows: Record<number, RowProg> = {};
  let waiting = false;
  let any = false;
  let phase: Phase = "idle";
  for (const row of current.scan?.rows ?? []) {
    const heal = healOf(row); // on a tied row only a resend that was seen arriving: an unconfirmed one did not close it
    if (!heal) continue;
    any = true;
    const w = healWords({ state: heal.state, sends: heal.sends, ...(heal.arrivalSeconds !== undefined ? { arrivalSeconds: heal.arrivalSeconds } : {}), ...(heal.answer !== undefined ? { answer: heal.answer } : {}) }, row.status === "TIED");
    const state: RowProg["state"] = row.status === "TIED" ? "tied" : heal.state === "sent" || heal.state === "arrived" ? "wait" : "open";
    if (state === "wait") waiting = true;
    rows[row.n] = { state, note: `${w.title}.` };
    if (row.n === focalN) phase = heal.state === "healed" && row.status !== "TIED" ? "arrived" : phaseOfHeal(heal.state);
  }
  const alone = closedByItself((current.scan?.rows ?? []).find((r) => r.n === focalN));
  if (!any && !alone) return IDLE_RING;
  if (alone) phase = "saved";
  return { stage: waiting ? "running" : "done", phase, seq: 1, asks: any ? 1 : 0, travel: { to: "shop", ms: 0 }, rows, announce: "" };
}

// ---- what the lane is waiting for, and what it says when a request fails or is refused ------------------------------------------------------------------

// The request in flight, if any: the clicked control says so and the other action buttons are off. `target` names which of several controls was pressed
// (the item of an order, the handler of a mode change).
export type Pending = keyof typeof LIVE_PENDING;
export interface PendingAction {
  kind: Pending;
  target?: string;
}

// The step of the lane (0 to 4) each action belongs to: a failure is told there, beside the control that was pressed.
export const PENDING_STEP: Record<Pending, number> = { start: 0, order: 1, mode: 2, refund: 3, ring: 4, run: 4 };

// A sentence that stays where the judge acted: a request that failed ("error"), or Ring again that the server did not send ("info", it is not a fault).
export interface LaneNote {
  step: number;
  tone: "error" | "info";
  message: string;
  reasons?: string[]; // why the server did not send, in words; a reason the page already prints beside the control is not printed twice
}

// What the note prints: its message, then each reason that the page does not already say beside the control (`beside`).
export function noteText(note: LaneNote, beside: string | null): string {
  return [note.message, ...(note.reasons ?? []).filter((r) => !(beside ?? "").includes(r))].join(" ");
}

const sentence = (m: string): string => (/[.!?]$/.test(m.trim()) ? m.trim() : `${m.trim()}.`);

export function failureNote(what: Pending, f: LiveFailure): LaneNote {
  return { step: PENDING_STEP[what], tone: "error", message: `${LIVE_FAILED[what]} ${sentence(f.message)}` };
}

// A state given from outside, for the tests and for /dev/live: the lane then starts from it and makes no request of its own.
export interface LiveSeed {
  sid?: string;
  snap?: RunSnapshot | null;
  diag?: RunSnapshot | null;
  fixed?: RunSnapshot | null;
  everPlanted?: boolean;
  pending?: PendingAction | null;
  note?: LaneNote | null;
}

// ---- Ring again: when it may be pressed, and why not ---------------------------------------------------------------------------------------------------

export interface RingReadiness {
  ready: string[]; // the capture ids that can be rung now: the event is in PayPal's list and nothing else holds it back
  reason: string | null; // why the rest cannot, in plain words; null when nothing is waiting
}

// Read from the newest snapshot only. The button is on when `ready` is not empty and no request is in flight; the reason is printed beside it when it is off.
export function ringReadiness(s: RunSnapshot): RingReadiness {
  const open = (s.scan?.rows ?? []).flatMap((row) => (row.status === "TIED" ? [] : row.events.filter((e) => e.finding).map((ev) => ({ row, ev }))));
  // An open dispute has a ring state too, and it is never "ready": nothing is sent for a dispute. The backend's own words say why (lib/gaps/disputes.ts).
  const disputes = (s.scan?.rows ?? []).flatMap((row) => (row.disputes ?? []).filter((d) => d.status !== "TIED" && d.ring !== null).map((d) => ({ row, ring: d.ring! })));
  if (open.length === 0 && disputes.length === 0) return { ready: [], reason: "Nothing is left to ring." };
  const ready = open.filter(({ ev }) => ringWords(ev.ring).enabled).map(({ row }) => row.captureId);
  const byReason = new Map<string, number[]>();
  for (const { row, ev } of open) {
    const w = ringWords(ev.ring, ev.kind === "refunded" ? "refund" : "payment");
    if (!w.enabled && w.reason) byReason.set(w.reason, [...(byReason.get(w.reason) ?? []), row.n]);
  }
  for (const { row, ring } of disputes) {
    const text = ring.state === "wait" ? ringWords(ring).reason! : ring.label;
    const rows = byReason.get(text) ?? [];
    byReason.set(text, rows.includes(row.n) ? rows : [...rows, row.n]);
  }
  if (byReason.size === 0) return { ready, reason: null };
  const whole = byReason.size === 1 && [...byReason.values()][0].length === open.length + disputes.length;
  const orders = (ns: number[]): string => (ns.length === 1 ? `Order #${ns[0]}` : `Orders ${ns.slice(0, -1).map((n) => `#${n}`).join(", ")} and #${ns[ns.length - 1]}`);
  return { ready, reason: [...byReason].map(([text, ns]) => (whole ? text : `${orders(ns)}: ${text}`)).join(" ") };
}

// The answer of POST /api/shop/ring when the server did not send a resend after all (it re-reads PayPal at that moment, so the page's snapshot can be a
// few seconds behind): its reason, one sentence in the words of the screens. null when a resend went out, or when the answer is not a refusal.
export const NOT_RUNG = "Doorbell did not ask PayPal to send it again.";
export function ringRefusal(data: unknown, eventWord?: string): string | null {
  const d = data as { sent?: unknown; ring?: { state?: unknown; label?: unknown; waitMs?: unknown } } | null;
  if (!d || d.sent !== false || !d.ring || typeof d.ring.state !== "string" || typeof d.ring.label !== "string") return null;
  // PayPal's own refusal of the resend is not "the event is not listed", although the route files it under that state: its label says what happened
  const label = d.ring.label;
  const reason = label.includes("PayPal refused the resend") ? label : (ringWords(d.ring as Ring, eventWord).reason ?? label);
  return sentence(reason);
}

