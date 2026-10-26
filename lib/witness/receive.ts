// The witness receiver (R1, R2). What happens to one PayPal delivery:
//
//   1. pre-check headers and size            fails -> 401, same body, nothing stored (not a PayPal delivery)
//   2. reserve one verify call (60 / minute) none left -> quarantine, 200
//   3. POST /v1/notifications/verify-webhook-signature (the only way a signature is checked; no URL from a header is fetched)
//        SUCCESS              -> record the attempt; the first attempt per transmission id is the processed one -> 200
//        FAILURE              -> count it, store nothing -> 401, same body
//        call failed / unclear -> quarantine for a later re-verify -> 200 (a 5xx would make PayPal give up after 3 tries)
//
// Duplicates are decided only after a SUCCESS. A retry reuses the transmission id, time and signature (measured), so dropping
// a repeated id before verifying would drop PayPal's second and third attempts, and a forged repeat could shadow a real one.
import { createHash } from "node:crypto";
import { PaypalError, type VerifyParams } from "../pay/paypal.ts";
import { checkHeaders, parseEvent, readBodyCapped, type ParsedEvent, type SignatureHeaders } from "./precheck.ts";
import type { AttemptEntry, ReserveResult, WitnessStore } from "./store.ts";

export const MAX_ENTRY_BYTES = 8 * 1024;
const SLOT = "D";
const UNKNOWN_SLOT = "?"; // a delivery that could not be verified yet: which webhook it belongs to is not known

