// The reporter (R24, plan 5.7). The shop calls received() as the first thing it does with a delivery and responded() in a finally,
// so that "arrived and then crashed" (a received line with no responded line) differs from "never arrived" (no record at all).
//
// Hosted path: the shop is code in the same deployment, so these are plain function calls. No HTTP request is made, nothing here
// needs authentication, and nobody outside the process can report on the shop's behalf. (The record itself is written to Redis,
// which is the only network traffic of a report.) The bring-your-own-shop path with HMAC is http-reporter.ts (the shop's side) and
// report-intake.ts (the Doorbell's side); they write the same record.
//
// One record per event id (a retry reuses the transmission id; a resend gets a new one; both belong to the same event):
//   {"k":"rx","tid":...,"a":<attempt>,"at":<ms>}             the delivery reached the handler
//   {"k":"rs","tid":...,"a":<attempt>,"at":<ms>,"st":<code>} the handler answered with this status
// A line is only ever appended, so two attempts at once cannot overwrite each other.
import { randomBytes } from "node:crypto";
import type { ShopStore } from "./store.ts";

// What received() hands back: the key that ties a responded() to its received(), since retries of one delivery share a transmission id.
export interface Attempt {
  id: string;
  eid: string;
}

export interface Reporter {
  received(transmissionId: string, eventId: string): Promise<Attempt>;
  responded(transmissionId: string, statusCode: number, attempt: Attempt): Promise<void>;
}

export class InProcessReporter implements Reporter {
  constructor(
    private readonly store: Pick<ShopStore, "appendReport">,
    private readonly now: () => number = Date.now,
    private readonly newAttemptId: () => string = () => randomBytes(6).toString("hex"),
  ) {}

  async received(transmissionId: string, eventId: string): Promise<Attempt> {
    const attempt = { id: this.newAttemptId(), eid: eventId };
    await this.store.appendReport(eventId, JSON.stringify({ k: "rx", tid: transmissionId, a: attempt.id, at: this.now() }));
    return attempt;
  }

  async responded(transmissionId: string, statusCode: number, attempt: Attempt): Promise<void> {
    await this.store.appendReport(attempt.eid, JSON.stringify({ k: "rs", tid: transmissionId, a: attempt.id, at: this.now(), st: statusCode }));
  }
}

// A handler that has not answered this long after it was reached is counted as crashed (the shop route's maxDuration is 10 s).
export const CRASH_AFTER_MS = 30_000;

export type AttemptState = "responded" | "in_flight" | "crashed";

export interface AttemptReport {
  tid: string;
  attempt: string;
  receivedAt?: number; // missing when only the responded line made it to the record
  state: AttemptState;
  status?: number;
  respondedAt?: number;
}

// Reads one event's record. null means nothing was ever reported for the event (the gap finder's NO_REPORT); a record whose
// attempt has no answer long after it arrived is "crashed" (HANDLER_REJECTING with the CRASHED flag). Lines that do not parse are skipped.
export function summarizeReport(record: string | null, now: number): AttemptReport[] | null {
  if (record === null) return null;
  const byAttempt = new Map<string, AttemptReport>();
  for (const line of record.split("\n")) {
    if (!line) continue;
    let l: { k?: string; tid?: string; a?: string; at?: number; st?: number };
    try {
      l = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof l.a !== "string" || typeof l.tid !== "string" || typeof l.at !== "number") continue;
    const row = byAttempt.get(l.a) ?? { tid: l.tid, attempt: l.a, state: "in_flight" as AttemptState };
    if (l.k === "rx") row.receivedAt = l.at;
    if (l.k === "rs" && typeof l.st === "number") Object.assign(row, { state: "responded", status: l.st, respondedAt: l.at });
    byAttempt.set(l.a, row);
  }
  const rows = [...byAttempt.values()];
  for (const row of rows) if (row.state === "in_flight" && row.receivedAt !== undefined && now - row.receivedAt > CRASH_AFTER_MS) row.state = "crashed";
  return rows.sort((a, b) => (a.receivedAt ?? a.respondedAt ?? 0) - (b.receivedAt ?? b.respondedAt ?? 0));
}
