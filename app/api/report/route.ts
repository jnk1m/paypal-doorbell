// The report intake for a shop of your own (README, "For a shop of your own"): the shop's webhook handler posts one signed line per
// call here, through lib/shop/http-reporter.ts. Closed (404, nothing read or written) unless DOORBELL_REPORTER_SECRET is set; the hosted
// demo does not set it, so its shop reports in-process and nobody outside that process can report on its behalf.
import { reportIntakeFromEnv } from "../../../lib/shop/config.ts";
import { handleReport } from "../../../lib/shop/report-intake.ts";
import { handle } from "../../../lib/web/http.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 10;

export function POST(req: Request): Promise<Response> {
  return handle("api/report", () => handleReport(req, reportIntakeFromEnv()));
}
