// The invalidation rule for live trials, pre-registered (plan R4; committed before any S3 live trial was run).
//
// A live trial is about the shop and the gap finder, not about PayPal's delivery. When PayPal itself loses an event (F6: events lost
// in the first minutes after a webhook registration, 4 of 7 on a new webhook, cause unknown), the trial never got the chance to show
// anything. Such a trial is recorded as INVALID with its reason, run again, and counted. It is never silently dropped and never counted
// as a pass. If more than 30% of the trials are invalid the report says "environment unstable" instead of a pass rate.
//
// The oracle is independent of the gap finder's verdicts: it looks only at facts the product did not decide (what D stored, what S's
// reporter stored, what PayPal's list shows).
export const LOSS_WINDOW_MS = 180_000; // PayPal's own retries are over by about 160 s (F5) and the list shows an event within 163 s at most (F3)
export const UNSTABLE_ABOVE = 0.3;

export interface EventFacts {
  what: string; // "payment" or "refund"
  sinceMs: number; // time since the action that created the event
  dHeard: boolean; // the witness stored a delivery
  listed: boolean; // PayPal's event list shows it
  sReceived: boolean; // the shop's reporter has a record of it
}

export type Validity = { valid: true; note?: string } | { valid: false; reason: string } | { valid: "pending" };

// Every trial in this stage needs the shop to receive the event it is about, so "the shop never received it" is what invalidates.
export function judgeEvent(e: EventFacts): Validity {
  if (e.sReceived) {
    return e.dHeard || e.listed ? { valid: true } : { valid: true, note: `the shop received the ${e.what} but neither the witness nor PayPal's list has it` };
  }
  if (e.sinceMs < LOSS_WINDOW_MS) return { valid: "pending" };
  if (!e.dHeard && !e.listed) return { valid: false, reason: `the ${e.what} event reached neither the witness nor the shop and is not in PayPal's list after ${Math.round(e.sinceMs / 1000)} s (PayPal-side loss, F6)` };
  return { valid: false, reason: `the ${e.what} event exists (${e.dHeard ? "the witness heard it" : "it is in PayPal's list"}) but the shop never received it after ${Math.round(e.sinceMs / 1000)} s (PayPal-side loss, F6)` };
}

export interface Tally {
  valid: number;
  invalid: number;
  invalidRate: number;
  verdict: "stable" | "environment unstable";
}

export function tally(trials: { valid: boolean }[]): Tally {
  const valid = trials.filter((t) => t.valid).length;
  const invalid = trials.length - valid;
  const invalidRate = trials.length === 0 ? 0 : invalid / trials.length;
  return { valid, invalid, invalidRate, verdict: invalidRate > UNSTABLE_ABOVE ? "environment unstable" : "stable" };
}
