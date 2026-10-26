// The incident story (S5 design): one pure function from the run's snapshots to what the screens print. A recorded scenario and a live session
// both go through it, so the page cannot show something the live product would not. Every sentence is a fixed template with numbers, times
// and ids read from a RunSnapshot, or a line of the diff found by its id; no model text and no PayPal text is ever put into a sentence.
//
//   Panel     what the sticky path panel draws (PayPal -> Doorbell -> your shop -> your books), as layers that each chapter turns on or off
//   Story     the left column: seven chapters of copy, built on the same facts as the panel, plus the captures list and the certificate
//
// The seven chapters: What happened / How it travelled / Why / The replay / The fix is deployed / Ring again / Certificate.
//
// Chapter 5 may carry a FixProof: the patch Claude proposed for the cited lines, the code checks, the replay controls, what the patch leaves behind and
// what the demo really deployed. It is built only from a recorded fix result (lib/fix) that was proven and sits beside a cause the replay confirmed; a
// scenario without one tells chapter 5 as it always did.
//
// A rule of the copy: the path panel never uses one of the ten glossary words before the left column has explained it, because on a phone
// the panel sits between a chapter's headline and its text. The words that panel lines avoid are named in glossary.test.ts's page test.
//
//   Story.phone   what a phone prints instead of the left column: per chapter one sentence, one piece of evidence and a "More" with the rest of the text.
//                 Built from the same facts, with its own TermPlanner (a phone has its own reading order). Station.glance is the strip's few words.
import { CATEGORIES, CAUSE_TEMPLATE, symptomClassOf, type Category, type SymptomClass } from "../cause/categories.ts";
import { confirmationOf } from "../cause/confirm.ts";
import { escapeForDisplay } from "../cause/hygiene.ts";
import { FOOTNOTE, header as certHeader } from "../cert/templates.ts";
import { CANNOT_SEE, CONTROL_NAME, leftoversLine, type FixResult } from "../fix/types.ts";
import { SANDBOX_ATTEMPTS } from "../gaps/classify.ts";
import { closureOf, healArrived, is2xx, type Closure } from "../gaps/closure.ts";
import type { ScanEvent, ScanRow } from "../gaps/scan.ts";
import type { GapCause, RecordedScenario, RunSnapshot } from "../run/snapshot.ts";
import type { AttemptReport } from "../shop/reporter.ts";
import { isSettingBug } from "../shop/types.ts";
import { HONESTY, PITCH_BEATS, PITCH_FIRST, PITCH_LOOKS, PLANTED, SHOP_NAME } from "./copy.ts";
import { money, utcDateTime, utcDay, utcTime, utcTimeMs, utcTimeTenth } from "./format.ts";
import { TermPlanner } from "./glossary.ts";
import { NOT_DIAGNOSED_PHRASE, NOT_PROVEN_PHRASE, evidenceWords, healWords } from "./phrases.ts";
import { plainRich, planRich, type Rich } from "./rich.ts";

// ---- vocabulary -----------------------------------------------------------------------------------------------------------------------

export type ChapterNo = 1 | 2 | 3 | 4 | 5 | 6 | 7;
export const CHAPTERS: readonly { no: ChapterNo; tab: string; full: string }[] = [
  { no: 1, tab: "What happened", full: "What happened" },
  { no: 2, tab: "How it travelled", full: "How the message travelled" },
  { no: 3, tab: "Why", full: "Why" },
  { no: 4, tab: "The replay", full: "The replay" },
  { no: 5, tab: "The fix", full: "The fix is deployed" },
  { no: 6, tab: "Ring again", full: "Ring again" },
  { no: 7, tab: "Certificate", full: "The certificate" },
];

// The four stations of the path, and the five marks a station can wear. A mark is a shape first (color never carries it alone).
export type StationKey = "paypal" | "doorbell" | "shop" | "books";
export type MarkKind = "ghost" | "ink" | "ok" | "bad" | "wait";
// Where Ring again stands for the row the path follows. Recorded: scripted from the real heal data. Live: read from the heal record.
export type Phase = "idle" | "ask" | "sent" | "arrived" | "saved" | "lost";
export const PHASES: readonly Phase[] = ["idle", "ask", "sent", "arrived", "saved", "lost"];

// A token names a moment of the panel: a chapter ("2"), or the ring chapter with its phase ("6:sent"). A layer says which tokens it shows in.
export const tokensOf = (ch: ChapterNo, phase: Phase): string[] => (ch === 6 ? ["6", `6:${phase}`] : [String(ch)]);

// How long Doorbell watches for a resent delivery (lib/gaps/heal.ts ARRIVAL_WAIT_MS; story.test.ts checks they agree). Not imported: that module reaches the PayPal client.
export const RESEND_WINDOW_S = 60;

export type GapKind = "ack" | "late" | "rejected" | "other";

// ---- the panel -------------------------------------------------------------------------------------------------------------------------

export interface Line {
  kind: "text" | "sub" | "id" | "ghost";
  rich: Rich;
}
export interface CodeLine {
  no: number | null;
  file: string;
  kind: "add" | "del" | "rename";
  text: string;
}
// A check is done (a check mark), or open (a ring with a dot): "the category fits the symptom" cannot fail for OTHER_CODE_CHANGE, so it is never
// shown as passed there. The receipt is one small line under the checks: what the AI did, from the recording and the config, never from its text.
export interface CodeCheck {
  done: boolean;
  text: string;
}
export interface CodeBlock {
  caption: Rich;
  lines: CodeLine[];
  checks: CodeCheck[];
  receipt: string | null;
}
// A variant is one of several texts that take the same place and cross-fade; `flip` makes the books slide from one to the other.
export interface Variant {
  on: string[];
  lines: Line[];
  flip?: "from" | "to";
}
export interface Layer {
  on: string[];
  variants: Variant[];
  code?: CodeBlock;
  mark?: MarkKind; // [Track UI-B] the phone's mark beside a quiet evidence block (no code): "wait" when absent
}
export interface Timed {
  on: string[];
  text: string;
}
export interface Station {
  key: StationKey;
  name: string;
  sub: string | null;
  times: Timed[];
  layers: Layer[];
  hop: Timed | null; // a quiet line under the station, on the way to the next
  marks: Record<string, MarkKind>; // "2", "6:sent" ...; a missing entry is "ok"
  // What the phone's strip says under this stop, by the same tokens as `marks` ("2", "6:sent" ...; a token falls back to its chapter, "6"): a few
  // characters read from the same facts as the lines above. The strip comes before the text that explains the glossary words, so it uses none.
  glance: Record<string, string>;
  // The tokens in which this station is a hop that has not been followed yet, not a node: chapter 1 knows only PayPal's answer and the books, and the
  // next chapter follows the message through Doorbell and the shop. The screen draws it as a quiet link between the two, never as loading or failed.
  untraced: string[];
}

export interface BuildView {
  name: string; // "Good build"
  file: string; // "good.ts"
  planted: boolean;
  statuses: number[]; // what the build answered to each event
  answers: string[]; // "Answers **200 OK**"
  books: Rich;
  booksShort: string; // what the books say, for the phone's strip: "Refunded", "Paid", "No entry"
  ok: boolean; // the build whose books come out right
}
export interface ReplayModel {
  title: string;
  sub: string;
  ids: string[];
  good: BuildView;
  bad: BuildView;
  verdict: { text: string; confirmed: boolean; note: string | null };
  basis: string | null; // "This is a recorded result (2026-10-19 07:15 UTC)": said when the result is from an earlier run
}

export type RowKind = "tied" | "gap" | "unverified";
// What Ring again did to one row, from the heal record: how many resends, the real waits between them, and how it ended.
export interface RingRow {
  n: number;
  sends: number;
  waitsSec: number[]; // the real gaps between consecutive resends
  offsetSec: number; // the real delay between the first resend of the first row and this row's first resend
  arrivalSeconds: number | null; // from the last resend to the first delivery; null when nothing arrived
  answer: number | null;
  sentAt: number[];
  arrivedAt: number | null;
  end: "tied" | "open";
  endTitle: string; // healWords(...).title of the final heal
  windowSec: number; // how long Doorbell watches for a delivery after a resend
}
export interface LedgerRow {
  n: number;
  captureId: string;
  item: string;
  amount: string; // "$48.00"
  paypal: string; // "Paid" | "Refunded"
  start: { books: string; kind: RowKind };
  end: { books: string; kind: RowKind; note: string | null };
  ring: RingRow | null;
}

export interface Subject {
  n: number;
  label: string; // "Order #2, gift set"
  amount: string; // "$48.00"
  captureId: string;
  eventWord: "refund" | "payment" | "dispute";
}

export interface Panel {
  subject: Subject | null;
  stations: Station[];
  replay: ReplayModel | null;
  ledger: LedgerRow[];
  money: string; // "$110.00": the total of the run's orders
  available: Record<ChapterNo, boolean>;
  mode: "script" | "live"; // script: Ring again is played from the recorded heal data; live: read from the snapshot as it changes
  fixedFile: string | null;
  badFile: string | null;
  // [Track UI-B] How many of the road's three links a message crossed in the chapters that follow it (2: PayPal, Doorbell, the shop; the default). A dispute
  // nobody was listening for crossed none: 0 keeps the road unlit and plays no travel, because a lit road would say that something arrived.
  reach?: 0 | 1 | 2;
}

// ---- the left column --------------------------------------------------------------------------------------------------------------------

export interface CertView {
  stamp: "green" | "amber" | "red";
  focal: string;
  lead: string;
  cannot: Rich[]; // what this run cannot prove: the run's own limits first, then the standing ones; the last says it is not signed
  checks: { done: boolean; rich: Rich }[];
}

export interface CaptureRow {
  n: number;
  item: string;
  amount: string;
  paypal: string;
  books: string;
  result: string;
  kind: RowKind;
}

// ---- the phone's copy -------------------------------------------------------------------------------------------------------------------
// On a phone each chapter is its headline, ONE sentence, ONE piece of evidence and a single "More" that holds the rest of the chapter's text (so
// nothing is cut, only folded). The sentence and the evidence are built here from the same facts as the chapter's paragraphs; the paragraphs
// that are not the sentence are the "More". A phone prints this copy and not the desktop's, so it has its own TermPlanner: a glossary word is
// explained at its first place in the phone's own reading order (the bar, the strip, then chapter 1 to 7), and the strip's words are not glossary words.

// One side of the first chapter's "PayPal says / your books say".
export interface PhoneSide {
  who: string; // "PayPal says"
  word: string; // "Refunded"
  amount: string | null; // "$48.00"; null when the books have no entry
  mark: MarkKind;
}
// A row of the timed rail of chapter 2. `dashed`: nothing followed this row, so the line below it is dashed. `mark`: a status mark in place of the dot.
export interface PhoneRow {
  t: string | null;
  x: Rich;
  dashed: boolean;
  mark: MarkKind | null;
}
// Chapter 5: the cited line of the handler before the fix and now (lines of code each, or null when that side has none), or the setting.
export type PhoneChange = { kind: "code"; before: string[] | null; now: string[] | null } | { kind: "setting"; before: string; now: string };

export interface PhoneStory {
  c1: { vs: [PhoneSide, PhoneSide]; caption: Rich; beats: Rich[]; more: Rich[] };
  c2: { rows: PhoneRow[]; short: Rich; more: Rich[] };
  c3: { short: Rich; more: Rich[] }; // the evidence is the panel's own: the code block, or its two lines
  c4: { short: Rich; more: Rich[] }; // the evidence is panel.replay, or the line that says there is none
  c5: { h: string; short: Rich; change: PhoneChange | null; books: Rich; more: Rich[]; proof?: FixProof | null }; // proof: the evidence is its diff and verdict, the rest is in "More"; absent or null: the change is
  c6: { short: Rich; more: Rich[] };
  cert: { before: CertView; after: CertView };
}

