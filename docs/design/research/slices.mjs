// usage: node slices.mjs <url> <width> <height> <out.json> [--click=<selector to click first, e.g. #ring>] [--init=<js to run before>] [--live-stage=<stage of a mocked live API>]
// (--live-stage needs ./mock.mjs, a Playwright route handler that answers /api/shop/* with the recorded run's snapshots; it is not kept in the repo.)
// Playwright is resolved from this repo.s node_modules.
// Slides a viewport down the page in steps of 150 px (animations settled) and reports the worst case of each rule per viewport slice.
import { createRequire } from "node:module";
import fs from "node:fs";
const require = createRequire(import.meta.url); // playwright must be installed in this repo (npm i --no-save playwright)
const { chromium } = require("playwright");
const [url, w, h, out, ...flags] = process.argv.slice(2);
const val = (n) => { const f = flags.find((x) => x.startsWith(`--${n}=`)); return f ? f.slice(n.length + 3) : null; };
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: +w, height: +h }, colorScheme: "light" });
if (val("live-stage")) {
  const { install } = await import("./mock.mjs");
  await install(page, { stage: val("live-stage") });
  await page.addInitScript(() => { sessionStorage.setItem("doorbell.live", "t"); sessionStorage.setItem("doorbell.session", "abc12345def"); });
}
await page.goto(url, { waitUntil: val("live-stage") ? "load" : "networkidle" });
if (val("live-stage")) await page.waitForTimeout(3500);
await page.waitForTimeout(900);
if (val("click")) { await page.click(val("click")); await page.waitForTimeout(15000); }
if (val("init")) { await page.evaluate(val("init")); await page.waitForTimeout(1200); }

