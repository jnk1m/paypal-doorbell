// The fifth story: a dispute the shop never heard (Track UI-B). PayPal lists an open dispute on one order, the shop's books have none, and no webhook of
// this app subscribes to dispute events, so PayPal had nobody to send one to. The same seven chapters and the same `Story` shape as lib/ui/story.ts, built
// here so that story.ts stays about handlers that break: this run has no code change, no cause to ask an AI about, no replay, and no resend to make.
//
// What each chapter stands on (RecordedDisputeScenario.steps, the real run on the deployed shop):
//   1 before   three orders, all tied        (only the certificate's "tied" count is read from it)
//   2 listed   Doorbell's scan found the dispute 39 s after PayPal created it; the response-due date was not set yet
//   3 due      PayPal had set the response-due date; the capture showed PENDING. Chapters 1, 3, 5 and the certificate read this step
//   4 ring     Ring again was pressed: nothing was sent. The end of the run
// Every sentence is a fixed template with numbers, times and ids read from those steps; nothing PayPal wrote and no model text reaches a sentence. The
// words of the backend (the ring state's label, the certificate's limits) are used as they are, not paraphrased. A recorded run that is not the kind this
// story knows how to tell (a webhook that does subscribe, a ring that is ready, a second dispute) makes the builder throw instead of telling it wrongly.
//
// The live lane (lib/ui/live.ts) tells a dispute that a live scan found with the same panel and the same sentences (liveDisputePanel, liveDisputeRow, at the
// end of this file). It has one scan, not four steps, so it says only what that scan shows: no "N seconds later", no ring that was pressed, no chapter 5.
import { FOOTNOTE, header as certHeader } from "../cert/templates.ts";
import type { DisputeView, OpenStatus } from "../gaps/disputes.ts";
import type { ScanRow } from "../gaps/scan.ts";
import type { RecordedDisputeScenario, RunSnapshot } from "../run/snapshot.ts";
import { disputeTitle } from "../run/titles.ts";
import { PITCH_BEATS, PITCH_FIRST, PITCH_LOOKS, SHOP_NAME } from "./copy.ts";
import { money, utcDateTime, utcDay, utcTime } from "./format.ts";
import { TermPlanner } from "./glossary.ts";
import { WAITING_PHRASE } from "./phrases.ts";
import { plainRich, planRich, type Rich } from "./rich.ts";
import { modeLine, type CaptureRow, type CertView, type LedgerRow, type Line, type Layer, type MarkKind, type Panel, type PhoneRow, type Station, type Story, type Subject } from "./story.ts";

// ---- small helpers ----------------------------------------------------------------------------------------------------------------------

const plural = (n: number, one: string, many = `${one}s`): string => (n === 1 ? one : many);
const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
const lower = (s: string): string => s.charAt(0).toLowerCase() + s.slice(1);
const tidy = (s: string): string => s.replace(/\s+/g, " ").trim();
const unmark = (s: string): string => s.replace(/==/g, "");
const sentences = (s: string): string[] => s.split(/(?<=\.)\s+/).map((x) => x.trim()).filter(Boolean);
const sentenceList = (s: string): string[] => s.split(/(?<=[.!?])\s+/).map((t) => t.trim()).filter(Boolean);
const stateWord = (s: string | null | undefined): string => (s === "paid" ? "Paid" : s === "refunded" ? "Refunded" : "");
const line = (kind: Line["kind"], markup: string): Line => ({ kind, rich: plainRich(markup) });
const layer = (on: string[], ...lines: Line[]): Layer => ({ on, variants: [{ on: [], lines }] });

// What PayPal's four open dispute statuses are called here: a closed vocabulary, never PayPal's own text.
const STATUS_WORD: Record<OpenStatus, string> = {
  OPEN: "open",
  WAITING_FOR_BUYER_RESPONSE: "waiting for the buyer to respond",
  WAITING_FOR_SELLER_RESPONSE: "waiting for the shop to respond",
  UNDER_REVIEW: "under review",
};

// ---- the facts of the run -----------------------------------------------------------------------------------------------------------------

