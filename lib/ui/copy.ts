// Fixed copy of the screens that is not a phrase of a closed vocabulary (those are in phrases.ts and glossary.ts, and the chapters' own
// sentences are templates in story.ts). English only.
// Words the product never uses (plan 14 #3, R9): complete, nothing missing, all tied, every, no gaps, all clear, fully; and never a claim
// that PayPal "lost" an event. copy.test.ts scans this file's constants, the phrases, and the rendered pages for them.

import { PLANTED_LABEL } from "../shop/mode-files.ts";

export const FORBIDDEN_WORDS = ["complete", "nothing missing", "all tied", "every", "no gaps", "all clear", "fully", "lost it", "paypal lost"] as const;

// The sentence that is always on screen, in the top bar of every page (it sticks while the page scrolls).
export const HONESTY = "Sandbox demo · fictional shop · PayPal test money · bugs are planted by us";
// Said next to every bug the shop runs on purpose: the one label of lib/shop/mode-files.ts.
export const PLANTED = PLANTED_LABEL;
export const SHOP_NAME = "Maple Mug";

// What Doorbell is: one sentence that says it, then four beats that say what it does. The phone sets the beats one under the other.
export const PITCH_FIRST = "Doorbell is the tool that looks.";
export const PITCH_BEATS = ["finds the PayPal webhooks your shop never heard or never saved,", "has an AI point at the changed line of your code behind it,", "rings them again,", "and tells you exactly ==what it still cannot prove==."] as const;
export const PITCH_LOOKS = `${PITCH_FIRST} It ${PITCH_BEATS.join(" ")}`;

// ---- the live lane ---------------------------------------------------------------------------------------------------------------------

// Measured on the deployed shop (S3/S5): a gap is called 3–60 s after the witness hears the event, and Ring again reaches a tied row in a
// median 89 s (7–287 s). "About 60 s" was the hope, not the measurement.
export const LIVE_TAKES = "a few minutes";
export const LIVE_LEAD = "A live run against PayPal's Sandbox; it takes a few minutes, because PayPal delivers and lists events on its own clock. You place an order, plant a bug and refund the order, and Doorbell finds out whether the shop's books heard about it. Each bug is one we planted, and the shop is fictional.";

// The five steps of the judge's lane, left column. Each is a heading and a line of what it does; the controls are the lane's own.
export const LIVE_STEPS = [
  { title: "Enter the token", line: "The judge token opens a session on PayPal's Sandbox. It stays in this browser tab and is sent only to this site." },
  { title: "Place an order", line: "Buy something from the shop. PayPal takes test money." },
  { title: "Turn on a bug", line: "Pick one of the bugs we planted in the shop's webhook, in its code or in its settings. The working handler is the fix." },
  { title: "Refund it", line: "Ask PayPal to refund the latest order. The shop's books are supposed to hear about it." },
  { title: "Run Doorbell", line: "Doorbell checks each capture at PayPal again and finds the gaps. A gap is called only once PayPal has had time to deliver and list the event: from a few seconds to about a minute." },
] as const;

// What the control the judge pressed says while its request is out (plain text, no spinner), and how a request that failed begins.
export const LIVE_PENDING = {
  start: "Opening a session…",
  order: "Placing the order with PayPal…",
  mode: "Switching the shop's handler…",
  refund: "Asking PayPal to refund…",
  ring: "Asking PayPal to send it again…",
  run: "Checking the books against PayPal…",
} as const;
export const LIVE_FAILED = {
  start: "The session could not be opened.",
  order: "The order request failed.",
  mode: "The handler change failed.",
  refund: "The refund request failed.",
  ring: "The Ring again request failed.",
  run: "The check failed.",
} as const;

export const UNAVAILABLE_NOTICE = "The live lane is not available, so this is the recorded run.";
export const PAUSED_NOTICE = "The live lane is at its limit for now, so this is the recorded run.";
export const TOKEN_REJECTED = "That token was not accepted.";

// ---- quiet states (the gallery shows them) -------------------------------------------------------------------------------------------------

export const NO_ORDERS_TITLE = "No orders yet";
export const NO_ORDERS_BODY = "Doorbell has nothing to check until the shop sells something. Place an order to start.";

export const SILENT_TITLE = "The witness has been silent";
export const SILENT_BODY = "Silence is not health. With no recent delivery there is nothing to compare PayPal's events list against, so this run cannot say the witness is working.";

export const NOT_SIGNED = "This certificate is not signed. Anyone could write one like it; check the numbers against PayPal.";

export const OWNER_TITLE = "For the shop owner";
export const OWNER_INTRO = "This page says what Doorbell checked, in plain words.";