// One line of the patch: a line of the bad deploy (ctx, del) or of the patched file (ctx, add). `cited`: the same text as a line the AI cited as the cause.
export interface FixDiffLine {
  kind: "ctx" | "add" | "del";
  text: string;
  cited: boolean;
}
// The proof behind a proposed patch, as a screen prints it. Every sentence is a fixed template with numbers; the only words that are not ours are the lines of
// the patch, shown as a labelled diff after every check and control passed.
export interface FixProof {
  proposed: string; // "Proposed by Claude"
  note: string; // "not deployed in this demo"
  lede: Rich; // what stands behind the patch, in one or two sentences
  hunks: FixDiffLine[][]; // the diff from the bad deploy to the patch; a gap between two hunks is a skip
  legend: string | null; // what the highlighted lines are; null when no line is
  verdict: Rich; // "Behaves like the shop's last good build and PayPal's answer on these 15 inputs."
  verdictNote: string; // the inputs behind it
  checks: { done: boolean; rich: Rich }[]; // the code checks
  controls: { done: boolean; rich: Rich; n: string }[]; // the replay controls, each with how many it ran on
  leftovers: Rich; // what the patch leaves behind, and what the checks cannot see
  baseline: Rich | null; // the same patch without its signature check fails the tampered control
  deployed: Rich; // what the demo really deployed
  basis: string; // when the controls ran and where the edits come from
}

export interface Story {
  id: string;
  label: string;
  date: string | null; // "Oct 19, 2026"
  kind: GapKind;
  bar: Rich; // the mode line: what kind of run, its date, and the honesty sentence
  // Chapter 1 is read in this order: h, lead, body (the first paragraph says what Doorbell is, the second tells the incident), found (what it
  // checked and what it found), pitch (the closing line: which order the chapters follow). The screen prints them in the order of this list.
  focal: { h: string; lead: Rich; body: Rich[]; found: Rich | null; pitch: Rich };
  travel: { h: string; body: Rich[] };
  why: { h: string; body: Rich[] };
  replay: { h: string; body: Rich[] };
  fix: { h: string; body: Rich[]; proof?: FixProof | null }; // proof: the patch Claude proposed and what stands behind it; absent or null: the chapter has none
  // hBefore: before the ring. hDuring: the focused row is tied and another row is still ringing. hAfter: the ring is over. noteDetail: the exact waits that
  // were shortened, as a second, quieter line under `note`.
  ring: { hBefore: string; hDuring: string; hAfter: string; body: Rich; note: string; noteDetail: string | null; result: string };
  cert: { before: CertView; after: CertView };
  captures: { before: CaptureRow[]; after: CaptureRow[] }; // the list under the story: while the gaps are open, and when the ring is over
  panel: Panel;
  phone: PhoneStory;
  certGreen: boolean; // the certificate at the end of the run says green: the only thing that lets green show on the page
}

// ---- small helpers ----------------------------------------------------------------------------------------------------------------------

const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
const plural = (n: number, one: string, many = `${one}s`): string => (n === 1 ? one : many);
const lower = (s: string): string => s.charAt(0).toLowerCase() + s.slice(1);
const NUMBER_WORD = ["no", "one", "two", "three", "four", "five", "six"];
const numberWord = (n: number): string => NUMBER_WORD[n] ?? String(n);

const stateWord = (s: string | null | undefined): string => (s === "paid" ? "Paid" : s === "refunded" ? "Refunded" : "");
const booksOf = (row: Pick<ScanRow, "book">): string => (row.book ? `${stateWord(row.book.state)} ${money(row.book.amount)}` : "no entry");
const shortItem = (name: string): string => lower(name.split(":")[0]);
const statusWord = (status: number): string => (status === 200 ? "200 OK" : String(status));
const arrivedAt = (a: AttemptReport): number | null => a.receivedAt ?? a.respondedAt ?? null;
const tidy = (s: string): string => s.replace(/\s+/g, " ").trim();
const baseName = (path: string): string => path.slice(path.lastIndexOf("/") + 1);

export function gapKindOf(f: ScanEvent["finding"]): GapKind {
  if (!f) return "other";
  if (f.cls === "HANDLER_REJECTING") return "rejected";
  if (f.cls === "ACKED_BUT_NOT_APPLIED") return f.flag === "OUT_OF_ORDER" ? "late" : "ack";
  return "other";
}

// ---- which event the path follows --------------------------------------------------------------------------------------------------------

export interface Focus {
  row: ScanRow;
  ev: ScanEvent;
  kind: GapKind;
  cause: GapCause | null;
}

// The first event the books are waiting for: a gap first, then a row that is not provable yet, then a healed one (a snapshot taken after the ring).
export function focusOf(snap: RunSnapshot): Focus | null {
  const rows = snap.scan?.rows ?? [];
  const pick = (want: (r: ScanRow, e: ScanEvent) => boolean): { row: ScanRow; ev: ScanEvent } | null => {
    for (const row of rows) {
      const ev = row.events.find((e) => want(row, e));
      if (ev) return { row, ev };
    }
    return null;
  };
  const hit = pick((r, e) => r.status !== "TIED" && !!e.finding?.final) ?? pick((r, e) => r.status !== "TIED" && !!e.finding) ?? pick((r, e) => r.status === "TIED" && healArrived(e.heal));
  if (!hit) return null;
  return { ...hit, kind: gapKindOf(hit.ev.finding), cause: snap.causes.find((c) => c.captureId === hit.row.captureId) ?? null };
}

// ---- the facts of the focused event --------------------------------------------------------------------------------------------------------

interface Arrival {
  at: number;
  answeredAt: number | null;
  status: number | null;
  word: string; // "answered **200 OK**" | "never answered" | "still working"
  eventWord: "refund" | "payment";
  late: boolean; // a payment that reached the shop after the refund did
}

interface Facts {
  row: ScanRow;
  ev: ScanEvent;
  kind: GapKind;
  eventWord: "refund" | "payment";
  amount: string; // "$48.00"
  paypal: string; // "Refunded $48.00"
  books: string; // "Paid $48.00" | "no entry"
  truthWord: string; // "refunded"
  booksWord: string; // "paid"
  hopSec: number | null; // PayPal made the event -> Doorbell heard it
  heardAt: number | null;
  createdAt: number | null;
  firstAt: number | null; // the first try of the focused event at the shop
  answerMs: number | null;
  arrivals: Arrival[]; // every delivery of this order's events, in the order they reached the shop
  tries: Arrival[]; // the attempts of the focused event, in order
  gaveUp: boolean; // PayPal's own retries are over: the Sandbox stops after SANDBOX_ATTEMPTS tries
  overwroteAt: number | null;
  scanAt: number | null;
  redelivered: boolean; // the payment event was delivered before the refund AND again after it (the second delivery is the late payment)
  listRead: boolean; // the scan read PayPal's events list
  setting: boolean; // the shop was broken by a wrong setting, not by its code (types.ts SettingMode): the fix is the setting, and no code line is blamed
}

function arrivalOf(a: AttemptReport, eventWord: "refund" | "payment", afterRefund: boolean): Arrival {
  const status = a.state === "responded" && a.status !== undefined ? a.status : null;
  return {
    at: arrivedAt(a) ?? 0,
    answeredAt: a.respondedAt ?? null,
    status,
    word: status !== null ? `answered **${statusWord(status)}**` : a.state === "crashed" ? "never answered" : "still working",
    eventWord,
    late: eventWord === "payment" && afterRefund,
  };
}

function factsOf(snap: RunSnapshot, f: Focus): Facts {
  const { row, ev } = f;
  const eventWord = ev.kind === "refunded" ? "refund" : "payment";
  const ordered = [...(ev.s ?? [])].sort((a, b) => (arrivedAt(a) ?? 0) - (arrivedAt(b) ?? 0));
  const tries = ordered.map((a) => arrivalOf(a, eventWord, false));
  const firstTry = ordered[0];

  const refundTimes = row.events.filter((e) => e.kind === "refunded").flatMap((e) => (e.s ?? []).map(arrivedAt)).filter((t): t is number => t !== null);
  const refundFirst = refundTimes.length > 0 ? Math.min(...refundTimes) : null;
  const arrivals = row.events
    .flatMap((e) => (e.s ?? []).map((a) => arrivalOf(a, e.kind === "refunded" ? "refund" : "payment", refundFirst !== null && (arrivedAt(a) ?? 0) > refundFirst)))
    .sort((a, b) => a.at - b.at);

  const groups = new Map<string, AttemptReport[]>();
  for (const a of ev.s ?? []) groups.set(a.tid, [...(groups.get(a.tid) ?? []), a]);
  const gaveUp = [...groups.values()].some((g) => !g.some(is2xx) && g.length >= SANDBOX_ATTEMPTS);

  const payTimes = row.events.filter((e) => e.kind !== "refunded").flatMap((e) => (e.s ?? []).map(arrivedAt)).filter((t): t is number => t !== null);
  const redelivered = refundFirst !== null && payTimes.some((t) => t < refundFirst) && payTimes.some((t) => t > refundFirst);
  const created = ev.listedAt ?? null;
  const heard = ev.d?.at ?? null;
  const hop = created !== null && heard !== null && heard >= created ? Math.round((heard - created) / 1000) : null;
  const firstAt = firstTry ? arrivedAt(firstTry) : null;
  return {
    row,
    ev,
    kind: f.kind,
    eventWord,
    amount: money(row.amount),
    paypal: row.truth ? `${stateWord(row.truth)} ${money(row.amount)}` : "no answer",
    books: booksOf(row),
    truthWord: row.truth ?? "paid",
    booksWord: row.book?.state ?? "unchanged",
    hopSec: hop !== null && hop >= 1 && hop < 180 ? hop : null,
    heardAt: heard,
    createdAt: created,
    firstAt,
    answerMs: firstTry && firstAt !== null && firstTry.respondedAt !== undefined ? firstTry.respondedAt - firstAt : null,
    arrivals,
    tries,
    gaveUp,
    overwroteAt: ev.finding?.flag === "OUT_OF_ORDER" ? (row.book?.at ?? null) : null,
    scanAt: snap.scan?.at ?? null,
    redelivered,
    listRead: snap.scan?.listing?.read === true,
    setting: isSettingBug(snap.session.session.mode),
  };
}

// ---- layers: tiny constructors -------------------------------------------------------------------------------------------------------------

const line = (kind: Line["kind"], markup: string): Line => ({ kind, rich: plainRich(markup) });
const layer = (on: string[], ...lines: Line[]): Layer => ({ on, variants: [{ on: [], lines }] });
const stack = (on: string[], variants: Variant[]): Layer => ({ on, variants });
const RING_ON = ["6:ask", "6:sent", "6:arrived", "6:saved", "6:lost"];

// ---- the stations ---------------------------------------------------------------------------------------------------------------------------

function shopArrivalLines(x: Facts): { lines: Line[]; hop: string } {
  if (x.kind === "late") {
    const lines = x.arrivals.map((a) => line("text", `${a.late ? "Late payment" : cap(a.eventWord)} at ${utcTimeMs(a.at)}, ${a.word}`));
    if (x.overwroteAt !== null) lines.push(line("sub", `The books were last written at ${utcTimeMs(x.overwroteAt)}, with paid`));
    return { lines, hop: "The late payment overwrote the refund" };
  }
  if (x.kind === "rejected" || x.tries.length > 1) {
    const first = x.tries[0]?.at ?? 0;
    const lines = x.tries.map((a, i) => line("text", `Try ${i + 1} at ${i === 0 ? "0 s" : `+${Math.round((a.at - first) / 1000)} s`}, ${a.word}`));
    if (x.gaveUp) lines.push(line("sub", `Then PayPal gave up: the Sandbox stops after ${SANDBOX_ATTEMPTS} tries`));
    return { lines, hop: "Nothing was saved after that" };
  }
  const t = x.tries[0];
  if (!t) return { lines: [line("text", "No record of it at your shop")], hop: "" };
  const lines = [line("text", `Received it and ${t.word}`)];
  if (t.answeredAt !== null) lines.push(line("sub", `Answer sent at ${utcTimeMs(t.answeredAt)}${x.answerMs !== null ? `, ${x.answerMs} ms later` : ""}`));
  return { lines, hop: x.kind === "ack" ? "Nothing was saved after that" : "" };
}

// What the shop did the last time, said once more beside Ring again (before the new try arrives).
function lastTimeLine(x: Facts): string {
  if (x.kind === "rejected") return `Answered **${statusWord(x.tries[0]?.status ?? 401)}** ${numberWord(x.tries.length)} ${plural(x.tries.length, "time")} and saved nothing`;
  if (x.kind === "late") return "Answered **200 OK** last time; a late payment then wrote paid over the refund";
  if (x.kind === "ack") return "Answered **200 OK** last time and saved nothing";
  return x.tries.length > 0 ? "Answered last time and the books still differ" : "Has no record of it";
}