interface Facts {
  row: ScanRow; // the disputed capture, as the "due" step saw it
  dispute: DisputeView; // its dispute, as the "due" step saw it
  rows: number; // orders in the run
  n: number;
  item: string;
  amount: string; // "$48.00"
  label: string; // "Order #2, gift set"
  createdAt: number; // PayPal created the dispute
  listedAt: number; // Doorbell's scan that first found it
  lookedAt: number; // Doorbell's scan once the response-due date was there
  secondsToFind: number | null; // from PayPal creating the dispute to the scan that first found it; null when only one scan is known (the live lane)
  dueAt: number | null;
  status: string; // STATUS_WORD of the dispute at the "due" step
  pending: boolean; // the capture shows PENDING at PayPal at the "due" step
  resends: number; // resends the session had used when Ring again was pressed
  live: boolean; // told from one live scan: Ring again was not pressed (the lane has no button for a dispute), and there is no later look to tell
  ringLabel: string; // the backend's words for the ring state of this dispute
  noWebhookLimit: string; // the certificate's cannot-prove line about disputes
}

const fail = (id: string, why: string): never => {
  throw new Error(`dispute story "${id}": ${why}`);
};

function rowOf(snap: RunSnapshot, captureId: string): ScanRow | undefined {
  return snap.scan?.rows.find((r) => r.captureId === captureId);
}

// The one kind of dispute this story tells: open at PayPal, not in the books, and no webhook of the app subscribes to dispute events. Why a dispute is not
// that kind, or null when it is. The recorded run throws for any other kind; the live lane tells only this kind with these sentences.
function untellable(d: DisputeView): string | null {
  if (d.status !== "GAP" || d.finding?.flag !== "UNSUBSCRIBED_EVENT_TYPE" || d.finding.final !== true) return 'the dispute is not a final "never subscribed" gap';
  if (d.webhooks.shop !== false || d.webhooks.any !== false) return `a webhook of the app does subscribe (${JSON.stringify(d.webhooks)})`;
  if (!d.ring || d.ring.state !== "cannot_heal") return 'Ring again is not "cannot_heal" for this dispute';
  return null;
}

const NO_WEBHOOK_LIMIT = /no webhook of this app subscribes to dispute events/;

function factsOf(sc: RecordedDisputeScenario): Facts {
  const id = sc.id;
  if (sc.steps.length !== 4) fail(id, `the story needs the four recorded steps (before, listed, due, ring), the file has ${sc.steps.length}`);
  const [, listed, due, ring] = sc.steps;
  const target = ring.scan?.rows.find((r) => (r.disputes ?? []).length > 0);
  if (!target || target.disputes!.length !== 1) return fail(id, "the last step must hold exactly one disputed capture with exactly one dispute");
  const at = (snap: RunSnapshot, what: string): { row: ScanRow; d: DisputeView } => {
    const row = snap.scan ? rowOf(snap, target.captureId) : undefined;
    const d = row?.disputes?.[0];
    if (!row || !d || d.disputeId !== target.disputes![0].disputeId) return fail(id, `${what} does not hold the dispute of the last step`);
    const why = untellable(d);
    if (why !== null) return fail(id, `${what}: ${why}`);
    return { row, d };
  };
  at(listed, "the listed step");
  const { row, d } = at(due, "the due step");
  const last = at(ring, "the ring step");
  if (ring.scan!.resendsUsed !== 0) return fail(id, `Ring again used ${ring.scan!.resendsUsed} resends, and this story says nothing was sent`);
  if (due.scan!.disputeReads?.unreadable !== 0 || due.scan!.disputeReads?.asked !== due.scan!.rows.length) return fail(id, "PayPal's dispute list was not read for every order of the due step");
  const cert = due.certificate;
  const disputes = cert?.numbers.disputes;
  if (!cert || !disputes || disputes.open !== 1 || disputes.notInBooks !== 1) return fail(id, "the due step's certificate does not count exactly one dispute that the books do not show");
  const noWebhookLimit = cert.limits.find((l) => NO_WEBHOOK_LIMIT.test(l));
  if (!noWebhookLimit) return fail(id, "the certificate has no cannot-prove line about the dispute's webhook");
  return {
    row,
    dispute: d,
    rows: due.scan!.rows.length,
    n: row.n,
    item: row.itemName,
    amount: money(d.amount),
    label: `Order #${row.n}, ${lower(row.itemName.split(":")[0])}`,
    createdAt: d.createdAt,
    listedAt: listed.scan!.at,
    lookedAt: due.scan!.at,
    secondsToFind: Math.max(0, Math.round((listed.scan!.at - d.createdAt) / 1000)),
    dueAt: d.dueDateSource === "sandbox_test" ? d.sellerResponseDueAt : null,
    status: STATUS_WORD[d.paypalStatus],
    pending: row.paypalStatus === "PENDING",
    resends: ring.scan!.resendsUsed ?? 0,
    live: false,
    ringLabel: last.d.ring!.label,
    noWebhookLimit,
  };
}

