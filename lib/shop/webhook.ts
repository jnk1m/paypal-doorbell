// The shop's webhook endpoint (S). What happens to one PayPal delivery:
//
//   1. pre-check headers, size and shape        fails -> 401, same body as the witness, nothing stored (not a PayPal delivery)
//   2. which order is it about?                 not a booking event, or not one of our sessions' orders -> 200, nothing stored
//   3. reporter.received(...)                   the delivery has reached the shop (first thing, before any handler code runs)
//   4. the session's mode picks the handler file, and that file verifies the signature and books the event. Which webhook id the signature is
//      checked against is also the mode's: the shop's own, except in the setting-bug mode, which is the "deployed with the wrong webhook id" case
//   5. reporter.responded(..., status) in a finally   so a handler that throws is reported as 500 and one that dies outright is not reported at all
//
// Steps 1-2 happen before anything is written, so a made-up request costs at most one Redis read. The signature is checked by the
// handler (a real shop would do the same inside its own code); this wrapper does not trust the body for anything but routing.
import type { VerifyParams } from "../pay/paypal.ts";
import { checkHeaders, parseEvent, readBodyCapped } from "../witness/precheck.ts";
import { bookingOf } from "./events.ts";
import { HANDLERS } from "./modes.ts";
import type { Attempt, Reporter } from "./reporter.ts";
import type { ShopStore } from "./store.ts";
import { isSettingBug, type HandlerContext } from "./types.ts";

export interface ShopWebhookDeps {
  webhookId: string; // the shop webhook's (S) id, from server configuration only
  settingWebhookId?: string; // another webhook's id on the same app (the witness's), which the setting-bug mode checks the signature against; absent: that mode cannot run
  store: ShopStore;
  reporter: Reporter;
  verify: (p: VerifyParams) => Promise<string | undefined>;
  now?: () => number;
  log?: (line: Record<string, unknown>) => void;
}

const JSON_HEADERS = { "Content-Type": "application/json", "Cache-Control": "no-store" };
const REJECT_BODY = JSON.stringify({ error: { message: "Not authorized." } });
const reply = (status: number): Response => {
  if (status === 401) return new Response(REJECT_BODY, { status, headers: JSON_HEADERS });
  if (status >= 200 && status < 300) return new Response(JSON.stringify({ ok: true }), { status, headers: JSON_HEADERS });
  return new Response(JSON.stringify({ error: { message: "Something went wrong." } }), { status, headers: JSON_HEADERS });
};

// Pre-check refusals are counted per instance and logged at most once a second, like the witness's: they are not deliveries.
const precheckStats = { refused: 0, lastLogMs: 0 };

export async function handleShopDelivery(req: Request, deps: ShopWebhookDeps): Promise<Response> {
  const now = deps.now ?? Date.now;
  const started = now();
  const log = deps.log ?? ((line) => console.log(JSON.stringify({ route: "shop-webhook", ...line })));

  const refused = (reason: string) => {
    precheckStats.refused++;
    if (started - precheckStats.lastLogMs >= 1000) {
      precheckStats.lastLogMs = started;
      log({ outcome: "rejected_precheck", reason, refusedOnThisInstance: precheckStats.refused });
    }
    return reply(401);
  };

  const headers = checkHeaders(req.headers, started);
  if (!headers.ok) return refused(headers.reason);
  const body = await readBodyCapped(req);
  if (!body.ok) return refused(body.reason);
  const parsed = parseEvent(body.raw);
  if (!parsed.ok) return refused(parsed.reason);

  const h = headers.headers;
  const { event, eventId, eventType } = parsed.parsed;

  const booking = bookingOf(event);
  if (!booking) {
    log({ outcome: "ignored", tid: h.transmissionId, eid: eventId, type: eventType });
    return reply(200);
  }
  const sid = await deps.store.sessionOfCapture(booking.captureId);
  const session = sid ? await deps.store.getSession(sid) : null;
  if (!sid || !session) {
    // Not an order of ours: an event of the other Sandbox app, an expired session, or a made-up body. Nothing is stored for it.
    log({ outcome: sid ? "expired" : "foreign", tid: h.transmissionId, eid: eventId, type: eventType });
    return reply(200);
  }

  // The reporter must never decide what the shop does: if it cannot write, the shop carries on and the missing record is itself the finding.
  const [received, noted] = await Promise.allSettled([deps.reporter.received(h.transmissionId, eventId), deps.store.noteReceived({ resourceId: booking.resourceId, type: booking.type }, eventId)]);
  const attempt: Attempt | undefined = received.status === "fulfilled" ? received.value : undefined;
  for (const failed of [received, noted]) {
    if (failed.status === "rejected") log({ outcome: "reporter_failed", step: "received", tid: h.transmissionId, eid: eventId, error: failed.reason instanceof Error ? failed.reason.message.slice(0, 120) : "unknown" });
  }

  let status = 500;
  try {
    const webhookId = isSettingBug(session.mode) ? deps.settingWebhookId : deps.webhookId;
    if (!webhookId) throw new Error(`the shop is in mode ${session.mode}, which checks the signature against another webhook's id, and none is configured (PAYPAL_WITNESS_WEBHOOK_ID)`);
    const ctx: HandlerContext = {
      rawBody: body.raw,
      verify: (ev) =>
        deps.verify({
          authAlgo: h.authAlgo,
          certUrl: h.certUrl,
          transmissionId: h.transmissionId,
          transmissionSig: h.transmissionSig,
          transmissionTime: h.transmissionTime,
          webhookId,
          webhookEvent: ev,
        }),
      books: { get: (captureId) => deps.store.getBook(sid, captureId), set: (captureId, entry) => deps.store.setBook(sid, captureId, entry) },
      now,
    };
    status = (await HANDLERS[session.mode].handleWebhook(ctx)).status;
    return reply(status);
  } finally {
    if (attempt) {
      try {
        await deps.reporter.responded(h.transmissionId, status, attempt);
      } catch (e) {
        log({ outcome: "reporter_failed", step: "responded", tid: h.transmissionId, eid: eventId, error: e instanceof Error ? e.message.slice(0, 120) : "unknown" });
      }
    }
    log({ outcome: "handled", mode: session.mode, status, tid: h.transmissionId, eid: eventId, type: eventType, totalMs: now() - started });
  }
}
