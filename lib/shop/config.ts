// Wires the shop to the environment. The deployment acts as one Sandbox app: PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET are that app's
// keys (Vercel production holds the demo app's; the dev app's stay on the developer's machine, plan 9.10).
import { PaypalClientDisputeReads } from "../gaps/disputes.ts";
import { PaypalClientReads } from "../gaps/reads.ts";
import type { ScanDeps } from "../gaps/scan.ts";
import { PaypalClient } from "../pay/paypal.ts";
import { witnessFromEnv } from "../witness/config.ts";
import { reverifyQuarantined, type WitnessDeps } from "../witness/receive.ts";
import { noteWhatWitnessHeard } from "./heard.ts";
import type { ReportIntakeDeps } from "./report-intake.ts";
import { MIN_SECRET_LENGTH } from "./report-signature.ts";
import { InProcessReporter } from "./reporter.ts";
import { shopStoreFromEnv } from "./store-env.ts";
import type { ShopStore } from "./store.ts";
import type { ShopWebhookDeps } from "./webhook.ts";

// The webhook route has 10 s in all (maxDuration): the verify call and the token request each get 4 s.
const WEBHOOK_PAYPAL_TIMEOUT_MS = 4000;
const API_PAYPAL_TIMEOUT_MS = 12_000;
const WEBHOOK_ID = /^[A-Za-z0-9]{10,30}$/;

let apiClient: PaypalClient | undefined;
export function shopApiFromEnv(): { store: ShopStore; client: PaypalClient; liveToken: string | undefined } {
  apiClient ??= PaypalClient.fromEnv(process.env, { timeoutMs: API_PAYPAL_TIMEOUT_MS });
  return { store: shopStoreFromEnv(), client: apiClient, liveToken: process.env.DOORBELL_LIVE_TOKEN };
}

// The other webhook's id that the setting-bug mode checks deliveries against: the witness webhook D, which is on the same app and is already
// configured. undefined when it is not set (or malformed): the mode route then refuses the mode, and the webhook refuses to run it.
export function settingWebhookIdFromEnv(env: Record<string, string | undefined> = process.env): string | undefined {
  const id = env.PAYPAL_WITNESS_WEBHOOK_ID;
  // the same id as the shop's own would verify every delivery: the "setting bug" would quietly be the working shop, labelled planted
  return id && WEBHOOK_ID.test(id) && id !== env.PAYPAL_SHOP_WEBHOOK_ID ? id : undefined;
}

let webhook: ShopWebhookDeps | undefined;
export function shopWebhookFromEnv(): ShopWebhookDeps {
  if (webhook) return webhook;
  const webhookId = process.env.PAYPAL_SHOP_WEBHOOK_ID;
  if (!webhookId || !WEBHOOK_ID.test(webhookId)) throw new Error("PAYPAL_SHOP_WEBHOOK_ID is not set or malformed: the shop cannot verify deliveries without its webhook id");
  const client = PaypalClient.fromEnv(process.env, { timeoutMs: WEBHOOK_PAYPAL_TIMEOUT_MS });
  const store = shopStoreFromEnv();
  webhook = { webhookId, settingWebhookId: settingWebhookIdFromEnv(), store, reporter: new InProcessReporter(store), verify: (p) => client.verifyWebhookSignature(p, WEBHOOK_PAYPAL_TIMEOUT_MS) };
  return webhook;
}

// The report intake for a shop of your own (report-intake.ts). Open only with DOORBELL_REPORTER_SECRET of 32 characters or more; the
// hosted demo sets none, so its intake answers 404 and never touches the store. A short secret is reported once and treated as none.
let intake: ReportIntakeDeps | undefined;
export function reportIntakeFromEnv(): ReportIntakeDeps {
  if (intake) return intake;
  const secret = process.env.DOORBELL_REPORTER_SECRET;
  if (secret && secret.length < MIN_SECRET_LENGTH) console.error(JSON.stringify({ route: "api/report", outcome: "closed", reason: `DOORBELL_REPORTER_SECRET is shorter than ${MIN_SECRET_LENGTH} characters; the intake stays closed` }));
  intake = secret && secret.length >= MIN_SECRET_LENGTH ? { secret, store: shopStoreFromEnv() } : {};
  return intake;
}

// The gap finder: PayPal reads and resends with the demo app's keys, the shop's store, the shop webhook S (the resend target), and the
// witness quarantine's re-verify that every scan calls. Every scan also asks PayPal for the disputes of each capture (read only; the shop keeps no
// dispute book, so there is no `booked`). If the app has no right to the disputes API the scan counts the lists it could not read and goes on.
const REVERIFY_EVERY_MS = 30_000; // per server instance; the scan itself runs far more often
const REVERIFY_MAX_ENTRIES = 5; // each entry is one verify call (the budget is 60 a minute)
let gaps: ScanDeps | undefined;
let witness: WitnessDeps | undefined;
let lastReverify = 0;
export function gapsFromEnv(): ScanDeps {
  if (gaps) return gaps;
  const shopWebhookId = process.env.PAYPAL_SHOP_WEBHOOK_ID;
  if (!shopWebhookId || !WEBHOOK_ID.test(shopWebhookId)) throw new Error("PAYPAL_SHOP_WEBHOOK_ID is not set or malformed: a resend needs the shop's webhook id");
  const store = shopStoreFromEnv();
  const client = PaypalClient.fromEnv(process.env, { timeoutMs: API_PAYPAL_TIMEOUT_MS });
  gaps = {
    store,
    reads: new PaypalClientReads(client),
    disputes: { reads: new PaypalClientDisputeReads(client) },
    shopWebhookId,
    log: (line) => console.log(JSON.stringify({ route: "gaps", ...line })),
    reverify: async () => {
      if (Date.now() - lastReverify < REVERIFY_EVERY_MS) return { skipped: "ran less than 30 s ago on this instance" };
      lastReverify = Date.now();
      // The same witness the receiver route builds, with the same hook, so a delivery that verifies late is noted for the shop as well.
      witness ??= { ...witnessFromEnv(), onVerified: noteWhatWitnessHeard(store) };
      return reverifyQuarantined(witness, { max: REVERIFY_MAX_ENTRIES });
    },
  };
  return gaps;
}
