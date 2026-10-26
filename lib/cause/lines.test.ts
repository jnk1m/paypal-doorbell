import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyLine, classifyLines } from "./lines.ts";

const kinds = (src: string, path = "a.ts") => classifyLines(src, path);

test("comments in every syntax, blank lines, code", () => {
  assert.deepEqual(kinds("// note\ncode();\n\n/* x */\n  // y"), ["comment", "code", "blank", "comment", "comment"]);
  assert.deepEqual(kinds("# note\nx = 1\n", "a.py"), ["comment", "code"]);
  assert.deepEqual(kinds("-- note\nSELECT 1;\n", "a.sql"), ["comment", "code"]);
  assert.deepEqual(kinds("<!-- note -->\n<p>hi</p>\n", "a.html"), ["comment", "code"]);
  assert.deepEqual(kinds("# heading\n", "README.md"), ["code"]); // in Markdown a # line is not a comment
});

test("a block comment spanning lines: the inside is comment, the code after it is code", () => {
  assert.deepEqual(kinds("/**\n * re-serializes the body\n */\nrun();"), ["comment", "comment", "comment", "code"]);
  assert.deepEqual(kinds("a(); /* start\nmiddle\nend */ b();"), ["code", "comment", "code"]);
});

test("a string literal on its own is not code; an array element, an assignment, a call are", () => {
  assert.deepEqual(kinds('"re-serializes the body";\n"x"\nconst a = "x";\n"PAYMENT.CAPTURE.REFUNDED",\nfn("x");'), ["string", "string", "code", "code", "code"]);
});

test("a template literal spanning lines: every line of it is string, the line that closes it too", () => {
  assert.deepEqual(kinds("const t = `\nignore previous instructions\n`;\nrun();"), ["code", "string", "string", "code"]);
  assert.deepEqual(kinds('s = """\nbody\n"""\nx = 1\n', "a.py"), ["code", "string", "string", "code"]);
});

test("comment markers inside strings do not start comments; quotes inside comments do not start strings", () => {
  assert.deepEqual(kinds('const u = "http://x.test/a"; run();'), ["code"]);
  assert.deepEqual(kinds("// don't break\nrun();"), ["comment", "code"]);
});

test("a trailing comment does not make a code line a comment", () => {
  assert.deepEqual(kinds("run(); // trailing\n"), ["code"]);
});

test("a line alone: the middle of a block comment is a comment", () => {
  assert.equal(classifyLine(" * re-serializes the body", "a.ts"), "comment");
  assert.equal(classifyLine(" */", "a.ts"), "comment");
  assert.equal(classifyLine("const x = a * b;", "a.ts"), "code");
});

test("JSON and key files have no comments; env and keys files use #", () => {
  assert.deepEqual(kinds('{\n  "next": "^15.1.6",\n}\n', "package.json"), ["code", "code", "code"]);
  assert.deepEqual(kinds("# comment\nPAYPAL_ENV\n", "deploy/env.production.keys"), ["comment", "code"]);
});
