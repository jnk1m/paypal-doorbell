// The webhook handler of a shop of your own, reporting to a Doorbell you run yourself (README, "For a shop of your own").
// An example to copy the shape from, not a package. The two calls that matter are numbered. Everything else, the signature check with
// PayPal's verify-webhook-signature call and the books, is your shop's own and stays yours.
//
// To watch reports arrive at your Doorbell with a stand-in shop that accepts every delivery and books nothing:
//   DOORBELL_URL=https://your-doorbell.example DOORBELL_REPORTER_SECRET=<the same 32+ characters as on the Doorbell> npx tsx examples/your-shop/webhook.ts
// then point a PayPal Sandbox webhook (or a tunnel) at http://<this machine>:3001/webhook.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { HttpReporter } from "../../lib/shop/http-reporter.ts";

export interface YourShop {
  verify(rawBody: string, headers: IncomingMessage["headers"]): Promise<boolean>; // PayPal's verify-webhook-signature, with your webhook id
  book(event: { id: string; event_type: string; resource: Record<string, unknown> }): Promise<void>; // write your books
}

const MAX_BODY_BYTES = 64 * 1024;

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).byteLength;
    if (size > MAX_BODY_BYTES) throw new Error(`body is over ${MAX_BODY_BYTES} bytes`);
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function webhookOf(shop: YourShop, reporter: HttpReporter) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const raw = await readBody(req).catch(() => "");
    const tid = String(req.headers["paypal-transmission-id"] ?? "");
    let eventId = "";
    try {
      eventId = String(JSON.parse(raw).id ?? "");
    } catch {
      // not JSON: not a PayPal delivery, answered below
    }
    if (!tid || !eventId) {
      res.writeHead(400).end();
      return;
    }

    // 1. First thing: the delivery has reached you. If the Doorbell is down the reporter logs that and returns; your shop goes on.
    const attempt = await reporter.received(tid, eventId);
    let status = 500;
    try {
      if (!(await shop.verify(raw, req.headers))) {
        status = 401;
        return;
      }
      await shop.book(JSON.parse(raw));
      status = 200;
    } finally {
      // 2. Always, in a finally: what you answered. A handler that dies before this line leaves a received line with no responded
      //    line, which Doorbell reads as "arrived and then crashed", not as "never arrived".
      await reporter.responded(tid, status, attempt);
      res.writeHead(status).end();
    }
  };
}

if (process.argv[1]?.endsWith("your-shop/webhook.ts")) {
  const url = process.env.DOORBELL_URL;
  const secret = process.env.DOORBELL_REPORTER_SECRET;
  if (!url || !secret) throw new Error("set DOORBELL_URL and DOORBELL_REPORTER_SECRET (see the top of this file)");
  const reporter = new HttpReporter({ url: `${url.replace(/\/$/, "")}/api/report`, secret });
  const standIn: YourShop = { verify: async () => true, book: async () => undefined };
  createServer(webhookOf(standIn, reporter)).listen(3001, () => console.log("stand-in shop listening on http://localhost:3001/webhook"));
}
