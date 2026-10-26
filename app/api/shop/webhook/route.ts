// The shop's webhook endpoint (S). PayPal posts the shop's events here; the session's mode picks the handler file that runs.
import { shopWebhookFromEnv } from "../../../../lib/shop/config.ts";
import { handleShopDelivery } from "../../../../lib/shop/webhook.ts";
import { handle } from "../../../../lib/web/http.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 10;

export function POST(req: Request): Promise<Response> {
  return handle("api/shop/webhook", () => handleShopDelivery(req, shopWebhookFromEnv()));
}
