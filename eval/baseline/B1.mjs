// Rules/regex baselines for the P6 comparison. Written BEFORE any model run and not tuned afterwards.
const isComment = (l) => /^\s*(\/\/|#|\*|\/\*|<!--)/.test(l);

// ---------- cause baseline ----------
export function parseDiff(diff) {
  const files = []; let cur = null;
  for (const raw of diff.split("\n")) {
    if (raw.startsWith("diff --git")) { cur = { file: raw.split(" b/")[1], renamed: false, added: [], removed: [] }; files.push(cur); continue; }
    if (!cur) continue;
    if (raw.startsWith("rename from") || raw.startsWith("rename to")) { cur.renamed = true; cur.renameLines = [...(cur.renameLines ?? []), raw]; continue; }
    if (raw.startsWith("+++") || raw.startsWith("---")) continue;
    if (raw.startsWith("+")) { const l = raw.slice(1); if (!isComment(l) && l.trim()) cur.added.push(l); }
    else if (raw.startsWith("-")) { const l = raw.slice(1); if (!isComment(l) && l.trim()) cur.removed.push(l); }
  }
  return files;
}
const R = {
  RAW_BODY_ALTERED: { sym: ["SIG_REJECT_ALL"], on: "both", re: /express\.json|bodyParser|req\.json\(\)|JSON\.stringify\((req\.body|body)\)|express\.raw|req\.text\(\)|rawBody/ },
  WRONG_WEBHOOK_ID: { sym: ["SIG_REJECT_ALL"], on: "both", re: /webhook_?id/i },
  WORK_AFTER_ACK: { sym: ["ACK_BUT_MISSING"], on: "added", re: /\b(setImmediate|queueMicrotask|nextTick|waitUntil)\b|\bqueue\b|jobQueue|\bvoid\s+[\w.]+\(|\.catch\(/i },
  EVENT_TYPE_DROPPED: { sym: ["TYPE_MISSING", "ACK_BUT_MISSING"], on: "removed", re: /["'](PAYMENT|CHECKOUT|BILLING|CUSTOMER)\.[A-Z_.-]+["']/ },
  APP_OR_ENV_MISMATCH: { sym: ["NO_DELIVERY_NONE"], on: "both", re: /client_?(id|secret)|PAYPAL_ENV|sandbox|PAYPAL_BASE|api-m\./i },
  ENDPOINT_PATH_CHANGED: { sym: ["NO_DELIVERY_404"], on: "both", re: /(router|app)\.(post|all|use)\(\s*["']\/|["']\/api\/[\w\/-]+["']/ },
};
const ORDER = Object.keys(R);
export function baselineCause(c) {
  const files = parseDiff(c.diff);
  const fired = {};
  for (const [cat, rule] of Object.entries(R)) {
    if (!rule.sym.includes(c.symClass)) continue;
    const hits = [];
    for (const f of files) {
      const lines = rule.on === "added" ? f.added : rule.on === "removed" ? f.removed : [...f.removed, ...f.added];
      for (const l of lines) if (rule.re.test(l)) hits.push({ file: f.file, line: l.trim() });
      if (cat === "ENDPOINT_PATH_CHANGED" && f.renamed) hits.push({ file: f.file, line: (f.renameLines ?? []).join(" | ") });
      // ordering rule: a global JSON parser mounted before the webhook route (file-level, uses the new file text)
      if (cat === "RAW_BODY_ALTERED" && f.file.endsWith("app.js") && c.files[f.file]) {
        const t = c.files[f.file]; const j = t.indexOf("express.json("), w = t.search(/\.use\(\s*\w*[wW]ebhook/);
        if (j >= 0 && w >= 0 && j < w) hits.push({ file: f.file, line: "app.use(express.json());" });
      }
    }
    if (hits.length) fired[cat] = hits;
  }
  const cats = ORDER.filter((k) => fired[k]);
  if (!cats.length) return { category: "NOT_IN_DIFF", file: null, evidence_line: "", fired: [] };
  const best = cats.reduce((a, b) => (fired[b].length > fired[a].length ? b : a), cats[0]);
  return { category: best, file: fired[best][0].file, evidence_line: fired[best][0].line, fired: cats };
}

// ---------- mapping baseline ----------
const quoted = (s) => [...[...s.matchAll(/'([^'\n]*)'/g)].map((m) => m[1]), ...[...s.matchAll(/"([^"\n]*)"/g)].map((m) => m[1])];
function branch(text, ev) {
  const i = text.indexOf(ev); if (i < 0) return "";
  const rest = text.slice(i + ev.length);
  const j = rest.search(/case\s+['"]/);
  return j < 0 ? rest : rest.slice(0, j);
}
export function baselineMap(shop) {
  const entries = Object.entries(shop.files);
  const handler = entries.find(([, t]) => t.includes("PAYMENT.CAPTURE.COMPLETED"));
  const others = entries.filter(([p]) => p !== handler[0]);
  const vocab = [];
  for (const [, t] of entries) for (const m of t.matchAll(/([A-Za-z_\-]+(?:\s*\|\s*[A-Za-z_\-]+){2,})/g)) vocab.push(...m[1].split("|").map((s) => s.trim()));
  const inVocab = (tok) => vocab.find((v) => v.toLowerCase() === String(tok).toLowerCase());
  const lookup = (tok) => { for (const [, t] of entries) { const m = t.match(new RegExp(`\\b${tok}\\s*:\\s*["']([^"']+)["']`)); if (m) return m[1]; } return null; };
  const comp = branch(handler[1], "PAYMENT.CAPTURE.COMPLETED"), ref = branch(handler[1], "PAYMENT.CAPTURE.REFUNDED");
  const out = {};
  // Q1: what does the handler assign event.resource.id to; else first schema name that looks like a capture/transaction id
  let q1 = null;
  let m = comp.match(/([\w$.\[\]'"]+)\s*=\s*event\.resource\.id/); if (m) q1 = m[1];
  if (!q1) { m = comp.match(/update_post_meta\([^,]+,\s*'([^']+)',\s*\$event\['resource'\]\['id'\]/); if (m) q1 = m[1]; }
  if (!q1) for (const [, t] of others) { m = t.match(/\b(\w*(?:capture|transaction|txn)\w*)\b/i); if (m) { q1 = m[1]; break; } }
  out.capture_id = q1;
  const pick = (br, prefer) => {
    const toks = quoted(br); const cands = [];
    for (const t of toks) { const v = inVocab(t); if (v) cands.push(v); else { const l = lookup(t); if (l && inVocab(l)) cands.push(inVocab(l)); } }
    if (prefer) { const p = cands.find((c) => prefer.test(c)); if (p) return p; }
    return cands[0] ?? null;
  };
  out.state_paid = pick(comp);
  let q3 = pick(ref, /^(wc-)?refunded$/i);
  if (!q3) q3 = vocab.find((v) => /refund/i.test(v) && !/part/i.test(v)) ?? null;
  out.state_refunded = q3;
  return out;
}