// ---- the panel: PayPal, Doorbell, your shop, your books -------------------------------------------------------------------------------------

function stationsOf(x: Facts): Station[] {
  const created = utcTime(x.createdAt);
  const listed = utcTime(x.listedAt);
  const looked = utcTime(x.lookedAt);
  const due = x.dueAt !== null ? utcDateTime(x.dueAt) : null;

  const paypal: Station = {
    key: "paypal",
    name: "PayPal",
    sub: null,
    times: [{ on: ["2", "3"], text: created }],
    layers: [
      layer(["1"], line("text", `Says a **${x.amount}** dispute is open`), ...(due ? [line("sub", `Response due ${due}, set by our own Sandbox test call`)] : [])),
      layer(["2"], line("text", `Opened the **${x.amount}** dispute`), line("id", x.dispute.disputeId)),
      layer(["5"], line("text", `Still lists the **${x.amount}** dispute`)),
      layer(["6"], line("text", "Has no event to send again")),
    ],
    hop: x.secondsToFind !== null ? { on: ["2"], text: `About ${x.secondsToFind} s later, Doorbell asked` } : null,
    marks: { "1": "ok", "2": "ok", "3": "ok", "5": "ok", "6": "ok" },
    glance: { "1": "Dispute", "2": created, "3": created, "5": created, "6": "Nothing" },
    untraced: [],
  };

  const doorbell: Station = {
    key: "doorbell",
    name: "Doorbell",
    sub: null,
    times: [{ on: ["2", "3"], text: listed }],
    layers: [
      layer(["1"], line("ghost", "What it found comes next")),
      layer(["2"], line("text", `Read PayPal's Disputes API for each capture and found the **${x.amount}** dispute`), line("sub", `Compared the books with PayPal at ${listed}`)),
      layer(["5"], line("text", `Looked again at ${looked}: the books still show no dispute`)),
      layer(["6"], line("text", x.live ? "Cannot ring: it has no event to ask PayPal to send again" : "Pressed Ring again: it sent nothing")),
    ],
    hop: null,
    marks: { "1": "ghost", "2": "ok", "3": "ok", "5": "ok", "6": "ok" },
    glance: { "2": listed, "3": listed, "5": looked, "6": "None sent" },
    untraced: ["1"],
  };

  // The shop's mark is a cross in chapters 3, 5 and 6 because that is where the missing subscription is. It is a ghost in chapter 2: nothing arrived
  // there, so there is no answer of the shop's to judge.
  const shop: Station = {
    key: "shop",
    name: "Your shop",
    sub: SHOP_NAME,
    times: [],
    layers: [
      layer(["1"], line("ghost", "What your shop did comes next")),
      layer(["2"], line("text", "Heard nothing about the dispute"), line("sub", "No webhook asked for it")),
      { ...layer(["3"], line("text", "Its webhook does not subscribe to dispute events"), line("sub", "Neither does any other webhook of this app")), mark: "bad" },
      layer(["5"], line("text", "Its webhook still does not subscribe to dispute events")),
      layer(["6"], line("text", "Still heard nothing about the dispute")),
    ],
    hop: { on: ["2"], text: "So nothing was booked" },
    marks: { "1": "ghost", "2": "ghost", "3": "bad", "5": "bad", "6": "bad" },
    glance: { "2": "Nothing", "3": "Not told", "5": "Not told", "6": "Nothing" },
    untraced: ["1"],
  };

  const books: Station = {
    key: "books",
    name: "Your books",
    sub: null,
    times: [],
    layers: [layer(["1", "2", "3", "5", "6"], line("text", "Has **no dispute** on file"), line("sub", "The order itself is booked as paid"))],
    hop: null,
    marks: { "1": "bad", "2": "bad", "3": "bad", "5": "bad", "6": "bad" },
    glance: { "1": "No dispute", "2": "No dispute", "3": "No dispute", "5": "No dispute", "6": "No dispute" },
    untraced: [],
  };
  // A live scan has no chapter 5 (no handler was switched, and nothing looked again): its lines would say what no scan showed.
  const noFive = (st: Station): Station => ({ ...st, layers: st.layers.flatMap((l) => (l.on.includes("5") ? (l.on.length === 1 ? [] : [{ ...l, on: l.on.filter((t) => t !== "5") }]) : [l])) });
  return [paypal, doorbell, shop, books].map((st) => (x.live ? noFive(st) : st));
}