// One body for every refusal, whatever the reason, so a caller learns nothing from the answer.
const REJECT_BODY = JSON.stringify({ error: { message: "Not authorized." } });
const reject = () => new Response(REJECT_BODY, { status: 401, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
const accept = () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

// A webhook this receiver accepts deliveries for. Verify is not tied to the app whose token asks (measured 2026-10-19: a token of
// one Sandbox app verifies a delivery signed for a webhook of another), so one client serves every target.
export interface WitnessTarget {
  slot: string;
  webhookId: string;
}

export interface WitnessDeps {
  webhookId: string; // the witness webhook's id (slot D), from server configuration only
  extraTargets?: WitnessTarget[]; // more webhooks that deliver here, tried in order after D (for example the dev app's witness)
  verify: (p: VerifyParams) => Promise<string | undefined>; // PayPal's verification_status; throws when the call fails
  store: WitnessStore;
  onVerified?: (entry: AttemptEntry) => Promise<void>; // after the first verified attempt of a transmission id is stored; a failure is logged, never raised
  now?: () => number;
  log?: (line: Record<string, unknown>) => void;
}

export type Outcome =
  | "processed" // verified, first attempt of this transmission id
  | "duplicate" // verified, a repeat of an id already processed
  | "quarantined_budget"
  | "quarantined_unavailable"
  | "rejected_verify" // PayPal said FAILURE
  | "rejected_precheck";

// Once the shared counter has said "spent", skip asking until the window ends, so a flood costs no Redis command for the budget check.
const blockedUntil = new WeakMap<WitnessStore, number>();

// Pre-check refusals are counted per instance and logged at most once a second: they are not deliveries, so they cost no Redis command.
const precheckStats = { refused: 0, lastLogMs: 0 };

export function buildEntry(headers: SignatureHeaders, parsed: ParsedEvent, raw: string, at: number, st: AttemptEntry["st"], why?: AttemptEntry["why"], slot: string = st === "ok" ? SLOT : UNKNOWN_SLOT): AttemptEntry {
  const bytes = Buffer.from(raw, "utf8");
  const entry: AttemptEntry = {
    v: 1,
    tid: headers.transmissionId,
    slot,
    at,
    st,
    ...(why ? { why } : {}),
    h: { time: headers.transmissionTime, sig: headers.transmissionSig, algo: headers.authAlgo, cert: headers.certUrl },
    eid: parsed.eventId,
    type: parsed.eventType,
    raw,
    sha: createHash("sha256").update(bytes).digest("hex"),
    len: bytes.length,
  };
  if (Buffer.byteLength(JSON.stringify(entry), "utf8") > MAX_ENTRY_BYTES) {
    delete entry.raw;
    entry.big = true;
  }
  return entry;
}

const verifyParams = (webhookId: string, h: SignatureHeaders, event: unknown): VerifyParams => ({
  authAlgo: h.authAlgo,
  certUrl: h.certUrl,
  transmissionId: h.transmissionId,
  transmissionSig: h.transmissionSig,
  transmissionTime: h.transmissionTime,
  webhookId,
  webhookEvent: event,
});

// What PayPal's answer means: "verified", "forged", or "could not tell" (anything but a clear SUCCESS/FAILURE).
type Verdict = "SUCCESS" | "FAILURE" | "UNAVAILABLE";

async function judge(deps: WitnessDeps, p: VerifyParams): Promise<{ verdict: Verdict; detail?: string }> {
  try {
    const status = await deps.verify(p);
    if (status === "SUCCESS" || status === "FAILURE") return { verdict: status };
    return { verdict: "UNAVAILABLE", detail: `unexpected verification_status ${JSON.stringify(status)?.slice(0, 40)}` };
  } catch (e) {
    // A 400 or 422 is PayPal refusing this input (not a transient fault): the delivery is not verifiable, so it counts as a FAILURE.
    if (e instanceof PaypalError && (e.status === 400 || e.status === 422)) return { verdict: "FAILURE", detail: e.message };
    if (e instanceof PaypalError) return { verdict: "UNAVAILABLE", detail: e.message };
    return { verdict: "UNAVAILABLE", detail: e instanceof Error ? `${e.name}: ${e.message.slice(0, 120)}` : "unknown error" };
  }
}

const targetsOf = (deps: WitnessDeps): WitnessTarget[] => [{ slot: SLOT, webhookId: deps.webhookId }, ...(deps.extraTargets ?? [])];

interface TargetVerdict {
  verdict: Verdict;
  detail?: string;
  slot?: string; // the target that verified the delivery (SUCCESS only)
  budget?: ReserveResult; // set when the verify budget ran out before every target was tried
}

// Asks PayPal about each target in turn until one says SUCCESS. A FAILURE moves on to the next target; a call that could not be
// answered stops the search (the delivery is quarantined, not judged). The caller has already reserved the first target's budget unit;
// every further target costs one more.
async function judgeAll(deps: WitnessDeps, h: SignatureHeaders, event: unknown): Promise<TargetVerdict> {
  let last: TargetVerdict = { verdict: "FAILURE" };
  for (const [i, target] of targetsOf(deps).entries()) {
    if (i > 0) {
      const budget = await deps.store.reserveVerify();
      if (!budget.allowed) return { verdict: "UNAVAILABLE", detail: "verify budget spent", budget };
    }
    const { verdict, detail } = await judge(deps, verifyParams(target.webhookId, h, event));
    last = { verdict, detail, slot: verdict === "SUCCESS" ? target.slot : undefined };
    if (verdict !== "FAILURE") return last;
  }
  return last;
}

export async function receiveDelivery(req: Request, deps: WitnessDeps): Promise<Response> {
  const now = deps.now ?? Date.now;
  const started = now();
  const log = deps.log ?? ((line) => console.log(JSON.stringify({ route: "witness", ...line })));
  const refused = (reason: string) => {
    precheckStats.refused++;
    if (started - precheckStats.lastLogMs >= 1000) {
      precheckStats.lastLogMs = started;
      log({ outcome: "rejected_precheck", reason, refusedOnThisInstance: precheckStats.refused });
    }
    return reject();
  };

  const headers = checkHeaders(req.headers, started);
  if (!headers.ok) return refused(headers.reason);
  const body = await readBodyCapped(req);
  if (!body.ok) return refused(body.reason);
  const event = parseEvent(body.raw);
  if (!event.ok) return refused(event.reason);

  const h = headers.headers;
  const done = (outcome: Outcome, response: Response, extra: Record<string, unknown> = {}) => {
    log({ outcome, tid: h.transmissionId, eventType: event.parsed.eventType, totalMs: now() - started, ...extra });
    return response;
  };

  const quarantine = async (why: NonNullable<AttemptEntry["why"]>, outcome: Outcome, detail?: string) => {
    await deps.store.quarantine(buildEntry(h, event.parsed, body.raw, started, "q", why));
    return done(outcome, accept(), detail ? { detail } : {});
  };

  // 2. budget
  if (started < (blockedUntil.get(deps.store) ?? 0)) return quarantine("budget", "quarantined_budget");
  const budget = await deps.store.reserveVerify();
  if (!budget.allowed) {
    blockedUntil.set(deps.store, started + Math.max(1000, budget.msLeft ?? 1000));
    return quarantine("budget", "quarantined_budget");
  }

  // 3. verify
  const verifyStarted = now();
  const { verdict, detail, slot, budget: spent } = await judgeAll(deps, h, event.parsed.event);
  const verifyMs = now() - verifyStarted;

  if (spent) {
    blockedUntil.set(deps.store, started + Math.max(1000, spent.msLeft ?? 1000));
    return quarantine("budget", "quarantined_budget");
  }
  if (verdict === "FAILURE") {
    await deps.store.countRejected(started);
    return done("rejected_verify", reject(), { verifyMs, ...(detail ? { detail } : {}) });
  }
  if (verdict === "UNAVAILABLE") return quarantine("unavail", "quarantined_unavailable", detail);

  const entry = buildEntry(h, event.parsed, body.raw, started, "ok", undefined, slot);
  const committed = await deps.store.commitVerified(entry);
  let hookError: string | undefined;
  if (committed.processed && deps.onVerified) {
    try {
      await deps.onVerified(entry);
    } catch (e) {
      hookError = e instanceof Error ? `${e.name}: ${e.message.slice(0, 120)}` : "unknown error";
    }
  }
  return done(committed.processed ? "processed" : "duplicate", accept(), { verifyMs, attempts: committed.attempts, slot, ...(hookError ? { hookError } : {}) });
}

export interface ReverifyResult {
  checked: number;
  verified: number; // now stored as attempts
  rejected: number; // PayPal says FAILURE: dropped
  stillUnavailable: number; // left in the ring for the next run
  unrecoverable: number; // the body was too big to keep: dropped
  stoppedByBudget: boolean;
}

// Verifies what the receiver could not (R1). A scan, a heartbeat or a script calls it; each entry uses one unit of the verify budget.
export async function reverifyQuarantined(deps: WitnessDeps, opts: { max?: number } = {}): Promise<ReverifyResult> {
  const now = deps.now ?? Date.now;
  const result: ReverifyResult = { checked: 0, verified: 0, rejected: 0, stillUnavailable: 0, unrecoverable: 0, stoppedByBudget: false };
  for (const { raw, entry } of await deps.store.listQuarantined(opts.max ?? 25)) {
    if (entry.raw === undefined) {
      // Oversize bodies are kept as a hash only, which cannot be verified.
      await deps.store.dropQuarantined(raw);
      result.unrecoverable++;
      continue;
    }
    const budget = await deps.store.reserveVerify();
    if (!budget.allowed) {
      result.stoppedByBudget = true;
      break;
    }
    result.checked++;
    const parsed = parseEvent(entry.raw);
    const h: SignatureHeaders = { transmissionId: entry.tid, transmissionTime: entry.h.time, transmissionSig: entry.h.sig, certUrl: entry.h.cert, authAlgo: entry.h.algo };
    const { verdict, slot, budget: spent } = parsed.ok ? await judgeAll(deps, h, parsed.parsed.event) : { verdict: "FAILURE" as const, slot: undefined, budget: undefined };
    if (spent) {
      result.stoppedByBudget = true;
      result.stillUnavailable++;
      break;
    }
    if (verdict === "UNAVAILABLE") {
      result.stillUnavailable++;
    } else if (verdict === "FAILURE") {
      await deps.store.dropQuarantined(raw);
      await deps.store.countRejected(now());
      result.rejected++;
    } else {
      const verified: AttemptEntry = { ...entry, st: "ok", rv: now(), slot: slot ?? SLOT };
      delete verified.why;
      const resolved = await deps.store.resolveQuarantined(raw, verified);
      if (resolved !== "gone") result.verified++;
      // A delivery that verifies late is still the first one heard of its transmission id: tell the hook, as the live path does.
      if (resolved !== "gone" && resolved.processed && deps.onVerified) {
        try {
          await deps.onVerified(verified);
        } catch (e) {
          (deps.log ?? ((line) => console.log(JSON.stringify({ route: "witness", ...line }))))({ outcome: "reverify_hook_failed", tid: verified.tid, error: e instanceof Error ? e.message.slice(0, 120) : "unknown error" });
        }
      }
    }
  }
  return result;
}
