// Shared shapes of the demo shop "Maple Mug". The shop is fictional and runs on Sandbox only (plan 5.6).

// The shop's webhook handler runs in one of four code modes, chosen per session and read on every request.
// "good" is the working handler; the other three are bugs we planted on purpose, each in a real file under handlers/.
export const MODES = ["good", "ack_then_drop", "bad_body", "last_write_wins"] as const;
export type CodeMode = (typeof MODES)[number];
export type PlantedMode = Exclude<CodeMode, "good">;

// A fifth kind of mode: a deploy whose code change is harmless (handlers/tidy.ts only rewords a comment) while a SETTING is wrong. The shop's
// webhook route verifies the signature against another webhook of the same PayPal app, so every delivery is answered 401. The diff holds no
// code line, so the cause step can name nothing. It is not a PlantedMode: replay.ts, confirm.ts and the cause tests are keyed by the three code bugs.
export const SETTING_MODES = ["wrong_webhook_id_setting"] as const;
export type SettingMode = (typeof SETTING_MODES)[number];
export const isSettingBug = (m: Mode): m is SettingMode => (SETTING_MODES as readonly string[]).includes(m);
// A bug planted in a handler file (one of the three code bugs): the modes the replay and its confirmation are built for.
export const isPlanted = (m: Mode): m is PlantedMode => m !== "good" && !isSettingBug(m);

export type Mode = CodeMode | SettingMode;
export const ALL_MODES: readonly Mode[] = [...MODES, ...SETTING_MODES];
export const isMode = (v: unknown): v is Mode => typeof v === "string" && (ALL_MODES as readonly string[]).includes(v);

// Everything we broke on purpose, whether in the code or in a setting: the modes that wear the "planted by us" label.
export type BrokenMode = PlantedMode | SettingMode;
export const isBroken = (m: Mode): m is BrokenMode => m !== "good";

export type BookState = "paid" | "refunded";

// What the shop's books say about one order (one PayPal capture).
export interface BookEntry {
  state: BookState;
  amount: string; // "48.00", as PayPal wrote it in the event
  eid: string; // the event that last changed this entry
  at: number;
}

// An order as the shop recorded it when it created it (not what PayPal says now).
export interface OrderRecord {
  n: number;
  item: string;
  amount: string;
  orderId: string;
  captureId: string;
  invoiceId: string;
  at: number;
  refund?: { id: string; invoiceId: string; at: number };
}

// What a webhook handler gets. It never touches PayPal or Redis directly.
export interface HandlerContext {
  rawBody: string; // the request body exactly as PayPal sent it
  verify: (event: unknown) => Promise<string | undefined>; // PayPal's verification_status for this delivery's headers and this event
  books: {
    get: (captureId: string) => Promise<BookEntry | null>;
    set: (captureId: string, entry: BookEntry) => Promise<void>;
  };
  now: () => number;
}

export interface HandlerResult {
  status: number;
}

export type Handler = (ctx: HandlerContext) => Promise<HandlerResult>;

// A handler file's module: the function that runs, and the address of the file it came from (so a test can tie the code that
// runs to the file a diff was computed from).
export interface HandlerModule {
  handleWebhook: Handler;
  SOURCE: string;
}

// One "Ring again" (R5): what was resent for one event, and where it stands. The scan moves it along; nothing else writes it.
//   sent      PayPal accepted a resend; the delivery has not reached the shop yet
//   arrived   a delivery with a new transmission id reached the shop; the books are not yet seen to agree with PayPal
//   healed    after the resend arrived, the books changed and now agree with PayPal's own answer
//   unchanged the resent delivery arrived and was answered, and the books still differ
//   lost      no delivery arrived within 60 s of the last resend, after every allowed retry
export type HealState = "sent" | "arrived" | "healed" | "unchanged" | "lost";
export interface HealRecord {
  eid: string;
  captureId: string;
  kind: "completed" | "refunded";
  state: HealState;
  seen: string[]; // transmission ids the shop had for this event when the ring was pressed, so a new one is the resent delivery
  sends: number[]; // when PayPal accepted each resend, ms
  booksBefore: { state: BookState; eid: string; at: number } | null;
  arrivedAt?: number; // when the first resent delivery reached the shop
  answer?: number; // what the shop answered to it
  healedAt?: number;
}