// Whether the focused event can be sent again, as ONE fact: PayPal lists the event (or not) and Ring again's own state. Both stations of the ring
// chapter read their line from it, so that PayPal can never say "does not list it" while Doorbell says "ready" (the live lane showed that once).
export interface RingStand {
  listed: boolean;
  ready: boolean; // listed, and nothing else holds Ring again back
  paypal: (eventWord: string) => string;
  doorbell: string;
  glance: string; // Doorbell's word on the strip
}

export function ringStandOf(ev: Pick<ScanEvent, "listed" | "ring">): RingStand {
  const listed = ev.listed;
  const state = ev.ring?.state ?? "ready";
  const ready = listed && state === "ready";
  const doorbell = !listed
    ? "Waiting for PayPal to list the event"
    : state === "retries_pending"
      ? "Waiting: PayPal is still retrying on its own"
      : state === "in_progress"
        ? "A resend is already on its way"
        : state === "cap_reached"
          ? "No resends left in this session"
          : state === "wait" || state === "cannot_heal"
            ? "Waiting until the gap can be proven"
            : "Ready to ask PayPal to send it again";
  const glance = !listed ? "Waiting" : state === "cap_reached" ? "None left" : ready ? "Ready" : "Waiting";
  const paypal = (w: string): string => (!listed ? `Does not list the ${w} event yet, so it cannot be sent again` : ready ? `Still lists the ${w} event, so it can be sent again` : `Lists the ${w} event`);
  return { listed, ready, paypal, doorbell, glance };
}

// A gap that closed with no ring (the live lane only): the row the path follows is TIED in the newest snapshot and no resend of ours was seen arriving (a resend
// that PayPal accepted and that never arrived did not close it; the certificate counts the row the same way). The ring chapter then says what the newest
// snapshot shows, never that a resend arrived and never "healed" (that is the ring's word). What closed the row is
// read from the row's own tries (lib/gaps/closure.ts); "after the fix" is said only when this lane remembers the fix and it came before that try.
export interface ClosedAlone {
  row: ScanRow; // the row in the newest snapshot
  scanAt: number | null;
  closure: Closure | null; // null: the row's tries do not show how it closed, and the chapter says only that the books match
  afterFix: boolean;
  asked: number; // the resends PayPal accepted for this row that were never seen arriving; 0: Doorbell sent nothing
}

export const closedByItself = (row: ScanRow | undefined): boolean => row !== undefined && row.status === "TIED" && healOf(row) === null;

function closedAloneOf(focus: Focus, i: PanelInput): ClosedAlone | null {
  if (i.mode !== "live" || !i.after) return null;
  const row = i.after.scan?.rows.find((r) => r.captureId === focus.row.captureId);
  if (!row || !closedByItself(row)) return null;
  const closure = closureOf(row);
  const asked = row.events.reduce((n, e) => n + (e.heal?.sends ?? 0), 0);
  return { row, scanAt: i.after.scan?.at ?? null, closure, afterFix: closure !== null && i.fixed !== null && i.fixed.session.now < closure.at, asked };
}

// What the four stations say beside Ring again when nothing was rung. Every phase says the same: there is no ring to play.
function closedAloneStations(c: ClosedAlone, [paypal, doorbell, shop, books]: Station[]): void {
  const settle = (st: Station, glance: string): void => {
    for (const p of PHASES) {
      st.marks[`6:${p}`] = "ok";
      st.glance[`6:${p}`] = glance;
    }
  };
  const ring = (st: Station, ...lines: Line[]): void => {
    st.layers = st.layers.map((l) => (l.on.includes("6") ? layer(["6"], ...lines) : l));
  };
  const z = c.closure;
  const later = c.afterFix ? " after the fix" : "";
  const matched = c.row.truth && c.row.book ? `${stateWord(c.row.truth)} ${money(c.row.book.amount)}` : null;

  ring(paypal, line("text", z === null ? (matched ? `Says **${matched}**, as the books now do` : "Its answer matches the books") : z.kind === "paypal_retry" ? `Its own retry delivered the event${later}` : `Delivered the event again${later}, not through Ring again`));
  settle(paypal, z === null ? "Matches" : z.kind === "paypal_retry" ? "Retried" : "Delivered");

  const none = z === null ? "Sent nothing: the books already match PayPal" : z.kind === "paypal_retry" ? "Sent nothing: PayPal's own retry got there first" : "Sent nothing: another delivery got there first";
  // a resend that PayPal accepted and that was never seen arriving: Doorbell did ask, so it does not say it sent nothing
  const asked = `PayPal accepted ${c.asked} ${plural(c.asked, "resend")}; ${c.asked === 1 ? "it was not" : "none were"} seen arriving`;
  ring(doorbell, line("text", c.asked > 0 ? asked : none), ...(c.scanAt !== null ? [line("sub", `Compared the books with PayPal at ${utcTime(c.scanAt)}: they match`)] : []));
  settle(doorbell, c.asked > 0 ? `Asked ${c.asked}` : "Sent none");

  if (z) {
    ring(shop, line("text", `Answered **${statusWord(z.status)}** to ${z.kind === "paypal_retry" ? "PayPal's own retry" : "a delivery nobody asked for"} at ${utcTimeMs(z.at)}`), line("sub", `Try ${z.tryNo} at +${z.sinceFirstSec} s`));
    settle(shop, statusWord(z.status));
  } else {
    ring(shop, line("text", c.asked > 0 ? "No resend was seen arriving" : "Was sent nothing by Doorbell"));
    settle(shop, "Matches");
  }

  ring(books, line("text", c.row.book ? `Now says **${booksOf(c.row)}**` : "Matches PayPal"));
  settle(books, c.row.truth ? cap(c.row.truth) : "Matches");
}

// What C2 compared the category with, in words that are true of every case in the symptom class. The class is about the shop's answers; the books
// are what made the row a gap, so a class never says what the books did (in "a late payment wins" the books DID change, and then were overwritten).
function symptomWords(sym: SymptomClass, x: Facts): string {
  if (sym === "all_401") return "the shop answered 401 on each try";
  if (sym === "2xx_but_books_unchanged") {
    const codes = [...new Set(x.tries.map((a) => a.status))];
    return `the shop answered ${codes.length === 1 && codes[0] !== null ? statusWord(codes[0]) : "2xx"}, but its books do not match PayPal`;
  }
  if (sym === "404_or_no_arrival") return "no delivery reached the shop's handler";
  return "what the shop answered";
}

// The second check of a cause whose category is OTHER_CODE_CHANGE: consistentWith() is true for it on every symptom, so the check has nothing to test.
const NO_CATEGORY_CHECK = "No named category, so the symptom cannot rule this line out";

// The held-out result, in the words the README uses: the sealed evaluation of 2026-10-26 (docs/planning/eval/SEAL.md, ledger row S1).
// A test pins these two numbers to eval/runs/sealed-ha/results+b2.json, so the screen cannot drift from the file.
export const HELD_OUT = { right: 34, cases: 35, date: "2026-10-26" } as const;
const HELD_OUT_LINE = `On a held-out set sealed before the run (${HELD_OUT.date}) it named the right category in ${HELD_OUT.right} of ${HELD_OUT.cases} cases; the README has the rest.`;

// The AI's receipt, one small line: the model from the config (never from what the model said), how much it chose, whether this page called it,
// and the held-out result.
function receiptOf(c: Extract<GapCause["cause"], { status: "proposed" }>, model: string | undefined): string {
  const n = c.lines.length;
  const did = `picked 1 of ${CATEGORIES.length} categories (${CATEGORY_NAME[c.category]}) and cited ${n} changed ${plural(n, "line")}`;
  const where = c.source === "recording" ? "The answer is a stored recording; this page makes no model call." : "The answer came from a live model call.";
  return `AI receipt: ${model ?? "the AI"} ${did}. ${where} ${HELD_OUT_LINE}`;
}

function codeOf(cause: GapCause | null, x: Facts, model: string | undefined): CodeBlock | null {
  if (!cause || cause.cause.status !== "proposed") return null;
  const c = cause.cause;
  const named = c.category !== "OTHER_CODE_CHANGE";
  return {
    caption: plainRich(`The AI proposed this change in **${escapeForDisplay(c.file)}**, ${PLANTED}`),
    lines: c.lines.map((l) => ({ no: l.no ?? null, file: escapeForDisplay(l.shownFile), kind: l.kind, text: l.shown })),
    checks: [
      { done: true, text: "The cited line is a changed code line" },
      named ? { done: true, text: `The category fits the symptom: ${symptomWords(symptomClassOf(x.ev.s), x)}` } : { done: false, text: NO_CATEGORY_CHECK },
    ],
    receipt: receiptOf(c, model),
  };
}

function whyLayer(cause: GapCause | null, x: Facts, model: string | undefined): Layer {
  const code = codeOf(cause, x, model);
  if (code) return { on: ["3"], variants: [{ on: [], lines: [] }], code };
  // the chapter's text gives the reason and says the gap stands without the AI; the station only names the state, so no sentence is said twice
  if (cause && cause.cause.status === "not_proven") return layer(["3"], line("text", "Cause not proven"), line("sub", "The gap still stands"));
  if (cause && cause.cause.status === "not_diagnosed") return layer(["3"], line("text", "Not diagnosed"), line("sub", "The gap still stands"));
  return layer(["3"], line("ghost", "No cause asked for yet"));
}

interface PlanCtx {
  stand: RingStand; // whether the event can be sent again, read once: PayPal's line and Doorbell's line of the ring chapter both come from it
  proven: boolean; // chapter 5 carries a proven fix: the demo's switch back to good.ts is then said as what it is, the last good build
  fixed: RunSnapshot | null;
  ring: RingRow | null; // the row the path follows
  closed: ClosedAlone | null; // the row closed with no ring: the ring chapter then says what the newest snapshot shows
  model: string | undefined; // the model id from the config, for the AI receipt (undefined: the receipt does not name it)
}

// What the shop answered, in about nine characters: "200 OK", "200, 200", "401 ×3". A quarter of a phone's width holds no more.
export function codesGlance(codes: (number | null)[]): string {
  const known = codes.filter((c): c is number => c !== null);
  if (known.length === 0) return "No answer";
  if (codes.length === 1) return statusWord(known[0]);
  const joined = codes.map((c) => c ?? "?").join(", ");
  if (joined.length <= 9) return joined;
  return codes.every((c) => c === codes[0]) ? `${codes[0] ?? "?"} ×${codes.length}` : joined;
}

