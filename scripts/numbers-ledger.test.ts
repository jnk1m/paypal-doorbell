// The judge pack must not say more than the measurement files and the product say. What this test pins:
//   1. the ledger and the stories table in docs/judge-pack.md are exactly what scripts/numbers-ledger.ts computes from the files;
//   2. a figure cited as [G1] sits on a line that carries the ledger's exact text for G1, and every citation names a real row or log entry;
//   3. text in curly quotes is verbatim product text (the recorded stories, the certificate templates, the phrase tables);
//   4. none of the documents (README.md included) uses a word the product bans, a model name, or a company name;
//   5. a line of the pack with a digit in it has a citation or quotes the product; the video script's captions are short and carry no bare figure.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { MODEL_ID } from "../lib/core/llm.ts";
import { FOOTNOTE, header, owner, stampText } from "../lib/cert/templates.ts";
import { FORBIDDEN_WORDS, HONESTY, LIVE_LEAD, PITCH_LOOKS } from "../lib/ui/copy.ts";
import { NOT_DIAGNOSED_PHRASE, NOT_PROVEN_PHRASE, SCENARIO_LABEL, WAITING_PHRASE, evidenceWords, healWords, ringWords } from "../lib/ui/phrases.ts";
import { richText, type Rich } from "../lib/ui/rich.ts";
import { allStories } from "../lib/ui/source.ts";
import { LEDGER_END, LEDGER_START, PACK_PATH, STORIES_END, STORIES_START, blockOf, ledgerGroups, renderLedger, renderStories, unlistedStoryFiles } from "./numbers-ledger.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DOCS = { pack: PACK_PATH, script: join(ROOT, "docs", "video", "script-v1.md"), shotlist: join(ROOT, "docs", "video", "shotlist.md") };
const read = (p: string): string => readFileSync(p, "utf8");
// The private word list (company and personal names) lives outside the repo, in $HOME/.doorbell-private/forbidden-words.txt, the same file
// scripts/export-public.ts reads; nothing in it is written here, because this file is published. Absent (the public copy), only the model names are checked.
const PRIVATE_WORDS = join(homedir(), ".doorbell-private", "forbidden-words.txt");
const privateWords: string[] = existsSync(PRIVATE_WORDS)
  ? readFileSync(PRIVATE_WORDS, "utf8").split("\n").map((l) => l.trim().toLowerCase()).filter((l) => l !== "" && !l.startsWith("#"))
  : [];
const pack = read(PACK_PATH);
const present = Object.entries(DOCS).filter(([, p]) => existsSync(p));
const rows = ledgerGroups().flatMap((g) => g.rows);
const rowById = new Map(rows.map((r) => [r.id, r]));

// ---- 1. the generated blocks are current ---------------------------------------------------------------------------------------------------

test("the numbers ledger in the pack is what the script computes from the measurement files", () => {
  assert.equal(blockOf(pack, LEDGER_START, LEDGER_END), renderLedger(), "run `npx tsx scripts/numbers-ledger.ts` to rewrite docs/judge-pack.md");
});

test("the stories table in the pack is what the script computes from the recorded runs, and no recorded run is left out", () => {
  assert.equal(blockOf(pack, STORIES_START, STORIES_END), renderStories());
  assert.deepEqual(unlistedStoryFiles(), [], "a file in fixtures/recorded-run that the stories table does not list");
});

test("every ledger row names a source file that exists and a measured date", () => {
  for (const r of rows) {
    assert.ok(r.number.trim() !== "" && r.measures.trim() !== "", `${r.id} has a number and a description`);
    const files = r.source.split(":")[0].split(",").map((f) => f.trim());
    for (const f of files) {
      const path = f.startsWith("docs/") || f.startsWith("eval/") ? f : `docs/measurements/${f}`;
      assert.ok(existsSync(join(ROOT, path)), `${r.id}: ${path} does not exist`);
    }
    assert.match(r.date, /^\d{4}-\d{2}-\d{2}/, `${r.id} has a date`);
  }
});

// ---- 2. citations --------------------------------------------------------------------------------------------------------------------------

// The pack minus its two generated blocks and the code fences.
function proseLines(doc: string): { n: number; text: string }[] {
  const out: { n: number; text: string }[] = [];
  let skip: string | null = null;
  let fence = false;
  doc.split("\n").forEach((text, i) => {
    if (text.startsWith("```")) fence = !fence;
    else if (skip) {
      if (text.includes(skip)) skip = null;
    } else if (text.includes(LEDGER_START)) skip = LEDGER_END;
    else if (text.includes(STORIES_START)) skip = STORIES_END;
    else if (text.includes("<!-- n:ok:start -->")) skip = "<!-- n:ok:end -->";
    else if (!fence) out.push({ n: i + 1, text });
  });
  return out;
}
const CITE = /\[([GHCLP]\d{1,2})\]/g;
const LOG_CITE = /\[log-(\d+)\]/g;
const logDefined = new Set([...pack.matchAll(/^\d+\. \*\*\[log-(\d+)\]\*\*/gm)].map((m) => m[1]));

test("a figure cited from the ledger is on a line that carries the ledger's exact text, and every citation names a real row", () => {
  let cited = 0;
  for (const [name, path] of present) {
    const lines = name === "pack" ? proseLines(read(path)) : read(path).split("\n").map((text, n) => ({ n: n + 1, text }));
    for (const { n, text } of lines) {
      for (const m of text.matchAll(CITE)) {
        const row = rowById.get(m[1]);
        assert.ok(row, `${name}:${n}: [${m[1]}] is not a ledger row`);
        assert.ok(text.includes(row.number), `${name}:${n}: [${m[1]}] but the line does not say "${row.number}"`);
        cited++;
      }
      for (const m of text.matchAll(LOG_CITE)) assert.ok(logDefined.has(m[1]), `${name}:${n}: [log-${m[1]}] is not in the "from the log" list`);
    }
  }
  assert.ok(cited >= 20, `the pack cites the ledger ${cited} times`);
});

