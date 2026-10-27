// The report intake for a shop of your own (R24, plan 5.7): where an HttpReporter (http-reporter.ts) posts one signed line per call, so that
// a Doorbell you run yourself has your handler's own answers, in the same record the in-process reporter writes (reporter.ts).
//
// Closed unless a secret of at least 32 characters is configured (DOORBELL_REPORTER_SECRET): then every request is answered 404 and nothing
// is read or written. The hosted demo sets no secret: its shop reports in-process, and nobody outside that process can report on its behalf.
//
// The checks run cheapest first, and the signature is checked before any database command, so a flood of unsigned or mis-signed
// requests costs the database nothing. Only a request that carries a valid signature reaches the nonce check (one command) and the
// append (two). Every refusal has the same body (the witness's), and the reason goes to the server log only, at most once a second.
import { readBodyCapped } from "../witness/precheck.ts";
import { HEADER_NONCE, HEADER_SIGNATURE, HEADER_TIMESTAMP, MAX_REPORT_BYTES, MAX_SKEW_MS, MIN_SECRET_LENGTH, NONCE, NONCE_TTL_MS, parseReportLine, signatureMatches, TIMESTAMP } from "./report-signature.ts";
import type { ShopStore } from "./store.ts";

export interface ReportIntakeDeps {
  secret?: string; // absent or shorter than MIN_SECRET_LENGTH: the intake is closed
  store?: Pick<ShopStore, "appendReport" | "claimReportNonce">; // read only when the intake is open
  now?: () => number;
  log?: (line: Record<string, unknown>) => void;
}

const JSON_HEADERS = { "Content-Type": "application/json", "Cache-Control": "no-store" };
export const REPORT_ACCEPTED_BODY = JSON.stringify({ ok: true });
export const REPORT_REFUSED_BODY = JSON.stringify({ error: { message: "Not authorized." } });
export const REPORT_CLOSED_BODY = JSON.stringify({ error: { message: "Not found." } });

export const isIntakeOpen = (deps: Pick<ReportIntakeDeps, "secret" | "store">): deps is { secret: string; store: NonNullable<ReportIntakeDeps["store"]> } =>
  typeof deps.secret === "string" && deps.secret.length >= MIN_SECRET_LENGTH && deps.store !== undefined;

const refusalStats = { refused: 0, lastLogMs: 0 };

export async function handleReport(req: Request, deps: ReportIntakeDeps): Promise<Response> {
  const now = deps.now ?? Date.now;
  const started = now();
  const log = deps.log ?? ((line) => console.log(JSON.stringify({ route: "api/report", ...line })));

  if (!isIntakeOpen(deps)) return new Response(REPORT_CLOSED_BODY, { status: 404, headers: JSON_HEADERS });

  const refused = (reason: string) => {
    refusalStats.refused++;
    if (started - refusalStats.lastLogMs >= 1000) {
      refusalStats.lastLogMs = started;
      log({ outcome: "refused", reason, refusedOnThisInstance: refusalStats.refused });
    }
    return new Response(REPORT_REFUSED_BODY, { status: 401, headers: JSON_HEADERS });
  };

  if (!(req.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) return refused("content type is not application/json");
  const timestampHeader = req.headers.get(HEADER_TIMESTAMP)?.trim() ?? "";
  const nonce = req.headers.get(HEADER_NONCE)?.trim() ?? "";
  const signature = req.headers.get(HEADER_SIGNATURE)?.trim() ?? "";
  if (!timestampHeader || !nonce || !signature) return refused("missing Doorbell header");
  if (!TIMESTAMP.test(timestampHeader)) return refused("malformed timestamp");
  if (!NONCE.test(nonce)) return refused("malformed nonce");
  const timestamp = Number(timestampHeader);
  if (Math.abs(started - timestamp) > MAX_SKEW_MS) return refused("timestamp is more than 5 minutes from this clock");

  const body = await readBodyCapped(req, MAX_REPORT_BYTES);
  if (!body.ok) return refused(body.reason);
  if (!signatureMatches(deps.secret, timestamp, nonce, body.raw, signature)) return refused("signature does not match");

  const line = parseReportLine(body.raw);
  if (!line) return refused("body is not one report line");

  // From here on the request is the shop's own. The nonce is the first database command: a replay of a genuine report is refused here.
  if (!(await deps.store.claimReportNonce(nonce, NONCE_TTL_MS))) return refused("nonce seen before");

  // The stored line is built here from the checked fields, with this clock: the same shape the in-process reporter writes.
  const stored = line.k === "rx" ? { k: "rx", tid: line.tid, a: line.a, at: started } : { k: "rs", tid: line.tid, a: line.a, at: started, st: line.st };
  await deps.store.appendReport(line.eid, JSON.stringify(stored));
  log({ outcome: "accepted", k: line.k, tid: line.tid, eid: line.eid, totalMs: now() - started });
  return new Response(REPORT_ACCEPTED_BODY, { status: 200, headers: JSON_HEADERS });
}
