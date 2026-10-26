// Run after changing the public URL or the event list: node scripts/register-webhook.js
import { config } from "../src/config.js";
import { paypalToken } from "../src/payments/token.js";

const URL_ = "https://shop.example.com/api/paypal/webhook";
const EVENT_TYPES = [
  { name: "PAYMENT.CAPTURE.COMPLETED" },
  { name: "PAYMENT.CAPTURE.REFUNDED" },
  { name: "PAYMENT.CAPTURE.DENIED" },
];

const res = await fetch(`${config.paypal.base}/v1/notifications/webhooks`, {
  method: "POST",
  headers: { Authorization: `Bearer ${await paypalToken()}`, "Content-Type": "application/json" },
  body: JSON.stringify({ url: URL_, event_types: EVENT_TYPES }),
});
console.log(res.status, await res.text());