const total = await page.evaluate(() => document.documentElement.scrollHeight);
const worst = { containers: 0, containersAt: 0, containerSamples: [], pills: 0, pillsAt: 0, big: 0, bigAt: 0, bigSamples: [], nested: 0, tinted: 0, tintAt: 0, status: 0, statusAt: 0, repeats: [], weight600Pct: 0, caps: 0, sizes: 0, emptyLeft: null };
const repeatsAll = new Set();
for (let y = 0; y <= Math.max(0, total - +h); y += 150) {
  await page.evaluate((y) => scrollTo({ top: y, behavior: "instant" }), y);
  await page.waitForTimeout(450);
  const r = await page.evaluate(() => {
    const vh = innerHeight, vw = innerWidth;
    const SKIP = ["SCRIPT", "STYLE", "PATH", "CIRCLE", "LINE", "RECT", "POLYGON", "G", "DEFS", "TITLE", "SVG", "USE", "POLYLINE", "ELLIPSE", "TEXT"];
    const effOpacity = (e) => { let o = 1; for (let n = e; n && n !== document.documentElement; n = n.parentElement) o *= parseFloat(getComputedStyle(n).opacity); return o; };
    const clipped = (e) => {
      const r = e.getBoundingClientRect();
      for (let n = e.parentElement; n && n !== document.body; n = n.parentElement) {
        const cs = getComputedStyle(n);
        if (cs.overflowY !== "visible" || cs.overflowX !== "visible") {
          const p = n.getBoundingClientRect();
          if (p.height < 2 || p.width < 2) return true;
          if (r.bottom < p.top || r.top > p.bottom || r.right < p.left || r.left > p.right) return true;
        }
      }
      return false;
    };
    const vis = (e) => {
      const r = e.getBoundingClientRect(); const cs = getComputedStyle(e);
      if (!(r.width > 0 && r.height > 0) || cs.display === "none" || cs.visibility === "hidden") return false;
      if (r.bottom <= 0 || r.top >= vh) return false;
      if (effOpacity(e) < 0.3) return false;
      return !clipped(e);
    };
    const all = [...document.body.querySelectorAll("*")].filter((e) => !SKIP.includes(e.tagName.toUpperCase()) && vis(e));
    const sides = ["Top", "Right", "Bottom", "Left"];
    const isT = (c) => /rgba\(0, 0, 0, 0\)|transparent/.test(c);
    const boxed = [], pills = [];
    for (const e of all) {
      const cs = getComputedStyle(e); const r = e.getBoundingClientRect();
      const hasBorder = sides.some((s) => parseFloat(cs["border" + s + "Width"]) >= 1 && cs["border" + s + "Style"] !== "none");
      const hasBg = !isT(cs.backgroundColor);
      const radius = parseFloat(cs.borderTopLeftRadius) || 0;
      const container = (hasBorder || hasBg) && cs.display !== "inline" && r.width > 20 && r.height > 14 && !["BODY", "HTML", "MAIN"].includes(e.tagName);
      if (container) { e.__b = 1; boxed.push(e); }
      if ((hasBorder || hasBg) && r.height < 64 && radius >= 12 && radius >= Math.min(r.height / 2, 14) && !(e.tagName === "DIV" && r.width > 400)) pills.push(e);
    }
    let nested = 0;
    for (const e of boxed) { let p = e.parentElement; while (p && p !== document.body) { if (p.__b) { nested++; break; } p = p.parentElement; } }
    const textEls = all.filter((e) => [...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim()));
    const big = textEls.filter((e) => parseFloat(getComputedStyle(e).fontSize) > 28).map((e) => e.textContent.trim().slice(0, 40));
    const heavy = textEls.filter((e) => +getComputedStyle(e).fontWeight >= 600).length;
    const sizes = new Set(textEls.map((e) => getComputedStyle(e).fontSize));
    const caps = textEls.filter((e) => { const own = [...e.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent.trim()).join(" "); return getComputedStyle(e).textTransform === "uppercase" || (own === own.toUpperCase() && /[A-Z]{3}/.test(own) && own.length < 40) || parseFloat(getComputedStyle(e).letterSpacing) > 0.4; }).map((e) => e.textContent.trim().slice(0, 30));
    // visible text lines, for repeated sentences (5+ words)
    const lines = [];
    for (const e of textEls) { const own = [...e.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent.trim()).join(" ").replace(/\s+/g, " "); if (own) lines.push(own); }
    // the left column's bottom edge against the viewport (only meaningful at the top of the page)
    const left = document.querySelector(".narr");
    const lastLeft = left ? [...left.querySelectorAll("p,h1,h2,h3,li")].filter(vis).map((e) => e.getBoundingClientRect().bottom) : [];
    const panel = document.querySelector(".aside .vis");
    return {
      containers: boxed.map((e) => (e.className && e.className.toString().split(" ")[0]) || e.tagName.toLowerCase()), pills: pills.map((e) => e.textContent.trim().slice(0, 20)), nested, big, heavy, texts: textEls.length, sizes: [...sizes], caps, lines,
      leftBottom: lastLeft.length ? Math.max(...lastLeft) : null, panelBottom: panel ? panel.getBoundingClientRect().bottom : null, vh, hscroll: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    };
  });
  // tinted and status pixels from the screenshot
  const buf = await page.screenshot();
  const px = await page.evaluate(async (b64) => {
    const img = new Image(); img.src = "data:image/png;base64," + b64; await img.decode();
    const c = document.createElement("canvas"); c.width = img.width; c.height = img.height; const x = c.getContext("2d"); x.drawImage(img, 0, 0);
    const d = x.getImageData(0, 0, c.width, c.height).data; let tint = 0, status = 0; const tot = d.length / 4;
    for (let i = 0; i < d.length; i += 4) {
      const R = d[i] / 255, G = d[i + 1] / 255, B = d[i + 2] / 255; const mx = Math.max(R, G, B), mn = Math.min(R, G, B); const l = (mx + mn) / 2; const dl = mx - mn; if (dl < 0.03) continue;
      const s = dl / (1 - Math.abs(2 * l - 1)); let hh = mx === R ? ((G - B) / dl) % 6 : mx === G ? (B - R) / dl + 2 : (R - G) / dl + 4; hh = (hh * 60 + 360) % 360;
      const red = hh >= 340 || hh <= 20; const green = hh >= 100 && hh <= 170;
      if ((red || green) && s > 0.25) { status++; if (l > 0.78) tint++; }
    }
    return { tint: (100 * tint) / tot, status: (100 * status) / tot };
  }, buf.toString("base64"));
  if (r.containers.length > worst.containers) { worst.containers = r.containers.length; worst.containersAt = y; worst.containerSamples = r.containers; }
  if (r.pills.length > worst.pills) { worst.pills = r.pills.length; worst.pillsAt = y; }
  if (r.big.length > worst.big) { worst.big = r.big.length; worst.bigAt = y; worst.bigSamples = r.big; }
  worst.nested = Math.max(worst.nested, r.nested);
  if (px.tint > worst.tinted) { worst.tinted = px.tint; worst.tintAt = y; }
  if (px.status > worst.status) { worst.status = px.status; worst.statusAt = y; }
  worst.weight600Pct = Math.max(worst.weight600Pct, (100 * r.heavy) / Math.max(1, r.texts));
  worst.caps = Math.max(worst.caps, r.caps.length);
  worst.sizes = Math.max(worst.sizes, r.sizes.length);
  worst.hscroll = worst.hscroll || r.hscroll;
  const seen = new Map();
  for (const line of r.lines) for (const sent of line.split(/(?<=[.!?])\s+/)) { const k = sent.trim().replace(/[.!?]$/, "").toLowerCase(); if (k.split(/\s+/).length >= 5 && !/^#\d /.test(k)) seen.set(k, (seen.get(k) || 0) + 1); }
  for (const [k, n] of seen) if (n > 1) repeatsAll.add(`y=${y}: "${k}" x${n}`);
  if (y === 0) worst.emptyLeft = { vh: r.vh, leftBottom: r.leftBottom, panelBottom: r.panelBottom };
}
worst.repeats = [...repeatsAll];
worst.pageHeight = total;
await page.evaluate(() => scrollTo({ top: 0, behavior: "instant" })); await page.waitForTimeout(300);
worst.h1Top = await page.evaluate(() => { const h = document.querySelector("h1"); return h ? Math.round(h.getBoundingClientRect().top) : null; });
fs.writeFileSync(out, JSON.stringify(worst, null, 1));
console.log(JSON.stringify({ url, w, h: +h, containers: worst.containers, at: worst.containersAt, pills: worst.pills, big: worst.big, bigSamples: worst.bigSamples, nested: worst.nested, tinted: +worst.tinted.toFixed(2), status: +worst.status.toFixed(2), w600: +worst.weight600Pct.toFixed(1), caps: worst.caps, sizes: worst.sizes, h1Top: worst.h1Top, hscroll: worst.hscroll, repeats: worst.repeats.length, empty: worst.emptyLeft }));
if (worst.repeats.length) console.log(worst.repeats.slice(0, 12).join("\n"));
if (worst.containers > 3) console.log("containers", worst.containerSamples);
await browser.close();
