// The look is app/tokens.css, and these tests read it:
//   - every text color against the background it is printed on is at least 4.5:1, and the marks and lines at least 3:1;
//   - green exists only behind [data-cert="green"], so nothing on the page can be green unless the certificate says green;
//   - app/globals.css (structure and component classes) holds no color, font size, radius or shadow of its own: it reads tokens;
//   - the design's own limits hold in the stylesheet: two weights, six sizes, no tracked capitals, no decoration.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const app = join(dirname(fileURLToPath(import.meta.url)), "../../app");
const tokens = readFileSync(join(app, "tokens.css"), "utf8");
const globals = readFileSync(join(app, "globals.css"), "utf8");
const strip = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, "");

const vars = (css: string): Record<string, string> => Object.fromEntries([...css.matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)].map((m) => [m[1], m[2]]));
const c = vars(strip(tokens));

const lum = (h: string): number => {
  const k = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * k[0] + 0.7152 * k[1] + 0.0722 * k[2];
};
const ratio = (a: string, b: string): number => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

const TEXT: [string, string][] = [
  ["ink", "page"],
  ["ink-2", "page"],
  ["mute", "page"],
  ["ink", "panel"],
  ["ink-2", "panel"],
  ["mute", "panel"],
  ["red", "page"], // the word Gap, a rejected line
  ["red", "panel"],
  ["green", "page"], // the word Tied, only when the certificate says green
  ["green", "panel"],
  ["ink", "yellow"], // the Ring again button
  ["ink-2", "yellow-soft"], // the button when it is switched off
  ["ink", "marker"], // the highlighter
  ["page", "ink"], // a glossary line
];
const MARKS: [string, string][] = [
  ["edge", "page"], // the border of a control
  ["rail", "panel"], // the dashed road of the path
  ["red", "panel"], // the mark of a hop that went wrong
  ["green", "panel"],
  ["ink", "panel"],
];

test("text is at least 4.5:1 on the background it is printed on", () => {
  const fails: string[] = [];
  for (const [fg, bg] of TEXT) {
    assert.ok(c[fg] && c[bg], `${fg} or ${bg} is not defined in tokens.css`);
    const r = ratio(c[fg], c[bg]);
    if (r < 4.5) fails.push(`${fg} on ${bg}: ${r.toFixed(2)} < 4.5`);
  }
  assert.deepEqual(fails, []);
});

test("marks and lines are at least 3:1 on the panel or the page they sit on", () => {
  const fails: string[] = [];
  for (const [fg, bg] of MARKS) {
    const r = ratio(c[fg], c[bg]);
    if (r < 3) fails.push(`${fg} on ${bg}: ${r.toFixed(2)} < 3`);
  }
  assert.deepEqual(fails, []);
});

test("the palette is white, one cool grey, navy ink and one yellow: red and green are for status marks only", () => {
  assert.deepEqual(Object.keys(c).sort(), ["edge", "green", "ink", "ink-2", "marker", "mute", "page", "panel", "rail", "red", "yellow", "yellow-soft"]);
  assert.equal(c.page, "#ffffff");
  assert.equal(c.yellow.toLowerCase(), "#ffc933");
});

test("green exists only behind [data-cert=\"green\"]: defined once, used once, and nowhere in the component classes", () => {
  const t = strip(tokens);
  const uses = [...t.matchAll(/var\(--green\)/g)].length;
  assert.equal(uses, 1, "var(--green) is used once in tokens.css");
  const at = t.indexOf('[data-cert="green"]');
  assert.ok(at > 0);
  assert.match(t.slice(at), /^\[data-cert="green"\]\s*\{\s*--ok:\s*var\(--green\);\s*\}/);
  const g = strip(globals);
  assert.ok(!g.includes("--green"), "globals.css never names green");
  assert.ok(!g.toLowerCase().includes(c.green.toLowerCase()), "the green hex is not repeated");
  assert.ok(!/\bgreen\b/i.test(g), "the word green is not in a rule");
  // the one default of the check mark is navy
  assert.match(t, /--ok:\s*var\(--ink\)/);
});

