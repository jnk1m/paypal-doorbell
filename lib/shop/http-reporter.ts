// The reporter for a shop of your own (R24, plan 5.7): the same two calls as the in-process reporter (reporter.ts), each sent as one signed
// POST to the report intake of a Doorbell you run yourself (app/api/report). The hosted demo's shop does not use this file: it reports
// in-process, and the hosted intake is closed.
//
// It never throws and never waits long: a Doorbell that is down, slow or refusing must not change what the shop does with PayPal's
// delivery. A report that could not be sent is handed to `onError` (one JSON line on stderr by default), and the missing record is
// then what Doorbell finds. The timeout is 3 s per report; a shop's webhook handler should call received() before its own work and
// responded() in a finally, so that "arrived and then died" leaves a received line with no responded line.
import { randomBytes } from "node:crypto";
import type { Attempt, Reporter } from "./reporter.ts";
import { HEADER_NONCE, HEADER_SIGNATURE, HEADER_TIMESTAMP, signReport, type ReportLine } from "./report-signature.ts";

export interface HttpReporterOptions {
  url: string; // the intake, e.g. https://doorbell.example/api/report
  secret: string; // the same value as the Doorbell's DOORBELL_REPORTER_SECRET
  timeoutMs?: number;
  fetch?: typeof fetch;
  now?: () => number;
  onError?: (line: Record<string, unknown>) => void;
  newAttemptId?: () => string;
  newNonce?: () => string;
}

export const REPORT_TIMEOUT_MS = 3000;

export class HttpReporter implements Reporter {
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;
  private readonly onError: (line: Record<string, unknown>) => void;
  private readonly newAttemptId: () => string;
  private readonly newNonce: () => string;

  constructor(private readonly options: HttpReporterOptions) {
    this.timeoutMs = options.timeoutMs ?? REPORT_TIMEOUT_MS;
    this.fetchFn = options.fetch ?? ((input, init) => fetch(input, init));
    this.now = options.now ?? Date.now;
    this.onError = options.onError ?? ((line) => console.error(JSON.stringify({ reporter: "http", ...line })));
    this.newAttemptId = options.newAttemptId ?? (() => randomBytes(6).toString("hex"));
    this.newNonce = options.newNonce ?? (() => randomBytes(16).toString("hex"));
  }

  async received(transmissionId: string, eventId: string): Promise<Attempt> {
    const attempt = { id: this.newAttemptId(), eid: eventId };
    await this.send({ k: "rx", tid: transmissionId, eid: eventId, a: attempt.id });
    return attempt;
  }

  async responded(transmissionId: string, statusCode: number, attempt: Attempt): Promise<void> {
    await this.send({ k: "rs", tid: transmissionId, eid: attempt.eid, a: attempt.id, st: statusCode });
  }

  private async send(line: ReportLine): Promise<void> {
    const body = JSON.stringify(line);
    const timestamp = this.now();
    const nonce = this.newNonce();
    try {
      const res = await this.fetchFn(this.options.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          [HEADER_TIMESTAMP]: String(timestamp),
          [HEADER_NONCE]: nonce,
          [HEADER_SIGNATURE]: signReport(this.options.secret, timestamp, nonce, body),
        },
        body,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!res.ok) this.onError({ outcome: "report_refused", k: line.k, status: res.status });
    } catch (e) {
      this.onError({ outcome: "report_failed", k: line.k, error: e instanceof Error ? e.message.slice(0, 120) : "unknown" });
    }
  }
}
