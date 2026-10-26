// The vocabulary of the cause step (plan 5.4): eight categories the model may name, the symptom classes code computes from the
// shop's own delivery records, the table C2 checks one against the other, and the sentences the screen shows. The model never
// writes a sentence; every word on screen about a cause comes from this file or from a line of the diff, found by its id.
import type { AttemptReport } from "../shop/reporter.ts";

export const CATEGORIES = ["RAW_BODY_ALTERED", "WRONG_WEBHOOK_ID", "WORK_AFTER_ACK", "EVENT_TYPE_DROPPED", "APP_OR_ENV_MISMATCH", "ENDPOINT_PATH_CHANGED", "OTHER_CODE_CHANGE", "NOT_IN_DIFF"] as const;
export type Category = (typeof CATEGORIES)[number];

export const SYMPTOM_CLASSES = ["all_401", "2xx_but_books_unchanged", "404_or_no_arrival", "other"] as const;
export type SymptomClass = (typeof SYMPTOM_CLASSES)[number];
export const isSymptomClass = (v: unknown): v is SymptomClass => typeof v === "string" && (SYMPTOM_CLASSES as readonly string[]).includes(v);

// C2 (plan 5.4): the categories that do not contradict the delivery evidence. OTHER_CODE_CHANGE names no mechanism, so no symptom can
// contradict it; NOT_IN_DIFF is an abstention (it cites nothing and shows nothing). The class "other" (a 5xx, a mixed record) is not
// in the plan's three: it accepts only those two, because no named mechanism is known to produce it.
const MECHANISMS: Record<SymptomClass, readonly Category[]> = {
  all_401: ["RAW_BODY_ALTERED", "WRONG_WEBHOOK_ID"],
  "2xx_but_books_unchanged": ["WORK_AFTER_ACK", "EVENT_TYPE_DROPPED"],
  "404_or_no_arrival": ["APP_OR_ENV_MISMATCH", "ENDPOINT_PATH_CHANGED"],
  other: [],
};
export const consistentWith = (cls: SymptomClass, category: Category): boolean => category === "OTHER_CODE_CHANGE" || category === "NOT_IN_DIFF" || MECHANISMS[cls].includes(category);

// What the model is told about the symptom: one fixed sentence per class, never a user's words.
export const SYMPTOM_SENTENCE: Record<SymptomClass, string> = {
  all_401: "Every delivery of the affected event was answered 401 by the shop's webhook route (the signature check failed).",
  "2xx_but_books_unchanged": "Every delivery was answered 2xx, but the shop's books do not match what PayPal says.",
  "404_or_no_arrival": "No delivery reached the shop's handler: PayPal got 404 or a redirect, or nothing arrived at all.",
  other: "Deliveries failed in a way that fits none of the other classes (for example a 5xx, another 4xx, or a mixed record).",
};

// The sentence on the card (plan 5.4 #4). "A changed line ..." because C1' and C2 only check consistency; the replay chip says whether it holds.
export const CAUSE_TEMPLATE: Record<Exclude<Category, "NOT_IN_DIFF">, string> = {
  RAW_BODY_ALTERED: "A changed line parses or rewrites the request body before the signature is checked, so the bytes that are verified are not the bytes PayPal signed.",
  WRONG_WEBHOOK_ID: "A changed line gives the signature check a webhook ID that is not the registered webhook's ID.",
  WORK_AFTER_ACK: "A changed line answers PayPal before the booking work is finished, so that work can be lost after the 200.",
  EVENT_TYPE_DROPPED: "A changed line stops an event type from being subscribed or handled, so those events never reach the books.",
  APP_OR_ENV_MISMATCH: "A changed line points payments at a different PayPal app or environment than the one the webhook is registered on.",
  ENDPOINT_PATH_CHANGED: "A changed line moves or redirects the URL PayPal calls, so deliveries no longer reach the handler.",
  OTHER_CODE_CHANGE: "A changed line looks like the cause, but it does not fit one of the named categories.",
};

export const NOT_PROVEN_TEXT = "Cause not proven.";
export const NOT_DIAGNOSED_TEXT = "Not diagnosed.";

// The symptom class, computed from the reporter's records of one event (plan 5.4 #2). Nothing in it comes from a person's words.
export function symptomClassOf(attempts: AttemptReport[] | null): SymptomClass {
  const answered = (attempts ?? []).filter((a) => a.state === "responded" && a.status !== undefined);
  if (!attempts || attempts.length === 0) return "404_or_no_arrival";
  if (answered.length !== attempts.length) return "other"; // an attempt that never answered (crash, still running)
  const codes = answered.map((a) => a.status!);
  if (codes.every((c) => c === 401)) return "all_401";
  if (codes.every((c) => c === 404 || c === 301 || c === 302 || c === 307 || c === 308)) return "404_or_no_arrival";
  if (codes.every((c) => c >= 200 && c < 300)) return "2xx_but_books_unchanged";
  return "other";
}