test("globals.css has no color of its own: every color is a token", () => {
  const css = strip(globals);
  assert.deepEqual([...css.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((m) => m[0]), [], "a hex color in globals.css");
  assert.deepEqual([...css.matchAll(/\b(?:rgb|rgba|hsl|hsla|oklch|oklab|lab|lch|color-mix)\(/g)].map((m) => m[0]), [], "a color function in globals.css");
});

test("globals.css reads type sizes, radius and shadow from tokens", () => {
  const css = strip(globals);
  assert.deepEqual([...css.matchAll(/font-size:\s*[\d.]+(?:px|rem|em)/g)].map((m) => m[0]), [], "a literal font-size: use a --text-* token");
  assert.deepEqual([...css.matchAll(/border-radius:\s*[\d.]+px/g)].map((m) => m[0]), [], "a literal radius: use a --radius token");
  assert.deepEqual([...css.matchAll(/box-shadow:\s*([^;]+)/g)].map((m) => m[1]).filter((v) => !/^(var\(|none)/.test(v.trim())), [], "a literal shadow: use a token");
});

test("the tokens a look is built from are all defined", () => {
  const defined = new Set([...tokens.matchAll(/(--[\w-]+):/g)].map((m) => m[1]));
  const used = new Set([...globals.matchAll(/var\((--[\w-]+)/g)].map((m) => m[1]));
  const local = new Set([...globals.matchAll(/(--[\w-]+):/g)].map((m) => m[1])); // set inside globals.css itself (--fd, --dot-y ...)
  // defined by next/font on <html>, or set by a component on its own element (the road's fill time, the message's place, the order of the replay,
  // the page's own measure of the height at which a chapter's headline starts, and the phone strip's: where a stop stands and how long a link takes to fill)
  const external = new Set(["--font-bricolage", "--font-dm-mono", "--fd", "--fdl", "--dot-ms", "--dot-y", "--i", "--lead-in", "--x", "--y", "--d", "--dl"]);
  assert.deepEqual([...used].filter((u) => !defined.has(u) && !local.has(u) && !external.has(u)), []);
});

test("two weights and six sizes", () => {
  const css = strip(globals);
  const weights = [...css.matchAll(/font-weight:\s*([^;]+);/g)].map((m) => m[1].trim());
  for (const w of weights) assert.match(w, /^var\(--weight-(regular|strong)\)$/, `font-weight: ${w}`);
  const t = strip(tokens);
  assert.match(t, /--weight-regular:\s*400/);
  assert.match(t, /--weight-strong:\s*600/);
  const sizes = new Set([...t.matchAll(/--(text-[a-z]+):/g)].map((m) => m[1]));
  assert.deepEqual([...sizes].sort(), ["text-lg", "text-md", "text-sm", "text-xl", "text-xs", "text-xxl"]);
  // on a phone every chapter's headline is the one large text of its screen (32 px, the first chapter's too), and nothing else is above 20
  const narrow = t.slice(t.indexOf("@media (max-width: 1099px)"));
  assert.match(narrow, /--text-xl:\s*32px/);
  assert.match(narrow, /--text-xxl:\s*32px/);
});

test("no tracked capitals, no decoration, no ambient motion", () => {
  const css = strip(globals);
  assert.ok(!/text-transform:\s*uppercase/.test(css), "uppercase text");
  assert.deepEqual([...css.matchAll(/letter-spacing:\s*([^;]+);/g)].map((m) => m[1].trim()).filter((v) => !/^(-0\.015em|0)$/.test(v)), [], "tracked text");
  for (const bad of [/gradient\(/, /backdrop-filter/, /mix-blend-mode/, /clip-path/, /rotate\(/, /animation[^;]*infinite/, /filter:\s*blur/]) assert.ok(!bad.test(css), String(bad));
  // the one animation is the ripple of the bell, and it runs once
  assert.deepEqual([...css.matchAll(/animation:\s*([\w-]+)/g)].map((m) => m[1]).filter((v) => v !== "none"), ["ripple"]);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]*animation: none !important/);
});
