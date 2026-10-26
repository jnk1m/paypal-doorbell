// "Ring again" (R5): ask PayPal to send one event of this session to the shop again.
//
// What may be resent is decided here and nowhere else, from the server's own picture of the session: the client names an order
// (a capture id) and nothing more. The event, its id, whether it is listed, whether PayPal's own retries are still pending and how many
// resends the session has left are all read again at this moment. An order that is not this session's gets the same 403 as any other
// forbidden thing, before anything is sent to PayPal.
import { HttpError } from "../web/http.ts";
import { snapshotOf, sendResend } from "./heal.ts";
import type { Ring } from "./classify.ts";
import { scanSession, type ScanDeps } from "./scan.ts";
import type { Mode } from "../shop/types.ts";

export type RingOutcome = { sent: true; at: number; resends: number } | { sent: false; ring: Ring };

// `beforeSend` is asked when a resend is really about to go to PayPal (the session's own five are counted and the event is not locked), and
// not for a press that is refused earlier: the route uses it for the global pool of refunds and resends.
export async function ringAgain(deps: ScanDeps, sid: string, session: { mode: Mode; at: number }, captureId: string, opts: { beforeSend?: () => Promise<void> } = {}): Promise<RingOutcome> {
  if (!(await deps.store.orders(sid)).some((o) => o.captureId === captureId)) throw new HttpError(403, "Forbidden.", { reason: "capture is not an order of this session" });

  const scan = await scanSession(deps, sid, session, { only: captureId, advance: false });
  const row = scan.rows[0];
  const event = row?.events.find((e) => e.finding !== null);
  if (!row || row.status === "TIED") return { sent: false, ring: { state: "wait", label: "Nothing to resend: the books match PayPal" } };
  // A row that is a gap only because PayPal lists a dispute on it has no event to send again. The answer says why (disputes.ts disputeRing); nothing is sent.
  const dispute = event ? undefined : row.disputes?.find((d) => d.ring !== null);
  if (dispute?.ring) return { sent: false, ring: dispute.ring };
  if (!event?.ring) return { sent: false, ring: { state: "wait", label: "Not provable yet" } };
  if (event.ring.state !== "ready" || !event.eid) return { sent: false, ring: event.ring };

  const sent = await sendResend({ store: deps.store, reads: deps.reads, shopWebhookId: deps.shopWebhookId, now: deps.now ?? Date.now, log: deps.log, beforeSend: opts.beforeSend }, sid, {
    eid: event.eid,
    captureId,
    kind: event.kind,
    seen: [...new Set((event.s ?? []).map((a) => a.tid))],
    booksBefore: snapshotOf(row.book),
  });
  if (sent.result === "sent") return { sent: true, at: sent.record.sends[0], resends: scan.resendsUsed + 1 };
  if (sent.result === "cap") return { sent: false, ring: { state: "cap_reached", label: "Resend limit reached (5 per session)" } };
  if (sent.result === "busy") return { sent: false, ring: { state: "in_progress", label: "Resent, waiting for it to arrive" } };
  return { sent: false, ring: { state: "not_listed", label: `Cannot auto-heal: PayPal refused the resend (HTTP ${sent.status})` } };
}