function stationsOf(x: Facts, cause: GapCause | null, ctx: PlanCtx): Station[] {
  const ring = ctx.ring;
  const lastSend = ring && ring.sentAt.length > 0 ? ring.sentAt[ring.sentAt.length - 1] : null;
  const shopArr = shopArrivalLines(x);
  const fixedFile = ctx.fixed ? baseName(ctx.fixed.session.session.file) : null;
  const shopMark2: MarkKind = x.kind === "ack" || x.kind === "other" ? "ok" : "bad";
  const money$ = x.amount;

  // The strip's words (Station.glance): the answers at the shop (the refund and the late payment, for a late payment; every try, otherwise), the
  // fault in one word, and what the books say.
  const answered = x.kind === "late" ? x.arrivals.filter((a) => a.eventWord === x.eventWord || a.late) : x.tries;
  const answer = answered.length > 0 ? codesGlance(answered.map((a) => a.status)) : "No record";
  const fault = { ack: "Not saved", late: "Overwrote", rejected: "Rejected", other: "Differs" }[x.kind];
  const arrived = ring && ring.arrivalSeconds !== null ? `+${ring.arrivalSeconds} s` : ring && ring.answer !== null ? statusWord(ring.answer) : "Arrived";
  const truth = x.row.truth ? cap(x.row.truth) : "No answer";
  const booksNow = x.row.book ? stateWord(x.row.book.state) : "No entry";
  const created = x.createdAt !== null ? utcTime(x.createdAt) : null;
  const heard = x.heardAt !== null ? utcTime(x.heardAt) : "Not heard";

  // Wording rule: no glossary word that the left column has not explained yet (see the header).
  const paypal: Station = {
    key: "paypal",
    name: "PayPal",
    sub: null,
    times: x.createdAt !== null ? [{ on: ["2", "3"], text: utcTime(x.createdAt) }] : [],
    layers: [
      layer(["1"], line("text", x.eventWord === "refund" ? `Says the money went back: **${x.paypal}**` : `Says the customer paid: **${x.paypal}**`)),
      layer(["2"], line("text", `Announced the ${x.eventWord} of **${money$}**`), ...(x.ev.eid ? [line("id", x.ev.eid)] : [])),
      layer(["5"], line("text", `Still says **${x.paypal}**`)),
      stack(
        ["6"],
        [
          { on: ["6:idle", "6:ask"], lines: [line("text", ctx.stand.paypal(x.eventWord))] },
          { on: ["6:sent", "6:arrived", "6:saved", "6:lost"], lines: [line("text", "Sends the same event again")] },
        ],
      ),
    ],
    hop: x.hopSec !== null ? { on: ["2"], text: `About ${x.hopSec} s later` } : null,
    marks: { "1": "ok", "2": "ok", "3": "ok", "5": "ok", "6": "ok" },
    glance: { "1": truth, ...(created ? { "2": created, "3": created, "5": created } : {}), "6:idle": ctx.stand.listed ? "Listed" : "Not listed", "6:ask": ctx.stand.listed ? "Listed" : "Not listed", "6": "Sent again" },
    untraced: [],
  };

  const doorbell: Station = {
    key: "doorbell",
    name: "Doorbell",
    sub: null,
    times: [...(x.heardAt !== null ? [{ on: ["2", "3"], text: utcTime(x.heardAt) }] : []), ...(lastSend !== null ? [{ on: RING_ON, text: utcTimeTenth(lastSend) }] : [])],
    layers: [
      layer(["1"], line("ghost", "What it heard comes next")),
      layer(["2"], x.heardAt !== null ? line("text", `Heard the **${money$}** ${x.eventWord}. Checked that it is really from PayPal`) : line("text", "Did not hear it. That does not mean PayPal did not send it"), ...(x.scanAt !== null ? [line("sub", `Compared the books with PayPal at ${utcTime(x.scanAt)}`)] : [])),
      ...(ctx.fixed?.scan && ctx.fixed.scan.rows.some((r) => r.status !== "TIED") ? [layer(["5"], line("text", `Looked again at ${utcTime(ctx.fixed.scan.at)}: the books still differ from PayPal`))] : []),
      stack(
        ["6"],
        [
          { on: ["6:idle"], lines: [line("text", ctx.stand.doorbell)] },
          { on: RING_ON, lines: [line("text", "Asked PayPal to send the event again")] },
        ],
      ),
    ],
    hop: null,
    marks: { "1": "ghost", "2": x.heardAt !== null ? "ok" : "wait", "3": "ok", "5": "ok", "6": "ok", "6:idle": ctx.stand.ready ? "ok" : "wait" },
    glance: { "2": heard, "3": heard, "5": heard, "6:idle": ctx.stand.glance, "6": lastSend !== null ? utcTimeTenth(lastSend) : "Asked" },
    untraced: ["1"],
  };

  const arrive = ring && ring.arrivalSeconds !== null ? `, ${ring.arrivalSeconds} s after the ask,` : "";
  const shop: Station = {
    key: "shop",
    name: "Your shop",
    sub: SHOP_NAME,
    times: [...(x.firstAt !== null ? [{ on: ["2", "3"], text: utcTimeMs(x.firstAt) }] : []), ...(ring && ring.arrivedAt !== null ? [{ on: ["6:arrived", "6:saved"], text: utcTimeTenth(ring.arrivedAt) }] : [])],
    layers: [
      layer(["1"], line("ghost", "What your shop did comes next")),
      layer(["2"], ...shopArr.lines),
      whyLayer(cause, x, ctx.model),
      ...(fixedFile ? [layer(["5"], line("text", x.setting ? "Checks signatures against its own webhook ID again" : ctx.proven ? `Now runs **${fixedFile}**, the last good build` : `Now runs **${fixedFile}**, the fixed handler`))] : []),
      stack(
        ["6"],
        [
          { on: ["6:idle", "6:ask", "6:sent"], lines: [line("text", lastTimeLine(x))] },
          { on: ["6:arrived", "6:saved"], lines: [line("text", `Received it again${arrive} and answered **${ring && ring.answer !== null ? statusWord(ring.answer) : "OK"}**`)] },
          { on: ["6:lost"], lines: [line("text", `Nothing reached it within ${ring ? ring.windowSec : RESEND_WINDOW_S} s of the last ask`)] },
        ],
      ),
    ],
    hop: shopArr.hop ? { on: ["2"], text: shopArr.hop } : null,
    marks: { "1": "ghost", "2": shopMark2, "3": "bad", "5": "ok", "6:idle": "bad", "6:ask": "bad", "6:sent": "bad", "6:arrived": "ok", "6:saved": "ok", "6:lost": "bad" },
    glance: { "2": answer, "3": fault, ...(fixedFile ? { "5": ctx.proven ? "Good build" : "Fixed" } : {}), "6:idle": fault, "6:ask": "Waiting", "6:sent": "Waiting", "6:arrived": arrived, "6:saved": arrived, "6:lost": "Nothing came" },
    untraced: ["1"],
  };

  const booksHas = x.row.book ? `Still says **${x.books}**` : "Has **no entry** for it";
  const books: Station = {
    key: "books",
    name: "Your books",
    sub: null,
    times: [],
    layers: [
      layer(["1", "2", "3", "5"], line("text", booksHas)),
      stack(
        ["6"],
        [
          { on: ["6:idle", "6:ask", "6:sent", "6:arrived", "6:lost"], flip: "from", lines: [line("text", booksHas)] },
          { on: ["6:saved"], flip: "to", lines: [line("text", `Now says **${x.paypal}**`)] },
        ],
      ),
    ],
    hop: null,
    marks: { "1": "bad", "2": "bad", "3": "bad", "5": "bad", "6:idle": "bad", "6:ask": "bad", "6:sent": "bad", "6:arrived": "bad", "6:saved": "ok", "6:lost": "bad" },
    glance: { "1": booksNow, "2": booksNow, "3": booksNow, "5": booksNow, "6": booksNow, "6:saved": truth },
    untraced: [],
  };
  const out = [paypal, doorbell, shop, books];
  if (ctx.closed) closedAloneStations(ctx.closed, out);
  return out;
}

// Four ghost stations: a session with nothing to trace yet.
function ghostStations(): Station[] {
  const names: [StationKey, string, string | null][] = [
    ["paypal", "PayPal", null],
    ["doorbell", "Doorbell", null],
    ["shop", "Your shop", SHOP_NAME],
    ["books", "Your books", null],
  ];
  return names.map(([key, name, sub]) => ({ key, name, sub, times: [], layers: [layer(["1", "2", "3", "5", "6"], line("ghost", "Not traced yet"))], hop: null, marks: { "1": "ghost", "2": "ghost", "3": "ghost", "5": "ghost", "6": "ghost" }, glance: {}, untraced: [] }));
}

export function markOf(st: Station, ch: ChapterNo, phase: Phase): MarkKind {
  return st.marks[`${ch}:${phase}`] ?? st.marks[String(ch)] ?? "ok";
}

// ---- the replay -------------------------------------------------------------------------------------------------------------------------------

const kindOfType = (t: string): string => (t.endsWith(".COMPLETED") ? "payment" : t.endsWith(".REFUNDED") ? "refund" : "event");

function replayOf(cause: GapCause | null, x: Facts, badFile: string | null, goodFile: string): ReplayModel | null {
  if (!cause || cause.cause.status !== "proposed" || !cause.replay || cause.replay.basis === "none") return null;
  const r = cause.replay;
  const c = confirmationOf(cause.cause, r);
  const answers = (statuses: number[]): string[] => (statuses.length > 0 ? statuses.map((s) => `Answers **${statusWord(s)}**`) : ["Gave no answer"]);
  const books = (book: string | null): Rich => plainRich(book === null ? "Have **no entry**, nothing was booked" : `Say **${stateWord(book)} ${x.amount}**`);
  const n = r.events.types.length;
  return {
    title: n === 1 ? "The real signed event" : `The ${n} real signed events`,
    sub: n > 1 ? `Sent to both builds in the order they arrived: ${r.events.types.map(kindOfType).join(", ")}` : "Sent to both builds",
    ids: r.events.ids,
    good: { name: "Good build", file: baseName(goodFile), planted: false, statuses: r.good.statuses, answers: answers(r.good.statuses), books: books(r.good.book), booksShort: r.good.book === null ? "No entry" : stateWord(r.good.book), ok: r.good.book === x.truthWord },
    bad: { name: "Bad build", file: badFile ? baseName(badFile) : "", planted: true, statuses: r.bad.statuses, answers: answers(r.bad.statuses), books: books(r.bad.book), booksShort: r.bad.book === null ? "No entry" : stateWord(r.bad.book), ok: r.bad.book === x.truthWord },
    verdict: { text: `${c.confirmed ? "Confirmed by replay" : "Not confirmed"}${r.basis === "recorded" ? " · recorded" : ""}`, confirmed: c.confirmed, note: c.note ?? null },
    basis: r.basis === "recorded" ? `This is a recorded result (${utcDateTime(r.ranAt)})` : null,
  };
}

// ---- Ring again, from the heal data ----------------------------------------------------------------------------------------------------------

const rowKind = (r: ScanRow): RowKind => (r.status === "TIED" ? "tied" : r.status === "GAP" ? "gap" : "unverified");
// The heal record of a row. On a TIED row it counts only with the resend's arrival (healArrived): a resend that was asked for and never seen arriving did not
// close the row, and the certificate counts the row the same way.
export const healOf = (r: ScanRow): NonNullable<ScanEvent["heal"]> | null => r.events.map((e) => e.heal).find((h): h is NonNullable<ScanEvent["heal"]> => !!h && (r.status !== "TIED" || healArrived(h))) ?? null;
const healTitle = (h: NonNullable<ScanEvent["heal"]>, tied: boolean) => healWords({ state: h.state, sends: h.sends, ...(h.arrivalSeconds !== undefined ? { arrivalSeconds: h.arrivalSeconds } : {}), ...(h.answer !== undefined ? { answer: h.answer } : {}) }, tied);

function ringRows(fixedRows: ScanRow[], afterRows: ScanRow[]): RingRow[] {
  const planned: RingRow[] = [];
  for (const row of afterRows) {
    const heal = healOf(row);
    const was = fixedRows.find((r) => r.captureId === row.captureId);
    if (!heal || !heal.sentAt || heal.sentAt.length === 0 || (was && was.status === "TIED")) continue;
    const sent = heal.sentAt;
    const arrived = heal.arrivedAt ?? null;
    planned.push({
      n: row.n,
      sends: sent.length,
      waitsSec: sent.slice(1).map((t, i) => Math.round((t - sent[i]) / 1000)),
      offsetSec: 0,
      arrivalSeconds: heal.arrivalSeconds ?? (arrived !== null ? Math.round(((arrived - sent[sent.length - 1]) / 1000) * 10) / 10 : null),
      answer: heal.answer ?? null,
      sentAt: sent,
      arrivedAt: arrived,
      end: row.status === "TIED" ? "tied" : "open",
      endTitle: healTitle(heal, row.status === "TIED").title,
      windowSec: RESEND_WINDOW_S,
    });
  }
  const t0 = planned.length > 0 ? planned[0].sentAt[0] : 0;
  return planned.map((p) => ({ ...p, offsetSec: Math.max(0, Math.round((p.sentAt[0] - t0) / 1000)) }));
}

// The sentence under a row of the ledger once Ring again has run (and, live, while it runs).
function endNote(row: ScanRow): string | null {
  const heal = healOf(row);
  if (!heal) return null;
  if (row.status === "TIED") {
    const s = heal.arrivalSeconds;
    if (heal.sends > 1) return `Needed ${heal.sends} resends.${s !== undefined ? ` The last arrived ${s} s after it was accepted.` : ""}`;
    return s !== undefined ? `Arrived ${s} s after PayPal accepted the resend.` : "Arrived after the resend.";
  }
  const capped = row.events.map((e) => e.ring).find((r) => r?.state === "cap_reached")?.label ?? null;
  return `${healTitle(heal, false).title}.${capped ? ` ${capped}.` : ""}`;
}