// The ledger says what a row of the run is. The disputed row is "a dispute is open" at PayPal and "no dispute" in the books; "no dispute" is the one
// books phrase of this story (app/_components/path-panel.tsx booksPhrase). Nothing is rung, so no row has a ring.
function ledgerOf(end: RunSnapshot, x: Facts): LedgerRow[] {
  return end.session.orders.map((o) => {
    const r = rowOf(end, o.captureId);
    const disputed = (r?.disputes ?? []).some((d) => d.status !== "TIED");
    const books = o.book ? `${stateWord(o.book.state)} ${money(o.book.amount)}` : "no entry";
    const kind = r ? (r.status === "TIED" ? ("tied" as const) : r.status === "GAP" ? ("gap" as const) : ("unverified" as const)) : ("unverified" as const);
    return {
      n: o.n,
      captureId: o.captureId,
      item: o.itemName,
      amount: money(o.amount),
      paypal: disputed ? "a dispute is open" : stateWord(r?.truth ?? "paid"),
      start: { books: disputed ? "no dispute" : books, kind },
      end: { books: disputed ? "no dispute" : books, kind, note: null },
      ring: null,
    };
  });
}

const totalOf = (snap: RunSnapshot): string => money((snap.session.orders.reduce((sum, o) => sum + Math.round(Number(o.amount) * 100), 0) / 100).toFixed(2));

function capturesOf(snap: RunSnapshot, x: Facts): CaptureRow[] {
  return snap.session.orders.map((o) => {
    const r = rowOf(snap, o.captureId);
    const disputed = o.captureId === x.row.captureId;
    const books = o.book ? `${stateWord(o.book.state)} ${money(o.book.amount)}` : "no entry";
    return {
      n: o.n,
      item: o.itemName,
      amount: money(o.amount),
      paypal: disputed ? `Dispute open${r?.paypalStatus === "PENDING" ? ", capture PENDING" : ""}` : stateWord(r?.truth ?? "paid") || "No answer",
      books: disputed ? `${books}, no dispute` : books,
      result: !r ? "Not scanned" : r.status === "TIED" ? "Tied" : r.status === "GAP" ? "Gap" : "Not provable yet",
      kind: !r ? "unverified" : r.status === "TIED" ? "tied" : r.status === "GAP" ? "gap" : "unverified",
    };
  });
}

// ---- the certificate ----------------------------------------------------------------------------------------------------------------------------

// The certificate of one step, read from its numbers: the headline and the lead are the templates of lib/cert, the cannot-prove lines are the step's
// own limits and then the standing footnote. It has no cause and no replay to report, so none of its lines mention either.
function certOf(snap: RunSnapshot, plan: (s: string) => Rich): CertView {
  const c = snap.certificate!;
  const n = c.numbers;
  const d = n.disputes!;
  const reads = snap.scan!.disputeReads!;
  const checks: CertView["checks"] = [
    { done: true, rich: plainRich(`Each of the ${n.rows} ${plural(n.rows, "capture")}, looked up again at PayPal and compared with the books.`) },
    { done: reads.unreadable === 0, rich: plainRich(`PayPal's list of disputes was read for ${reads.asked - reads.unreadable} of the ${reads.asked} ${plural(reads.asked, "capture")}.`) },
    { done: true, rich: plainRich("The webhooks of this app were read from PayPal: none of them subscribes to the dispute-created event.") },
    { done: false, rich: plainRich(`Ring again was pressed: nothing was sent, and the books still show ${d.notInBooks === 1 ? "no dispute" : "none of the disputes"}.`) },
  ];
  return {
    stamp: c.stamp,
    focal: `${certHeader.found(n.gaps, n.healed, n.rows)}.`,
    lead: `${cap(certHeader.disputes(d.notInBooks, d.moneyNotInBooks))}.`,
    cannot: [...c.limits, ...sentences(FOOTNOTE)].map(plan),
    checks,
  };
}