// ---- 3. verbatim product text --------------------------------------------------------------------------------------------------------------

type Piece = { text?: string } | string;
const isRun = (x: unknown): boolean => !!x && typeof x === "object" && "pieces" in (x as object) && "style" in (x as object);
function strings(v: unknown, out: string[]): void {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) {
    if (v.length > 0 && v.every(isRun)) out.push(richText(v as Rich));
    else v.forEach((x) => strings(x, out));
  } else if (v && typeof v === "object") Object.values(v as object).forEach((x) => strings(x, out));
}
const norm = (s: string): string => s.replace(/\s+/g, " ").trim();

function corpus(): string[] {
  const out: string[] = [];
  for (const story of allStories()) strings(story, out);
  out.push(HONESTY, PITCH_LOOKS, LIVE_LEAD, FOOTNOTE, stampText.amberEmpty(), header.empty());
  out.push(owner.checked(3, 3), owner.agree(3, 3), owner.limit(), owner.unsigned(), owner.healed(2, "96.00"), owner.gapsNeedAttention());
  out.push(...Object.values(WAITING_PHRASE), ...Object.values(NOT_PROVEN_PHRASE), ...Object.values(NOT_DIAGNOSED_PHRASE), ...Object.values(SCENARIO_LABEL));
  for (const cls of ["ACKED_BUT_NOT_APPLIED", "HANDLER_REJECTING", "NO_REPORT", "NO_EVENT_FOUND", "UNVERIFIED"] as const) {
    const w = evidenceWords({ cls, flag: undefined });
    out.push(w.title, w.explain);
  }
  for (const state of ["healed", "arrived", "unchanged", "lost", "sent"] as const) {
    const w = healWords({ state, sends: 3, arrivalSeconds: 2.5, answer: 200 }, state === "healed");
    out.push(w.title, w.detail);
  }
  for (const state of ["wait", "cannot_heal", "not_listed", "retries_pending", "in_progress"] as const) {
    const w = ringWords({ state, waitMs: 57_000, label: "" } as never, "refund");
    if (w.reason) out.push(w.reason);
  }
  return out.map(norm);
}

test("text in curly quotes is verbatim product text", () => {
  const known = corpus();
  let checked = 0;
  for (const [name, path] of present) {
    for (const m of read(path).matchAll(/“([^”]+)”/g)) {
      const quote = norm(m[1]);
      assert.ok(known.some((s) => s.includes(quote)), `${name}: this quoted text is not in the product: “${quote}”`);
      checked++;
    }
  }
  assert.ok(checked >= 30, `the documents quote the product ${checked} times`);
});

// ---- 4. words that are not allowed ---------------------------------------------------------------------------------------------------------

// README.md is public text too: it is held to the same word lists (only this test reads it).
const READMES: [string, string][] = existsSync(join(ROOT, "README.md")) ? [["README", join(ROOT, "README.md")]] : [];

test("no document uses a word the product bans, a model name, or a company name", () => {
  for (const [name, path] of [...present, ...READMES]) {
    const text = read(path).toLowerCase();
    for (const w of FORBIDDEN_WORDS) assert.ok(!text.includes(w), `${name} contains the banned word "${w}"`);
    for (const w of [MODEL_ID.toLowerCase(), "claude-", "sonnet", "opus"]) assert.ok(!text.includes(w), `${name} contains "${w}"`);
    privateWords.forEach((w, i) => assert.ok(!text.includes(w), `${name} contains private word #${i + 1}`));
  }
});

// ---- 5. figures and captions ---------------------------------------------------------------------------------------------------------------

const stripped = (t: string): string =>
  t
    .replace(/<!--.*?-->/g, "")
    .replace(/“[^”]*”/g, "")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/`[^`]*`/g, "")
    .replace(/^\s*\d+\.\s/, "");

const HAS_CITE = /\[[GHCLP]\d{1,2}\]|\[log-\d+\]/;

test("a line of the pack with a figure in it cites the ledger or the log, or quotes the product", () => {
  for (const { n, text } of proseLines(pack)) {
    if (text.startsWith("#") || text.includes("<!-- n:ok -->") || HAS_CITE.test(text)) continue;
    assert.ok(!/\d/.test(stripped(text)), `docs/judge-pack.md:${n} has a figure that no ledger row or log entry stands behind: ${text.slice(0, 140)}`);
  }
});

const scriptPath = DOCS.script;
test("the video script's captions are short, and carry no figure that is not cited or quoted", { skip: !existsSync(scriptPath) }, () => {
  const lines = read(scriptPath).split("\n");
  let captionLines = 0;
  lines.forEach((text, i) => {
    const m = text.match(/^\*\*(Caption|Card)\*\*:?\s*(.*)$/);
    if (!m) return;
    const body = m[2].trim();
    for (const part of body.split(" / ")) {
      const words = part.trim().split(/\s+/).filter(Boolean);
      assert.ok(words.length <= 9, `script-v1.md:${i + 1}: a caption line of ${words.length} words: ${part}`);
      captionLines++;
    }
    const bare = stripped(body).replace(/\$\d+/g, ""); // a dollar amount is one the screen shows
    assert.ok(!/\d/.test(bare) || HAS_CITE.test(body), `script-v1.md:${i + 1}: a caption with an uncited figure: ${body}`);
  });
  assert.ok(captionLines > 0 && captionLines <= 14, `the script has ${captionLines} caption lines; the plan allows 12 subtitle lines, with room for two more`);
});