function ledgerOf(start: RunSnapshot, end: RunSnapshot, ring: RingRow[]): LedgerRow[] {
  const sRows = start.scan?.rows ?? [];
  const eRows = end.scan?.rows ?? [];
  return end.session.orders.map((o) => {
    const s = sRows.find((r) => r.captureId === o.captureId);
    const e = eRows.find((r) => r.captureId === o.captureId);
    const orderBooks = o.book ? `${stateWord(o.book.state)} ${money(o.book.amount)}` : "no entry";
    return {
      n: o.n,
      captureId: o.captureId,
      item: o.itemName,
      amount: money(o.amount),
      paypal: stateWord((e ?? s)?.truth ?? (o.paypal === "REFUNDED" ? "refunded" : "paid")),
      start: { books: s ? booksOf(s) : e ? booksOf(e) : orderBooks, kind: s ? rowKind(s) : e ? rowKind(e) : "unverified" },
      end: { books: e ? booksOf(e) : orderBooks, kind: e ? rowKind(e) : "unverified", note: e ? endNote(e) : null },
      ring: ring.find((r) => r.n === o.n) ?? null,
    };
  });
}

// ---- the certificate ---------------------------------------------------------------------------------------------------------------------------

// What a run with a proven fix cannot prove about it, in the certificate's own list.
const FIX_CANNOT = "The proposed patch's comments and leftover code are not checked.";

// How the certificate says a row was closed by PayPal's own retry: the words are the header template's (lib/cert/templates.ts), with its number left off, so
// the clause in the header and the line in the limits are found by them and never typed again here.
const CLOSED_BY_RETRY = certHeader.bookedOnRetry(0).replace(/^0 /, "");
const isClosureLimit = (line: string): boolean => line.includes(CLOSED_BY_RETRY);

const sentences = (s: string): string[] => s.split(/(?<=\.)\s+/).map((x) => x.trim()).filter(Boolean);

export function certView(snap: RunSnapshot, diag: RunSnapshot, ran: boolean, plan: (s: string) => Rich): CertView | null {
  const c = snap.certificate;
  if (!c) return null;
  const n = c.numbers;
  const retried = n.closedByPaypalRetry !== undefined && n.closedByPaypalRetry > 0 ? n.closedByPaypalRetry : 0;
  // The header's clause about rows closed by PayPal's own retry is a sentence of its own in the lead (below), so it must not stand in for the stamp text here.
  const parts = c.header.replace(/\.$/, "").split(" · ").filter((p) => retried === 0 || !p.startsWith(certHeader.bookedOnRetry(retried)));
  const rest = parts.slice(1).join(", ");
  const cause = diag.causes.find((x) => x.cause.status === "proposed") ?? null;
  const proposed = cause && cause.cause.status === "proposed" ? cause.cause : null;
  const confirmed = !!cause && !!proposed && !!cause.replay && confirmationOf(proposed, cause.replay).confirmed;
  const fix = provenFixOf(cause);

  // The headline says what was found, not how much was looked at: "3 of 3 captures checked" over two red gaps reads as a pass. A run that found
  // nothing has nothing to lead with, and keeps the coverage as its headline. The money is the gaps that are still open.
  const found = n.gaps + n.healed;
  const moneyLine = n.gaps > 0 && n.moneyNotInBooks !== "0.00" ? `${cap(certHeader.money(n.moneyNotInBooks, n.refundsNotInBooks, n.gaps - n.refundsNotInBooks))}.` : null;
  // A dispute the books do not show is a gap with no refund or payment of its own: its money is the disputed amount, said in the template of the certificate's header.
  const disputeLine = n.disputes && n.disputes.notInBooks > 0 ? `${cap(certHeader.disputes(n.disputes.notInBooks, n.disputes.moneyNotInBooks))}.` : null;
  const focal = found > 0 ? `${certHeader.found(n.gaps, n.healed, n.rows)}.` : `${parts[0]}.`;
  const whatIsOff = moneyLine && disputeLine ? `${moneyLine} ${disputeLine}` : (disputeLine ?? moneyLine);
  const stated = found > 0 ? (whatIsOff ?? `${c.stampText}.`) : rest !== "" ? `${cap(rest)}.` : `${c.stampText}.`;
  const lead = retried > 0 ? `${stated} ${certHeader.bookedOnRetry(retried)}.` : stated;

  // The limits first, then the standing ones; the last of those says the certificate is not signed. What the checks of a proven fix cannot see stands
  // just before that last one: the list still opens with how far PayPal's own data reaches. The line about rows that PayPal's own retry closed follows
  // that first line.
  const standing = sentences(FOOTNOTE);
  const cannot = [...c.limits.filter((l) => !isClosureLimit(l)), ...standing.slice(0, -1), ...(fix ? [FIX_CANNOT] : []), ...standing.slice(-1)];
  cannot.splice(1, 0, ...c.limits.filter(isClosureLimit));
  const checks: CertView["checks"] = [{ done: true, rich: plainRich(`${n.checked === n.rows ? `Each of the ${n.rows} ${plural(n.rows, "capture")}` : `${n.checked} of the ${n.rows} captures`}, looked up again at PayPal and compared with the books.`) }];
  if (proposed && proposed.category === "OTHER_CODE_CHANGE") {
    // consistentWith() is true for this category on every symptom: that check cannot fail, so it is not shown as passed.
    checks.push({ done: true, rich: plainRich("The AI's cited line is a changed line.") });
    checks.push({ done: false, rich: plainRich("The AI named no category, so the symptom could not rule the line out.") });
  } else if (cause) {
    checks.push({ done: true, rich: plainRich("The AI's cited line is a changed line, and its category fits what the shop answered.") });
  }
  if (cause) checks.push({ done: confirmed, rich: plainRich(confirmed ? "A replay of the real signed events on both builds showed the difference the AI's category predicts." : "A replay of the real signed events did not confirm the cause.") });
  if (fix) checks.push({ done: true, rich: plainRich(`Claude's proposed patch passed ${fix.checks.length} code checks. Replayed on ${fix.inputs} signed events${fix.basis === "replayed" ? "" : " earlier"}, it behaved like the shop's last good build and PayPal's answer.`) });
  if (!ran) checks.push({ done: false, rich: plainRich("The resend has not run yet, so the gaps are still open.") });
  else if (n.gaps === 0 && n.unverified === 0) checks.push({ done: true, rich: plainRich(`After the resend, the books match PayPal for ${n.tied} of ${n.rows} captures.`) });
  else checks.push({ done: false, rich: plainRich(`After the resend, the books match PayPal for ${n.tied} of ${n.rows} captures. The rest stay open.`) });

  return { stamp: c.stamp, focal, lead, cannot: cannot.map((s) => plan(s)), checks };
}

// ---- the panel -------------------------------------------------------------------------------------------------------------------------------------

export interface PanelInput {
  before: RunSnapshot; // the incident: the gap, the cause and its replay
  fixed: RunSnapshot | null; // the fix is deployed, the gaps still there
  after: RunSnapshot | null; // the end of the run, after Ring again
  mode: Panel["mode"];
  model?: string; // the model id from the config (lib/core/llm.ts MODEL_ID), passed in by the server: this module is also bundled for the browser
}

// The event whose listing and Ring-again state the ring chapter speaks of. A recorded story speaks for the incident it recorded. A live session
// speaks for the newest snapshot, because PayPal's list gains the event minutes after the gap was found: the same event, read now.
function standEvent(focus: Focus, i: PanelInput): ScanEvent {
  if (i.mode !== "live" || !i.after) return focus.ev;
  const now = i.after.scan?.rows.find((r) => r.captureId === focus.row.captureId)?.events.find((e) => e.kind === focus.ev.kind);
  return now ?? focus.ev;
}

export function buildPanel(i: PanelInput): { panel: Panel; focus: Focus | null; facts: Facts | null; ring: RingRow[] } {
  const focus = focusOf(i.before) ?? (i.after ? focusOf(i.after) : null);
  const end = i.after ?? i.fixed ?? i.before;
  const start = i.fixed ?? i.before;
  // The ring rows come from the heal records of the last snapshot. A recorded run plays them; a live session only reads the numbers.
  const ring = i.after ? ringRows(start.scan?.rows ?? [], i.after.scan?.rows ?? []) : [];
  const facts = focus ? factsOf(i.before, focus) : null;
  const focusRing = focus ? (ring.find((r) => r.n === focus.row.n) ?? null) : null;
  const goodFile = i.fixed?.session.session.file ?? "handlers/good.ts";
  const badFile = focus?.cause && focus.cause.cause.status === "proposed" ? focus.cause.cause.file : i.before.session.session.planted ? i.before.session.session.file : null;
  const replay = focus && facts ? replayOf(focus.cause, facts, badFile, goodFile) : null;
  const proven = focus !== null && provenFixOf(focus.cause) !== null;
  const total = end.session.orders.reduce((sum, o) => sum + Math.round(Number(o.amount) * 100), 0);
  const panel: Panel = {
    subject: focus && facts ? { n: focus.row.n, label: `Order #${focus.row.n}, ${shortItem(focus.row.itemName)}`, amount: facts.amount, captureId: focus.row.captureId, eventWord: facts.eventWord } : null,
    stations: focus && facts ? stationsOf(facts, focus.cause, { stand: ringStandOf(standEvent(focus, i)), proven, fixed: i.fixed, ring: focusRing, closed: closedAloneOf(focus, i), model: i.model }) : ghostStations(),
    replay,
    ledger: ledgerOf(start, end, ring),
    money: `$${(total / 100).toFixed(2)}`,
    available: { 1: true, 2: !!facts, 3: !!focus && !!focus.cause, 4: !!replay, 5: !!i.fixed, 6: !!focus && (i.mode === "live" ? ring.length > 0 || !!i.fixed : ring.length > 0), 7: !!end.certificate },
    mode: i.mode,
    fixedFile: i.fixed ? i.fixed.session.session.file : null,
    badFile,
  };
  return { panel, focus, facts, ring };
}

// ---- the left column: copy ------------------------------------------------------------------------------------------------------------------------
// Each function returns text with **bold** and ==highlight== markers; buildStory plans the glossary words through them in reading order.

const CATEGORY_NAME: Record<Exclude<Category, "NOT_IN_DIFF">, string> = {
  RAW_BODY_ALTERED: "request body altered",
  WRONG_WEBHOOK_ID: "wrong webhook ID",
  WORK_AFTER_ACK: "work after acknowledgement",
  EVENT_TYPE_DROPPED: "event type dropped",
  APP_OR_ENV_MISMATCH: "app or environment mismatch",
  ENDPOINT_PATH_CHANGED: "endpoint path changed",
  OTHER_CODE_CHANGE: "other code change",
};

function headlineOf(x: Facts): string {
  const did = x.row.truth === "refunded" ? "refunded" : "took";
  return x.row.book ? `PayPal ${did} ${x.amount}. Your books still say ${x.booksWord}.` : `PayPal ${did} ${x.amount}. Your books have no entry for it.`;
}

function leadOf(x: Facts): string {
  if (x.kind === "ack") return "No error anywhere.";
  if (x.kind === "late") return "Nothing failed. A later message undid the refund.";
  if (x.kind === "rejected") return `Your shop turned the ${x.eventWord} message away ${numberWord(x.tries.length)} ${plural(x.tries.length, "time")}.`;
  return `${evidenceWords(x.ev.finding ?? { cls: "UNVERIFIED" }).title}.`;
}

function whatHappened(x: Facts): string[] {
  const order = `Order #${x.row.n} at ${SHOP_NAME}, a fictional coffee shop: a “${x.row.itemName}”.`;
  if (x.kind === "ack") return [`${order} The ${x.eventWord} went through at PayPal. The shop's own books never heard about it, so the order still reads as ${x.booksWord}. Nothing crashed and nothing logged an error, so nobody is looking.`];
  if (x.kind === "late") return [`${order} The ${x.eventWord} went through at PayPal and reached the shop. Then a payment message arrived after it and the shop wrote paid on top. Nothing crashed and nothing logged an error, so nobody is looking.`];
  if (x.kind === "rejected") return [`${order} The ${x.eventWord} went through at PayPal. PayPal kept telling the shop, and the shop kept saying no. The books never heard about it, so the order still reads as ${x.booksWord}.`];
  return [`${order} ${evidenceWords(x.ev.finding ?? { cls: "UNVERIFIED" }).explain}`];
}

// The kinds of the rows that are gaps in a snapshot, from the finding of each (an event whose finding is not final says nothing about the kind).
function gapKinds(snap: RunSnapshot): GapKind[] {
  return (snap.scan?.rows ?? []).filter((r) => r.status === "GAP").map((r) => gapKindOf(r.events.find((e) => e.finding?.final)?.finding ?? null));
}