// ---- the story ----------------------------------------------------------------------------------------------------------------------------------

// The sentences that the recorded story and the live lane both say, once: what happened, how it travelled, why, that there is no replay, what the fix is.
export const DISPUTE_WORDS = {
  focal: (amount: string, n: number): string => `PayPal lists a ${amount} dispute on order #${n}. Your books have none.`,
  travel: "Nothing reached your shop. Doorbell found the dispute by asking PayPal.",
  why: "No webhook of this app asks for dispute events.",
  whyShort: "This is a fact of the setup, read from PayPal. No AI was asked, because there was no code change to read.",
  replay: "There is no replay for this gap.",
  fix: "The fix is a setting in PayPal, and it is the shop owner's to change.",
} as const;

export function disputeStoryOf(sc: RecordedDisputeScenario, label: string): Story {
  const x = factsOf(sc);
  const [first, , due, end] = sc.steps;
  const planner = new TermPlanner();
  const rich = (s: string): Rich => planRich(planner, tidy(s));
  const phonePlanner = new TermPlanner();
  const rich2 = (s: string): Rich => planRich(phonePlanner, tidy(s));
  modeLine(phonePlanner, first);

  const tCreated = utcTime(x.createdAt);
  const tListed = utcTime(x.listedAt);
  const tLooked = utcTime(x.lookedAt);

  // ---- the words of the chapters ----
  const lead = "Nothing broke. The shop was never going to be told.";
  const order = `Order #${x.n} at ${SHOP_NAME}, a fictional coffee shop: a “${x.item}”.`;
  const dueSentence = x.dueAt !== null ? `, with a response-due date of ${utcDateTime(x.dueAt)}. That date was set by our own Sandbox test call, not by PayPal's rules` : "";
  const what = `${order} A Sandbox test call of ours opened a ${x.amount} dispute on it, standing in for a customer who asks their bank for the money back. PayPal lists the dispute as ${x.status}${dueSentence}.${x.pending ? " The capture now shows PENDING at PayPal." : ""} The shop's books say paid and have no dispute on file.`;
  const found = `Doorbell checked the shop's ${x.rows} ${plural(x.rows, "capture")} and asked PayPal for the disputes on each. It found 1 gap: a ${x.amount} dispute that PayPal lists as open and your books do not show.`;
  const closing = `The chapters below follow the dispute on order #${x.n} from PayPal to your books.`;

  const noMessage = "No webhook of this app asked for dispute events, so ==no webhook message about the dispute was ever going to reach your shop==.";
  const travelA = `PayPal opened the dispute at ${tCreated} UTC. A webhook only receives the kinds of event it asked for.`;
  const travelB = `About ${x.secondsToFind} seconds later, at ${tListed} UTC, Doorbell read PayPal's Disputes API for each capture and found a ${x.amount} dispute on order #${x.n} that the books do not show. At ${tLooked} UTC it asked again, and the books still had no dispute.`;
  const travelC = "Whether PayPal made an event of its own for this dispute cannot be proven from here.";

  const whyHead = DISPUTE_WORDS.why;
  const whyA = "Doorbell read the list of this app's webhooks from PayPal. The shop's webhook does not subscribe to the dispute-created event, CUSTOMER.DISPUTE.CREATED, and no other webhook of the app does.";
  const whyShort = DISPUTE_WORDS.whyShort;
  const whyRest = "The shop runs its working handler, and no message about the dispute ever reached it.";

  const replayHead = DISPUTE_WORDS.replay;
  const replayFirst = "A replay sends the real signed events to the shop's good build and its bad build.";
  const replayRest = "No event about this dispute ever reached the shop, and no build was changed, so there is nothing to replay. The gap does not depend on it.";

  const fixHead = DISPUTE_WORDS.fix;
  const fixA = `The shop owner opens the webhook in PayPal's dashboard and adds the dispute events to the ones it subscribes to, starting with CUSTOMER.DISPUTE.CREATED. PayPal would then tell the shop about the next dispute. We did not test whether it would also send one for this dispute, which is already open.`;
  const fixB = "Doorbell does not make that change: it only reads from PayPal. The demo does not make it either, so in this run ==the gap stays open==.";
  const fixShort = "Doorbell only reads, and the demo does not change the setting either, so the gap stays open.";

  const ringHead = "Ring again has nothing to send.";
  const ringBody = `On the real run, Ring again was pressed for this dispute and nothing was sent: ${x.resends} ${plural(x.resends, "resend")} used. Ring again asks PayPal to send an event to the shop again. ${x.ringLabel}`;
  const ringParts = sentenceList(ringBody);

  const subject: Subject = { n: x.n, label: x.label, amount: x.amount, captureId: x.row.captureId, eventWord: "dispute" };
  const panel: Panel = {
    subject,
    stations: stationsOf(x),
    replay: null,
    ledger: ledgerOf(end, x),
    money: totalOf(end),
    available: { 1: true, 2: true, 3: true, 4: false, 5: true, 6: true, 7: true },
    mode: "script",
    fixedFile: null,
    badFile: null,
    reach: 0,
  };

  // Planned in the order a reader meets the words: the bar, then each chapter top to bottom (object properties are evaluated in this order).
  const story: Story = {
    id: sc.id,
    label,
    date: first.recordedAt !== null ? utcDay(first.recordedAt) : null,
    kind: "other",
    bar: modeLine(planner, first),
    focal: { h: DISPUTE_WORDS.focal(x.amount, x.n), lead: rich(lead), body: [PITCH_LOOKS, what].map(rich), found: rich(found), pitch: rich(closing) },
    travel: { h: DISPUTE_WORDS.travel, body: [`${travelA} ${noMessage}`, travelB, travelC].map(rich) },
    why: { h: whyHead, body: [whyA, `${whyShort} ${whyRest}`].map(rich) },
    replay: { h: replayHead, body: [`${replayFirst} ${replayRest}`].map(rich) },
    fix: { h: fixHead, body: [fixA, fixB].map(rich) },
    ring: { hBefore: ringHead, hDuring: ringHead, hAfter: ringHead, body: rich(ringBody), note: "The answer of the real run, recorded.", noteDetail: null, result: x.ringLabel },
    cert: { before: null as unknown as CertView, after: null as unknown as CertView },
    captures: { before: capturesOf(due, x), after: capturesOf(end, x) },
    panel,
    phone: null as unknown as Story["phone"],
    certGreen: end.certificate?.stamp === "green",
  };
  const before = certOf(due, rich);
  const after = certOf(end, (s) => plainRich(s));
  story.cert = { before, after };

  // The phone's rail: the same facts as the second chapter, one row each, time on the left. A row with no time is something that did not happen.
  const row = (t: string | null, text: string, o: { dashed?: boolean; mark?: MarkKind } = {}): PhoneRow => ({ t, x: rich2(text), dashed: o.dashed ?? false, mark: o.mark ?? null });
  story.phone = {
    c1: {
      vs: [
        { who: "PayPal says", word: "Dispute open", amount: x.amount, mark: "ink" },
        { who: "Your books say", word: "No dispute", amount: null, mark: "bad" },
      ],
      caption: rich2(`${x.label}. ${lead}`),
      beats: PITCH_BEATS.map((b, k) => rich2(k === 0 ? `Doorbell ${b}` : b)),
      more: [PITCH_FIRST, what, found, closing].map(rich2),
    },
    c2: {
      short: rich2(noMessage),
      rows: [
        row(tCreated, `PayPal opened the **${x.amount}** dispute`),
        row(null, "**Nothing reached** your shop: no webhook asked for dispute events", { dashed: true }),
        row(tListed, "Doorbell read PayPal's Disputes API and found it"),
        row(tLooked, "Doorbell asked again: books still have **no dispute**", { mark: "bad" }),
      ],
      more: [travelA, travelB, travelC].map((p) => rich2(unmark(p))),
    },
    c3: { short: rich2(whyShort), more: [whyA, whyRest].map(rich2) },
    c4: { short: rich2(replayFirst), more: [replayRest].map(rich2) },
    c5: { h: fixHead, short: rich2(fixShort), change: null, books: plainRich("Books still have **no dispute** on file"), more: [fixA, fixB].map(rich2) },
    c6: { short: rich2(ringParts[0]), more: [ringParts.slice(1).join(" ")].filter(Boolean).map(rich2) },
    cert: { before: certOf(due, rich2), after: after },
  };
  return story;
}

