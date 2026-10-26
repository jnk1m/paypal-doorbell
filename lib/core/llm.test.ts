// Record/replay plumbing and prompt shape, with a mock model. No key, no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockLanguageModelV4 } from "ai/test";
import { z } from "zod";
import { callLlm, hasRecordings, RecordingMissingError, requestHash, type LlmRequest } from "./llm.ts";

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 10, text: 10, reasoning: undefined },
};
const mockModel = (json: unknown) =>
  new MockLanguageModelV4({
    doGenerate: async () => ({
      content: [{ type: "text", text: JSON.stringify(json) }],
      finishReason: { unified: "stop", raw: undefined },
      usage,
      warnings: [],
    }),
  });
const tmp = () => mkdtempSync(join(tmpdir(), "recordings-"));

const Schema = z.object({ answer: z.string() });
const req: LlmRequest = { task: "cause", version: "test-v1", system: "system text", prompt: "diff text" };

test("record writes <hash>.json, replay returns it without a model", async () => {
  const dir = tmp();
  try {
    assert.equal(hasRecordings(dir), false);
    const live = await callLlm(req, Schema, { mode: "record", dir, model: mockModel({ answer: "a" }) });
    assert.deepEqual(live, { answer: "a" });
    assert.deepEqual(readdirSync(dir), [`${requestHash(req)}.json`]);
    assert.equal(hasRecordings(dir), true);
    const saved = JSON.parse(readFileSync(join(dir, `${requestHash(req)}.json`), "utf8"));
    assert.equal(saved.system, "system text");
    assert.equal(saved.model, "claude-sonnet-5-5");
    assert.deepEqual(await callLlm(req, Schema, { mode: "replay", dir }), { answer: "a" });
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("live mode answers from the model and writes nothing", async () => {
  const dir = tmp();
  try {
    assert.deepEqual(await callLlm(req, Schema, { mode: "live", dir, model: mockModel({ answer: "b" }) }), { answer: "b" });
    assert.deepEqual(readdirSync(dir), []);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("replay with a changed prompt fails and says how to re-record", async () => {
  const dir = tmp();
  try {
    await callLlm(req, Schema, { mode: "record", dir, model: mockModel({ answer: "a" }) });
    const changed = { ...req, system: "system text, edited" };
    assert.notEqual(requestHash(changed), requestHash(req));
    await assert.rejects(callLlm(changed, Schema, { mode: "replay", dir }), (e: unknown) => {
      assert.ok(e instanceof RecordingMissingError);
      assert.match(e.message, /RECORD=1/);
      assert.match(e.message, /prompt version test-v1/);
      return true;
    });
    const bumped = { ...req, version: "test-v2" };
    assert.notEqual(requestHash(bumped), requestHash(req));
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("the key covers the model id, prompt version, system prompt and prompt", () => {
  const base = requestHash(req);
  assert.notEqual(requestHash({ ...req, version: "x" }), base);
  assert.notEqual(requestHash({ ...req, system: "x" }), base);
  assert.notEqual(requestHash({ ...req, prompt: "x" }), base);
  assert.notEqual(requestHash(req, "another-model"), base);
});

test("record and live need a key when no model is injected", async () => {
  const saved = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    await assert.rejects(callLlm(req, Schema, { mode: "record", dir: tmp() }), /needs ANTHROPIC_API_KEY/);
  } finally {
    if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
  }
});

test("a model answer that breaks the schema is an error, not a claim", async () => {
  await assert.rejects(callLlm(req, Schema, { mode: "live", model: mockModel({ wrong: 1 }) }));
});