// What the shop did, said only when it is true of every gap row; otherwise the sentence says no more than the numbers do.
const BECAUSE: Record<Exclude<GapKind, "other">, (n: number) => string> = {
  ack: (n) => `the shop answered 200 but did not save ${n === 1 ? "it" : "them"}`,
  late: (n) => `the shop answered 200 to ${n === 1 ? "it" : "each"}, then a late payment overwrote the books`,
  rejected: (n) => `the shop turned ${n === 1 ? "the message" : "the messages"} away`,
};

const ordinal = (n: number): string => `${n}${n % 100 >= 11 && n % 100 <= 13 ? "th" : (["th", "st", "nd", "rd"][n % 10] ?? "th")}`;

// An order that matched PayPal although its first delivery failed: PayPal's own retry reached the books (lib/gaps/closure.ts), told from the row's own
// tries. "Not a bug we planted" is said only when every failed try was a 5xx or a crash: none of the planted handlers answers one (they answer 401 or 200).
function retriedWords(n: number, z: Closure): string {
  const said = z.failed.map((code) => (code === null ? "no answer" : `a ${code}`));
  const got = said.length > 1 && said.every((w) => w === said[0]) ? `each got ${said[0]}` : `got ${said.length > 1 ? `${said.slice(0, -1).join(", ")} and ${said[said.length - 1]}` : said[0]}`;
  const first = said.length === 1 ? "first delivery" : `first ${numberWord(said.length)} deliveries`;
  const planted = z.failed.every((code) => code === null || code >= 500) ? " (not a bug we planted)" : "";
  const later = z.tryNo === 2 ? `PayPal retried ${z.sinceFirstSec} s later` : `PayPal's ${ordinal(z.tryNo)} try came ${z.sinceFirstSec} s after the first`;
  return `Order #${n} matches, but its ${first} ${got} from the shop${planted}; ${later} and the books took it.`;
}

// "Doorbell checked the shop's 3 captures: the payments PayPal took, one per order. 2 refunds ($96.00) are missing from your books: ..."
// Then, for each order the chapters do not follow whose books PayPal's own retry wrote after the shop did not take the first delivery, one sentence.
function foundOf(snap: RunSnapshot, followed: number): string | null {
  const retried = (snap.scan?.rows ?? []).flatMap((r) => {
    const z = r.n === followed ? null : closureOf(r);
    return z?.kind === "paypal_retry" ? [retriedWords(r.n, z)] : [];
  });
  const text = [gapsFoundOf(snap), ...retried].filter((t): t is string => t !== null);
  return text.length > 0 ? text.join(" ") : null;
}

function gapsFoundOf(snap: RunSnapshot): string | null {
  const c = snap.certificate;
  if (!c || c.numbers.gaps === 0) return null;
  const n = c.numbers;
  const refunds = n.refundsNotInBooks;
  const payments = n.gaps - refunds;
  const what = payments === 0 ? `${refunds} ${plural(refunds, "refund")}` : refunds === 0 ? `${payments} ${plural(payments, "payment")}` : `${refunds} ${plural(refunds, "refund")} and ${payments} ${plural(payments, "payment")}`;
  const amount = n.moneyNotInBooks !== "0.00" ? ` (${money(n.moneyNotInBooks)})` : "";
  const kinds = gapKinds(snap);
  const because = kinds.length > 0 && kinds.every((k) => k === kinds[0]) && kinds[0] !== "other" ? `: ${BECAUSE[kinds[0]](n.gaps)}` : "";
  return `Doorbell checked the shop's ${n.rows} ${plural(n.rows, "capture")}: the ${plural(n.rows, "payment")} PayPal took, one per order. ${what}${amount} ${n.gaps === 1 ? "is" : "are"} missing from your books${because}.`;
}