// ---- the live lane ------------------------------------------------------------------------------------------------------------------------------

export interface OpenDispute {
  row: ScanRow;
  d: DisputeView;
}

// The disputes of a snapshot that the books do not show, in row order. A TIED dispute is one the shop booked: there is nothing to tell.
export const openDisputesOf = (snap: RunSnapshot): OpenDispute[] => (snap.scan?.rows ?? []).flatMap((row) => (row.disputes ?? []).filter((d) => d.status !== "TIED").map((d) => ({ row, d })));

// The facts of one dispute from the newest scan alone. Null for a dispute this story cannot tell truthfully (a webhook that does subscribe, one that is not
// provable yet): the lane then says only what the closed vocabularies say, and draws no path for it.
function liveFactsOf(snap: RunSnapshot, { row, d }: OpenDispute): Facts | null {
  if (!snap.scan || untellable(d) !== null) return null;
  const at = snap.scan.at;
  return {
    row,
    dispute: d,
    rows: snap.scan.rows.length,
    n: row.n,
    item: row.itemName,
    amount: money(d.amount),
    label: `Order #${row.n}, ${lower(row.itemName.split(":")[0])}`,
    createdAt: d.createdAt,
    listedAt: at,
    lookedAt: at,
    secondsToFind: null, // one scan is not "how long Doorbell took to find it": the first scan that found it is not known
    dueAt: d.dueDateSource === "sandbox_test" ? d.sellerResponseDueAt : null,
    status: STATUS_WORD[d.paypalStatus],
    pending: row.paypalStatus === "PENDING",
    resends: snap.scan.resendsUsed,
    live: true,
    ringLabel: d.ring!.label,
    noWebhookLimit: snap.certificate?.limits.find((l) => NO_WEBHOOK_LIMIT.test(l)) ?? "",
  };
}

