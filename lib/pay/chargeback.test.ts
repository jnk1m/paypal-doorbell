import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chargebackBody, type ChargebackInput } from "./chargeback.ts";

const at = Date.parse("2026-10-20T08:35:21.437Z");
const input = (over: Partial<ChargebackInput> = {}): ChargebackInput => ({ merchantId: "ABCDEF1234567", captureId: "46E84226B1829180C", amount: "48.00", at, respondWithinDays: 10, digits: (n) => "7".repeat(n), ...over });

test("the body is the one the probe sent on 2026-10-20 (the call that made 5 disputes): the capture, the amount, the times and the requested response date", () => {
  assert.deepEqual(chargebackBody(input()), {
    adjacency: "PAYPAL",
    file_layout: "ATCK_CB",
    merchant_id: "ABCDEF1234567",
    financial_institution: { processor: "FDMS" },
    transaction: { id_enc: "46E84226B1829180C", amount: { currency_code: "USD", value: "48.00" } },
    instrument: { instrument_type: "CARD", card_brand: "VISA", credit_card_transaction_id: "7777777777777777", external: false },
    dispute: {
      id: null,
      stage: "CHARGEBACK",
      response_date: "2026-10-30T08:35:21.437Z",
      status: "2",
      amount: { currency_code: "USD", value: "48.00" },
      receive_date: "2026-10-20T08:35:21.437Z",
      event_code: "CHARGEBACK_INITIATED",
      money_movement_date: "2026-10-20T08:35:21.437Z",
      event_type: "DEBIT",
      chargeback_type: "REPORTED_TO_PROCESSOR",
      processor_info: { reference_number: "77777777777777777777777", reason_code: "1330", notes: "TEST_MEMO" },
    },
  });
});

test("the digits asked for are 16 for the card transaction and 23 for the processor reference", () => {
  const asked: number[] = [];
  chargebackBody(input({ digits: (n) => (asked.push(n), "1".repeat(n)) }));
  assert.deepEqual(asked, [16, 23]);
});

test("an id, an amount or a number of days that could not be right is refused before anything is built", () => {
  assert.throws(() => chargebackBody(input({ merchantId: "../x" })), /merchant id is malformed/);
  assert.throws(() => chargebackBody(input({ captureId: "46E8/../v1" })), /capture id is malformed/);
  assert.throws(() => chargebackBody(input({ amount: "48" })), /is not money/);
  assert.throws(() => chargebackBody(input({ respondWithinDays: 0 })), /not 1 to 30/);
  assert.throws(() => chargebackBody(input({ respondWithinDays: 2.5 })), /not 1 to 30/);
});

// A chargeback is a write to the Sandbox that makes a test dispute. The product (every route, every module a route can reach) never sends one: the
// only place that does is the recording script, and nothing under app/ or lib/ imports this module or names the endpoint.
test("nothing under app/ or lib/ imports the chargeback body or names the process-chargeback endpoint", () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.(ts|tsx)$/.test(name) && !/^chargeback\.(test\.)?ts$/.test(name) && /pay\/chargeback|process-chargeback/.test(readFileSync(path, "utf8"))) found.push(path.slice(root.length + 1));
    }
  };
  walk(join(root, "app"));
  walk(join(root, "lib"));
  assert.deepEqual(found, []);
});