const orderList = (ns: number[]): string => (ns.length <= 1 ? `#${ns[0]}` : `${ns.slice(0, -1).map((n) => `#${n}`).join(", ")} and #${ns[ns.length - 1]}`);

// The last line of chapter 1: which order the chapters follow, and where the others come back.
function closingOf(x: Facts, others: number[]): string {
  const first = `The chapters below follow order #${x.row.n} from PayPal to your books.`;
  if (others.length === 0) return first;
  return `${first} The other ${others.length === 1 ? "gap, order" : "gaps, orders"} ${orderList(others)}, ${others.length === 1 ? "comes" : "come"} back in Ring again.`;
}

// `short` is the one sentence a phone prints under the headline, and `more` the rest of the chapter's text: the paragraphs of `body` with the
// part that went into `short` taken out (the same words, so nothing is cut). The highlighter stays in `short`.
function travelCopy(x: Facts): { h: string; body: string[]; short: string; more: string[] } {
  const made = `PayPal made the ${x.eventWord} event.`;
  const verify = "with PayPal's verify-webhook-signature call";
  const hop = x.hopSec !== null ? `About ${x.hopSec} seconds later Doorbell heard it and checked its signature ${verify}.` : x.heardAt !== null ? `Doorbell heard it and checked its signature ${verify}.` : "Doorbell did not hear it, and that does not mean PayPal did not send it.";
  const check = x.scanAt !== null ? ` Doorbell's check at ${utcTime(x.scanAt)} looked each capture up at PayPal${x.listRead ? ", read PayPal's events list," : ""} and found the gap.` : "";
  if (x.kind === "ack") {
    const got = `Your shop got the delivery and answered **200 OK**${x.answerMs !== null ? ` in ${x.answerMs} milliseconds` : ""}.`;
    const polite = "A 200 is the polite answer, “got it, thanks”";
    const then = `Then nothing: the books were never written.${check}`;
    return {
      h: "Each hop said OK. The books never changed.",
      body: [`${made} ${hop} ${got} ${polite}, and it tells PayPal to stop trying. So ==nobody tried again==.`, then],
      short: "A 200 tells PayPal to stop trying, so ==nobody tried again==.",
      more: [`${made} ${hop} ${got} ${polite}.`, then],
    };
  }
  if (x.kind === "late") {
    const refund = x.arrivals.find((a) => a.eventWord === "refund");
    const late = x.arrivals.find((a) => a.late);
    const again = x.redelivered ? ": the same payment, delivered a second time (PayPal does not promise the order of deliveries)" : "";
    const first = `${made} ${hop} Your shop got the delivery${refund ? ` at ${utcTimeMs(refund.at)}` : ""} and answered **200 OK**.`;
    const then = `Then a payment message arrived after it${late ? `, at ${utcTimeMs(late.at)}` : ""}${again}. The shop answered **200 OK** to that too.`;
    const undone = "The refund arrived, then the late payment overwrote it";
    const filed = "Doorbell files this as an out-of-order delivery.";
    return {
      h: "Both messages were answered OK. The refund did not last.",
      body: [first, `${then} ==${undone}==${x.overwroteAt !== null ? `: the books were last written at ${utcTimeMs(x.overwroteAt)}, with paid` : ""}. ${filed}${check}`],
      short: `==${undone}==.`,
      more: [first, `${then}${x.overwroteAt !== null ? ` The books were last written at ${utcTimeMs(x.overwroteAt)}, with paid.` : ""} ${filed}${check}`],
    };
  }
  if (x.kind === "rejected") {
    const first = x.tries[0]?.at ?? 0;
    const when = x.tries.map((a, i) => (i === 0 ? "0 s" : `+${Math.round((a.at - first) / 1000)} s`));
    const codes = [...new Set(x.tries.map((a) => a.status))];
    const code = codes.length === 1 && codes[0] !== null ? statusWord(codes[0]) : "an error";
    const got = `${made} ${hop} Your shop got the delivery ${numberWord(x.tries.length)} times, at ${when.slice(0, -1).join(", ")} and ${when[when.length - 1]}, and answered **${code}** each time.`;
    const gave = `After the last try ==PayPal gave up==: the Sandbox stops after ${SANDBOX_ATTEMPTS} tries.`;
    const nothing = `Nothing was ever saved.${check}`;
    return {
      h: `${cap(numberWord(x.tries.length))} tries, ${numberWord(x.tries.length)} ${plural(x.tries.length, "rejection")}.${x.gaveUp ? " PayPal then gave up." : ""}`,
      body: [got, `${x.gaveUp ? `${gave} ` : ""}${nothing}`],
      short: x.gaveUp ? gave : "Nothing was ever saved.",
      more: x.gaveUp ? [got, nothing] : [got, check.trim()].filter(Boolean),
    };
  }
  return { h: "The message reached the shop. The books still differ.", body: [`${made} ${hop}${check}`], short: made, more: [`${hop}${check}`] };
}

// The heading says in plain words what the cited line does, from the category's own template: the AI proposes it, so it says "can" where the
// category only says that the work can be lost.
function whyHeading(c: Extract<GapCause["cause"], { status: "proposed" }>, x: Facts): string {
  const n = c.lines.length;
  const allDel = c.lines.every((l) => l.kind === "del");
  switch (c.category) {
    case "WORK_AFTER_ACK":
      return `The handler says OK before it saves the ${x.eventWord}, so the save can be lost`;
    case "RAW_BODY_ALTERED":
      return "The handler reshapes the message before checking its signature, so the check fails";
    case "WRONG_WEBHOOK_ID":
      return "The handler checks the signature against the wrong webhook ID";
    case "EVENT_TYPE_DROPPED":
      return "The handler no longer takes this kind of event, so it never reaches the books";
    case "APP_OR_ENV_MISMATCH":
      return "Payments go to a different PayPal app than the one the webhook listens on";
    case "ENDPOINT_PATH_CHANGED":
      return "The address PayPal calls no longer reaches the handler";
    case "OTHER_CODE_CHANGE":
      return `The AI points at ${numberWord(n)} ${allDel ? "removed" : "changed"} ${plural(n, "line")}, but none of its categories fits`;
  }
}

// A cause that is not proven, or was not diagnosed, in the words of chapter 3. The live lane prints the same words beside the gap (null: the cause is proposed, or none was asked for).
export function unprovenWords(cause: GapCause | null): { h: string; reason: string } | null {
  if (!cause) return null;
  if (cause.cause.status === "not_proven") return { h: "The cause is not proven.", reason: NOT_PROVEN_PHRASE[cause.cause.reason] };
  if (cause.cause.status === "not_diagnosed") return { h: "No cause was diagnosed.", reason: NOT_DIAGNOSED_PHRASE[cause.cause.reason] };
  return null;
}

function whyCopy(cause: GapCause | null, x: Facts): { h: string; body: string[] } {
  if (cause && cause.cause.status === "proposed") {
    const c = cause.cause;
    const n = c.lines.length;
    const allDel = c.lines.every((l) => l.kind === "del");
    const gone = allDel ? ` ${n === 1 ? "It is a line" : "They are lines"} of the good build that this build does not have.` : "";
    if (c.category === "OTHER_CODE_CHANGE") {
      return {
        h: whyHeading(c, x),
        body: [
          `The AI read what changed in the shop's handler and pointed at ${numberWord(n)} ${plural(n, "line")}. In plain words: ${lower(CAUSE_TEMPLATE[c.category])}${gone}`,
          "The AI only proposes. Two checks run in plain code, with no model involved. One passes: the cited line is a changed line. The other asks whether the category fits the symptom, and with no named category it has nothing to test.",
        ],
      };
    }
    return {
      h: whyHeading(c, x),
      body: [
        `The AI read what changed in the shop's handler and proposed ${numberWord(n)} ${plural(n, "line")} as the cause. Its category is **${CATEGORY_NAME[c.category]}**. In plain words: ${lower(CAUSE_TEMPLATE[c.category])}${gone}`,
        "The AI only proposes. Two checks run in plain code, with no model involved, and both pass.",
      ],
    };
  }
  const standing = "The gap stands on its own: it does not depend on the AI. Nothing about its cause is claimed.";
  const unproven = unprovenWords(cause);
  if (unproven) return { h: unproven.h, body: [unproven.reason, standing] };
  return { h: "Nobody has looked at the code yet.", body: [`Doorbell compares the shop's handler with the good build once it finds a gap. ${evidenceWords(x.ev.finding ?? { cls: "UNVERIFIED" }).explain}`] };
}

const answersText = (statuses: number[]): string => statuses.join(", ");

function replayCopy(r: ReplayModel | null, x: Facts): { h: string; body: string[] } {
  if (!r) return { h: "There is no replay for this gap.", body: ["A replay needs a cause that Doorbell can check and real signed events to run it on. The gap does not depend on it."] };
  const same = r.good.statuses.join() === r.bad.statuses.join();
  const one = r.ids.length === 1;
  const h = !r.verdict.confirmed ? "Same input, two builds. The replay did not separate them." : same ? `Same ${one ? "message" : "messages"}, two builds. Only one saves ${one ? "it" : "them"}.` : `Same ${one ? "message" : "messages"}, two builds. Only one accepts ${one ? "it" : "them"}.`;
  const what = one ? "the real signed event" : `the ${numberWord(r.ids.length)} real signed events`;
  const first = `To test it, Doorbell replays ${what} against the shop's good build and its bad build. ${
    same ? `Both answer ${answersText(r.good.statuses)}, so from the outside they look the same. ==Only the books differ.==` : `The good build answers ${answersText(r.good.statuses)}. The bad build answers ${answersText(r.bad.statuses)}. ==The books show the difference.==`
  }`;
  // A tested result, not a proof: it holds for the whole change between the two builds, not for the one line the AI cited.
  const second = r.verdict.confirmed ? `On the same events, the good build books the ${x.eventWord} and the bad build does not. That is a tested result for the whole change, not a proof about any one line.` : (r.verdict.note ?? "The cause stays a guess.");
  return { h, body: [first, second] };
}

function fixCopy(x: Facts, panel: Panel, fixed: RunSnapshot | null, proven: boolean): { h: string; body: string[] } {
  if (!fixed) return { h: "The fix is not deployed yet.", body: ["Once the handler is fixed, the gaps stay until PayPal sends the messages again."] };
  const bad = panel.badFile ? baseName(panel.badFile) : null;
  const gaps = fixed.certificate?.numbers.gaps ?? 0;
  // The setting bug: the code was never the problem, so there is no "instead of <file>". Doorbell did not find this; the sentence says who planted it.
  const first = x.setting
    ? `The shop's developer puts the shop's own webhook ID back. The setting had held the ID of another webhook on the same PayPal app. That wrong ID was ${PLANTED}, and Doorbell did not find it. The shop now checks PayPal's signatures against its own webhook ID again. A ${x.eventWord} that arrives from now on is booked.`
    : `The shop's developer deploys the ${proven ? "last good build" : "fixed handler"}. The shop now runs **${baseName(fixed.session.session.file)}**${bad ? ` instead of **${bad}**, ${PLANTED}` : ""}. A ${x.eventWord} that arrives from now on is booked.`;
  const why =
    x.kind === "ack"
      ? `But the ${x.eventWord} that already came is not booked: PayPal got its 200 and stopped trying.`
      : x.kind === "late"
        ? "But the late payment already overwrote the refund, and PayPal got a 200 for both messages, so it will not send them again by itself."
        : x.kind === "rejected"
          ? `But PayPal ${x.gaveUp ? "gave up after its last try" : "will not send these messages again by itself"}.`
          : `But the ${x.eventWord} that already came is not in the books.`;
  const looked = fixed.scan && gaps > 0 ? `Doorbell looked again at ${utcTime(fixed.scan.at)}: the books still differ from PayPal on ${numberWord(gaps)} ${plural(gaps, "capture")}.` : "";
  return { h: `Fixing the ${x.setting ? "setting" : "code"} does not rewrite the books. Only another delivery of the same event can.`, body: [first, why, ...(looked ? [looked] : [])] };
}

// ---- the proof of the proposed fix ---------------------------------------------------------------------------------------------------------------

// The recorded fix of the cause on screen, when the screen may show it: the cause is proposed and the replay confirmed it (the test the replay's own verdict
// uses), and the fix answers this cause, was proven and carries its patch. Anything else tells chapter 5 without it.
export function provenFixOf(cause: GapCause | null): FixResult | null {
  if (!cause || cause.cause.status !== "proposed" || !cause.replay || cause.replay.basis === "none") return null;
  if (!confirmationOf(cause.cause, cause.replay).confirmed) return null;
  const f = cause.fix;
  return f && f.verdict === "proven" && f.patch && f.baseline && f.causeRequestHash === cause.cause.requestHash ? f : null;
}

// The live lane's proof block: the same FixProof the recorded story prints in chapter 5, with the same words. It is shown once the working handler is on,
// because the proof says what the demo runs ("it runs good.ts, the shop's last good build"), and that is true only then.
export function liveFixProof(diag: RunSnapshot | null, fixed: RunSnapshot | null, rich: (s: string) => Rich): FixProof | null {
  if (!diag || !fixed) return null;
  const cause = focusOf(diag)?.cause ?? null;
  const proven = provenFixOf(cause);
  return cause && proven ? fixProofOf(cause, proven, baseName(fixed.session.session.file), rich) : null;
}

const countOf = (id: FixResult["controls"][number]["id"], n: number): string => (id === "paypal_books" ? `${n} ${plural(n, "comparison")}` : `${n} ${plural(n, "delivery", "deliveries")}`);

// "The same patch with its signature check removed (written by us) fails the tampered control and passes the other three."
function baselineLine(f: FixResult): string | null {
  if (!f.baseline) return null;
  const failed = f.baseline.controls.filter((c) => !c.ok).map((c) => CONTROL_NAME[c.id]);
  if (failed.length === 0) return null;
  const others = f.baseline.controls.length - failed.length;
  return `${f.baseline.label} fails the ${failed.join(" and ")} ${plural(failed.length, "control")}${others > 0 ? ` and passes the other ${numberWord(others)}` : ""}.`;
}

// What "these N inputs" are: the deliveries of the run's orders, each set of them sent three ways.
function verdictNote(f: FixResult): string {
  const ways = "run three ways: in arrival order, reversed, and with one amount changed.";
  const per = f.controls.find((c) => c.id === "arrival_order")?.n ?? 0;
  return per * 3 === f.inputs ? `The ${f.inputs} inputs are ${per} deliveries from ${f.orders} ${plural(f.orders, "order")}, ${ways}` : `${cap(numberWord(f.orders))} ${plural(f.orders, "order")}, ${ways}`;
}

// The patch with the proof around it. `rich` plans the glossary words in the order the caller reads the text. A line is `cited` when its text is a line the
// AI cited: a line the patch removes that the deploy had added, or a line the patch puts back that the deploy had removed.
function fixProofOf(cause: GapCause, f: FixResult, goodFile: string, rich: (s: string) => Rich): FixProof {
  const lines = cause.cause.status === "proposed" ? cause.cause.lines : [];
  const textsOf = (kind: "add" | "del"): Set<string> => new Set(lines.filter((l) => l.kind === kind && l.text.trim() !== "").map((l) => l.text.trim()));
  const citedAdded = textsOf("add");
  const citedRemoved = textsOf("del");
  let marked = 0;
  const hunks = f.patch!.hunks.map((h) =>
    h.map((l): FixDiffLine => {
      const cited = l.kind === "del" ? citedAdded.has(l.text.trim()) : l.kind === "add" ? citedRemoved.has(l.text.trim()) : false;
      if (cited) marked++;
      return { kind: l.kind, text: escapeForDisplay(l.text), cited };
    }),
  );
  const when = f.basis === "replayed" ? `The comparison ran at ${utcTime(f.ranAt)} UTC, on this run's own signed events.` : `This is a recorded result: the comparison ran on ${utcDateTime(f.ranAt)}, on earlier signed events.`;
  const baseline = baselineLine(f);
  return {
    proposed: "Proposed by Claude",
    note: "not deployed in this demo",
    lede: rich("Claude also proposed a patch for the cited lines. Plain code checked it first. Then it was run on real signed events and compared with the shop's last good build and with PayPal's own answer."),
    hunks,
    legend: marked > 0 ? `Highlighted: ${marked === 1 ? "the line" : "the lines"} the AI cited as the cause.` : null,
    verdict: rich(`Behaves like the shop's last good build and PayPal's answer on these ${f.inputs} inputs.`),
    verdictNote: verdictNote(f),
    checks: f.checks.map((c) => ({ done: c.ok, rich: rich(c.label) })),
    controls: f.controls.map((c) => ({ done: c.ok, rich: rich(c.label), n: countOf(c.id, c.n) })),
    leftovers: rich(`${f.leftovers !== undefined ? `${leftoversLine(f.leftovers)} ` : ""}${CANNOT_SEE}`),
    baseline: baseline ? rich(baseline) : null,
    deployed: rich(`The demo does not run this patch. It runs ${goodFile}, the shop's last good build, which the patch matches on these ${f.inputs} inputs.`),
    basis: `${when} The edits are a stored recording from ${escapeForDisplay(f.model)}; this page makes no model call.`,
  };
}

const STILL = (ns: number[], word: string): string => `${ns.length === 1 ? "Order" : "Orders"} ${orderList(ns)} ${ns.length === 1 ? "is" : "are"} still ${word}.`;

function ringCopy(x: Facts, ring: RingRow[], day: string | null): { hBefore: string; hDuring: string; hAfter: string; body: string; note: string; noteDetail: string | null; result: string } {
  const focal = ring.find((r) => r.n === x.row.n);
  // Not the first headline's words again: that one says what the books say, this one says what the chapter does.
  const hBefore = "Ask PayPal to send it again.";
  const rows = ring.length > 0 ? ring.map((r) => `order #${r.n}`).join(", then ") : `order #${x.row.n}`;
  const body = `Doorbell can ask PayPal's resend call to send the same event again, but only while the event is in PayPal's events list. Then it checks that the event arrived and that the books now match PayPal. Ring again rings each open gap: ${rows}.`;

  const shortened: string[] = [];
  for (const r of ring) {
    const waits = r.waitsSec.filter((w) => w > 5);
    if (waits.length > 0) shortened.push(`order #${r.n}'s ${waits.map((w) => `${w} s`).join(" and ")} between resends`);
    if (r.offsetSec > 5) shortened.push(`the ${r.offsetSec} s before order #${r.n}'s first resend`);
    if (r.end === "open") shortened.push(`the ${r.windowSec} s Doorbell watches for order #${r.n}'s resend`);
  }
  const note = `A replay of the real resend${day ? ` from ${day}` : ""}${shortened.length > 0 ? ", sped up" : ""}. Nothing is sent to PayPal.`;
  const noteDetail = shortened.length > 0 ? `Each wait was cut to about a second: ${shortened.join(", ")}.` : null;

  const result = ring
    .map((r) => {
      if (r.end === "tied") {
        const arrive = r.arrivalSeconds !== null ? `${r.arrivalSeconds} s after PayPal accepted it` : "after the resend";
        return r.sends > 1 ? `Order #${r.n} needed ${r.sends} resends; the last arrived ${arrive}, and the books now say ${x.truthWord}.` : `Order #${r.n}: the resend arrived ${arrive}, your shop answered ${r.answer ?? 200}, and the books now say ${x.truthWord}.`;
      }
      return `Order #${r.n}: ${r.endTitle}. The gap stays open.`;
    })
    .join(" ");
  // The heading may only speak for the whole run when every rung row is tied. While the focused row is tied and another is still ringing it says so,
  // and when the ring is over without the whole run tied it names the row that changed and the rows still open.
  const open = ring.filter((r) => r.end !== "tied").map((r) => r.n);
  const others = ring.filter((r) => r.n !== x.row.n).map((r) => r.n);
  const hAfter = !focal ? hBefore : focal.end !== "tied" ? `Order #${focal.n} is still open.` : open.length === 0 ? `The books now say ${x.truthWord}.` : `Order #${focal.n} now says ${x.truthWord}. ${STILL(open, "open")}`;
  const hDuring = focal && focal.end === "tied" && others.length > 0 ? `Order #${focal.n} now says ${x.truthWord}. ${STILL(others, "ringing")}` : hAfter;
  return { hBefore, hDuring, hAfter, body, note, noteDetail, result };
}

// ---- the phone's copy: the sentence, the evidence and the "More" of each chapter ----------------------------------------------------------------------

const unmark = (s: string): string => s.replace(/==/g, "");
const sentenceList = (s: string): string[] => s.split(/(?<=[.!?])\s+/).map((t) => t.trim()).filter(Boolean);

// The timed rail of chapter 2: the same facts as the path panel's second chapter, one row each, time on the left. The dashed row is the last
// thing that happened; nothing followed it.
function timelineOf(x: Facts, rich: (s: string) => Rich): PhoneRow[] {
  const row = (t: string | null, text: string, o: { dashed?: boolean; mark?: MarkKind } = {}): PhoneRow => ({ t, x: rich(text), dashed: o.dashed ?? false, mark: o.mark ?? null });
  const rows: PhoneRow[] = [row(x.createdAt !== null ? utcTime(x.createdAt) : null, `PayPal created the ${x.eventWord} event`), x.heardAt !== null ? row(utcTime(x.heardAt), "Doorbell heard it, signature checked") : row(null, "Doorbell did not hear it", { dashed: true })];
  if (x.kind === "late") {
    for (const a of x.arrivals.filter((y) => y.eventWord === x.eventWord || y.late)) rows.push(row(utcTimeMs(a.at), `${a.late ? "The late payment" : `The ${a.eventWord}`} reached your shop, ${a.word}`));
    rows.push(row(x.overwroteAt !== null ? utcTimeMs(x.overwroteAt) : null, "**Books overwritten**, with paid", { mark: "bad" }));
    return rows;
  }
  if (x.kind === "rejected" || x.tries.length > 1) {
    const codes = [...new Set(x.tries.map((a) => a.status))];
    const code = codes.length === 1 && codes[0] !== null ? `**${statusWord(codes[0])}**` : "an error";
    rows.push(row(x.tries[0] ? utcTimeMs(x.tries[0].at) : null, `Your shop answered ${code} ${numberWord(x.tries.length)} times`, { dashed: !x.gaveUp }));
    if (x.gaveUp) rows.push(row(null, "PayPal gave up after the last try", { dashed: true }));
  } else {
    const t = x.tries[0];
    rows.push(t ? row(utcTimeMs(t.at), `Your shop ${t.word}${x.answerMs !== null ? `, ${x.answerMs} ms later` : ""}`, { dashed: true }) : row(null, "No record of it at your shop", { dashed: true }));
  }
  rows.push(row(x.scanAt !== null ? utcTime(x.scanAt) : null, "Doorbell's check: **books never changed**", { mark: "bad" }));
  return rows;
}

// A line of code on a phone's width: when it is long, the arguments of its call are elided ("await ctx.books.set(…);"); the whole line is in the cited change.
export const brief = (line: string): string => (line.length <= 36 ? line : line.replace(/\(.*\)/, "(…)"));

// The handler line the fix changed, as the cited change shows it: what the bad build has that the good one does not (added lines), and what the good
// build has that the bad one does not (removed lines). A setting has no file; the fix chapter says which setting.
function changeOf(x: Facts, panel: Panel): PhoneChange | null {
  if (x.setting) return { kind: "setting", before: "Held the ID of another webhook", now: "The shop's own webhook ID" };
  const code = panel.stations.find((st) => st.key === "shop")?.layers.find((l) => l.code)?.code;
  if (!code) return null;
  const texts = (kind: CodeLine["kind"]): string[] | null => {
    const t = code.lines.filter((l) => l.kind === kind).map((l) => brief(l.text.trim()));
    return t.length > 0 ? t : null;
  };
  const before = texts("add");
  const now = texts("del");
  return before || now ? { kind: "code", before, now } : null;
}

interface PhoneIn {
  x: Facts;
  panel: Panel;
  cause: GapCause | null;
  copy: { lead: string; what: string[]; found: string | null; closing: string; travel: ReturnType<typeof travelCopy>; why: { h: string; body: string[] }; replay: { h: string; body: string[] }; fix: { h: string; body: string[] }; ring: { body: string } };
  proof: ((rich: (s: string) => Rich) => FixProof) | null; // the proof of the proposed fix, planned with the phone's own reading order; null: chapter 5 has none
  certs: { before: () => CertView | null; after: () => CertView | null };
  rich: (s: string) => Rich; // plans the glossary words in the phone's reading order
}

// The sentence of chapter 6, 4 and 1 are the first sentence of the chapter's own paragraph; the rest of the paragraph is the "More".
function phoneOf(a: PhoneIn): PhoneStory {
  const { x, panel, cause, copy, rich } = a;
  const subject = panel.subject!;
  const books = x.row.book ? { word: stateWord(x.row.book.state), amount: money(x.row.book.amount) } : { word: "No entry", amount: null };
  const proposed = cause && cause.cause.status === "proposed" ? cause.cause : null;

  // chapter 3: the sentence says what the two checks did; the paragraph about the cited change is the "More" (and, for an unnamed category, the checks' paragraph)
  const whyShort = proposed ? (proposed.category === "OTHER_CODE_CHANGE" ? "The AI only proposes; of its two checks in plain code, one passes and one has nothing to test." : "The AI only proposes; two checks in plain code, with no model involved, both pass.") : copy.why.body[0];
  const whyMore = proposed ? (proposed.category === "OTHER_CODE_CHANGE" ? copy.why.body : copy.why.body.slice(0, 1)) : copy.why.body.slice(1);

  const replayFirst = sentenceList(copy.replay.body[0]);
  const fixFirst = sentenceList(copy.fix.h);
  const ringFirst = sentenceList(copy.ring.body);

  // Evaluated in the order the phone prints it (the sentence of a chapter comes before its evidence, the "More" after it).
  return {
    c1: {
      vs: [
        { who: "PayPal says", word: x.row.truth ? stateWord(x.row.truth) : "No answer", amount: x.amount, mark: "ink" },
        { who: "Your books say", word: books.word, amount: books.amount, mark: "bad" },
      ],
      caption: rich(`${subject.label}. ${copy.lead}`),
      beats: PITCH_BEATS.map((b, k) => rich(k === 0 ? `Doorbell ${b}` : b)),
      more: [PITCH_FIRST, ...copy.what, ...(copy.found ? [copy.found] : []), copy.closing].map(rich),
    },
    c2: { short: rich(copy.travel.short), rows: timelineOf(x, rich), more: copy.travel.more.map((p) => rich(unmark(p))) },
    c3: { short: rich(whyShort), more: whyMore.map(rich) },
    c4: { short: rich(replayFirst[0]), more: [replayFirst.slice(1).join(" "), ...copy.replay.body.slice(1)].filter(Boolean).map(rich) },
    c5: {
      h: fixFirst[0],
      short: rich(fixFirst.slice(1).join(" ")),
      change: a.proof ? null : changeOf(x, panel),
      books: plainRich(x.row.book ? `Books still say **${x.books}**` : "Books still have **no entry**"),
      more: copy.fix.body.map(rich),
      proof: a.proof ? a.proof(rich) : null, // planned after the paragraphs: on a phone the proof's details come after them in the "More"
    },
    c6: { short: rich(ringFirst[0]), more: [ringFirst.slice(1).join(" ")].filter(Boolean).map(rich) },
    cert: { before: a.certs.before() ?? a.certs.after()!, after: a.certs.after() ?? a.certs.before()! },
  };
}

// ---- the whole story ----------------------------------------------------------------------------------------------------------------------------------

export function captureRows(snap: RunSnapshot): CaptureRow[] {
  const rows = snap.scan?.rows ?? [];
  return snap.session.orders.map((o) => {
    const r = rows.find((x) => x.captureId === o.captureId);
    return {
      n: o.n,
      item: o.itemName,
      amount: money(o.amount),
      paypal: r ? stateWord(r.truth) || "No answer" : stateWord(o.paypal === "REFUNDED" ? "refunded" : "paid"),
      books: r ? booksOf(r) : o.book ? `${stateWord(o.book.state)} ${money(o.book.amount)}` : "no entry",
      result: !r ? "Not scanned" : r.status === "TIED" ? "Tied" : r.status === "GAP" ? "Gap" : "Not provable yet",
      kind: r ? rowKind(r) : "unverified",
    };
  });
}

// The line in the top bar: what kind of run this is, its date, and the honesty sentence. Its glossary word (Sandbox) is explained here, first.
export function modeLine(planner: TermPlanner | null, snap: Pick<RunSnapshot, "mode" | "recordedAt">): Rich {
  const head = snap.mode === "LIVE" ? "Live run" : `${snap.mode === "CASE FILE" ? "Case file" : "Recorded run"}${snap.recordedAt !== null ? ` · ${utcDay(snap.recordedAt)}` : ""}`;
  return planRich(planner, `${head} · ${HONESTY}`);
}

// A recorded scenario to its story: the incident (step 1), the fix (step 2) and the end of the run (the last step). The steps in between are the
// ring in progress; they are not read, because the ring is played from the heal data of the last step.
export function storyOfScenario(sc: RecordedScenario, label: string, opts: { model?: string } = {}): Story {
  if (sc.steps.length < 3) throw new Error(`recorded scenario "${sc.id}" has ${sc.steps.length} steps; the story needs the incident, the fix and the end`);
  return buildStory({ id: sc.id, label, before: sc.steps[0], fixed: sc.steps[1], after: sc.steps[sc.steps.length - 1], mode: "script", ...(opts.model ? { model: opts.model } : {}) });
}

export function buildStory(i: { id: string; label: string } & PanelInput): Story {
  const { panel, focus, facts, ring } = buildPanel(i);
  if (!focus || !facts || !focusOf(i.before)) throw new Error(`story "${i.id}": the first snapshot has no event that the books are waiting for`);
  const planner = new TermPlanner();
  const rich = (s: string): Rich => planRich(planner, tidy(s));
  const day = i.before.recordedAt !== null ? utcDay(i.before.recordedAt) : null;
  const end = i.after ?? i.fixed ?? i.before;

  const travel = travelCopy(facts);
  const why = whyCopy(focus.cause, facts);
  const replay = replayCopy(panel.replay, facts);
  const provenFix = provenFixOf(focus.cause);
  const fix = fixCopy(facts, panel, i.fixed, provenFix !== null);
  const goodName = i.fixed ? baseName(i.fixed.session.session.file) : "good.ts";
  const proofOf = provenFix && focus.cause ? (r: (s: string) => Rich): FixProof => fixProofOf(focus.cause!, provenFix, goodName, r) : null;
  const ringC = ringCopy(facts, ring, day);
  const found = foundOf(i.before, facts.row.n);
  const others = (i.before.scan?.rows ?? []).filter((r) => r.status === "GAP" && r.n !== facts.row.n).map((r) => r.n);

  // The phone's own planner: the bar is the one text both layouts print, so it takes its words first, as it does for the desktop's.
  const phonePlanner = new TermPlanner();
  const rich2 = (s: string): Rich => planRich(phonePlanner, tidy(s));
  modeLine(phonePlanner, i.before);

  // Planned in the order a reader meets the words: the bar, then each chapter top to bottom (object properties are evaluated in this order).
  const story: Story = {
    id: i.id,
    label: i.label,
    date: day,
    kind: facts.kind,
    bar: modeLine(planner, i.before),
    focal: { h: headlineOf(facts), lead: rich(leadOf(facts)), body: [PITCH_LOOKS, ...whatHappened(facts)].map(rich), found: found ? rich(found) : null, pitch: rich(closingOf(facts, others)) },
    travel: { h: travel.h, body: travel.body.map(rich) },
    why: { h: why.h, body: why.body.map(rich) },
    replay: { h: replay.h, body: replay.body.map(rich) },
    fix: { h: fix.h, body: fix.body.map(rich), proof: proofOf ? proofOf(rich) : null },
    ring: { hBefore: ringC.hBefore, hDuring: ringC.hDuring, hAfter: ringC.hAfter, body: rich(ringC.body), note: ringC.note, noteDetail: ringC.noteDetail, result: ringC.result },
    cert: { before: null as unknown as CertView, after: null as unknown as CertView },
    captures: { before: captureRows(i.fixed ?? i.before), after: captureRows(end) },
    panel,
    phone: null as unknown as PhoneStory,
    certGreen: end.certificate?.stamp === "green",
  };
  const ran = !!i.after && ring.length > 0;
  const before = certView(i.fixed ?? i.before, i.before, false, rich);
  const after = certView(end, i.before, ran, plainRichOf);
  story.cert = { before: (before ?? after)!, after: (after ?? before)! };
  story.phone = phoneOf({
    x: facts,
    panel,
    cause: focus.cause,
    copy: { lead: leadOf(facts), what: whatHappened(facts), found, closing: closingOf(facts, others), travel, why, replay, fix, ring: ringC },
    proof: proofOf,
    certs: { before: () => certView(i.fixed ?? i.before, i.before, false, rich2), after: () => certView(end, i.before, ran, plainRichOf) },
    rich: rich2,
  });
  return story;
}

const plainRichOf = (s: string): Rich => plainRich(s);