// The path panel for the first dispute of a live snapshot that this story can tell: the recorded story's stations, read from one scan. Chapter 4 (no replay)
// and chapter 5 (the fix is the owner's setting, and no handler was switched) are off, as they are no step of a live session; chapter 6 says that Ring again
// has nothing to send. Null when there is no such dispute.
export function liveDisputePanel(snap: RunSnapshot): Panel | null {
  const x = openDisputesOf(snap).map((o) => liveFactsOf(snap, o)).find((f): f is Facts => f !== null);
  if (!x) return null;
  return {
    subject: { n: x.n, label: x.label, amount: x.amount, captureId: x.row.captureId, eventWord: "dispute" },
    stations: stationsOf(x),
    replay: null,
    ledger: ledgerOf(snap, x),
    money: totalOf(snap),
    available: { 1: true, 2: true, 3: true, 4: false, 5: false, 6: true, 7: !!snap.certificate },
    mode: "live",
    fixedFile: null,
    badFile: null,
    reach: 0,
  };
}

// What the live lane's left column says under a dispute gap: the recorded story's sentences for what happened, how it travelled, and (under "why") that no
// AI was asked, that there is no replay and what the fix is. A dispute this story cannot tell gets the fixed title of the recorded run's steps
// (lib/run/titles.ts) and, when it is not provable yet, the waiting reason's own phrase.
export interface DisputeRowWords {
  title: string;
  detail: string | null;
  cause: string | null;
}

export function liveDisputeRow(snap: RunSnapshot, o: OpenDispute): DisputeRowWords {
  const x = liveFactsOf(snap, o);
  if (x) return { title: DISPUTE_WORDS.focal(x.amount, x.n), detail: DISPUTE_WORDS.travel, cause: [DISPUTE_WORDS.why, DISPUTE_WORDS.whyShort, DISPUTE_WORDS.replay, DISPUTE_WORDS.fix].join(" ") };
  const waiting = o.d.finding?.waiting;
  return { title: disputeTitle("listed", snap, o.row.captureId), detail: waiting ? WAITING_PHRASE[waiting] : null, cause: null };
}
