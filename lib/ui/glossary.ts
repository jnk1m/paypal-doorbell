// The ten words the screens explain where they first appear (plan 10.1 #10): one fixed line each, no model text.
// planTerms() decides, for the text of a page in reading order, which slot carries the explanation for which word: the first slot in
// which the word occurs. Components wrap exactly those words in <Term>; every later occurrence stays plain text. The reading order is
// the order of the slots, and the render test (glossary.test.ts) checks that the first occurrence of each word on the real page is one
// that carries an explanation.

export const TERM_IDS = ["webhook", "delivery", "event", "events list", "resend", "signature", "capture", "refund", "Sandbox", "gap"] as const;
export type TermId = (typeof TERM_IDS)[number];

interface TermDef {
  pattern: RegExp; // the words that count as this term (not global: each use clones it)
  tip: string; // one line
}

export const TERMS: Record<TermId, TermDef> = {
  webhook: { pattern: /\bwebhooks?\b/i, tip: "A message PayPal posts to your server's address when something happens, such as a refund." },
  delivery: { pattern: /\bdeliver(?:y|ies)\b/i, tip: "One try by PayPal to post a webhook to your address. A failed delivery can be tried again." },
  // "events list" is its own term; the plain word "event" does not match when "list" follows it.
  event: { pattern: /\bevents?\b(?! list)/i, tip: "PayPal's record that something happened, such as a payment or a refund. It is what a webhook carries." },
  "events list": { pattern: /\bevents? list\b/i, tip: "PayPal's own list of the events it made for your app. In the Sandbox an event shows up in it 80 to 163 s late." },
  resend: { pattern: /\bresen(?:d|ds|t)\b/i, tip: "Asking PayPal to deliver the same event to your webhook one more time." },
  signature: { pattern: /\bsignatures?\b/i, tip: "A mark PayPal puts on each delivery so your server can tell it really came from PayPal." },
  capture: { pattern: /\bcaptures?\b/i, tip: "The moment PayPal takes the buyer's money for an order. One capture is one row on this page." },
  refund: { pattern: /\brefunds?\b/i, tip: "Money sent back to the buyer after a capture." },
  Sandbox: { pattern: /\bsandbox\b/i, tip: "PayPal's test environment. Test money only; nothing real moves." },
  gap: { pattern: /\bgaps?\b/i, tip: "A row where the shop's books and PayPal's own answer disagree." },
};

export type Piece = string | { term: TermId; text: string };

const find = (text: string, id: TermId): RegExpExecArray | null => new RegExp(TERMS[id].pattern.source, "i").exec(text);

// Cuts a text into plain pieces and the first occurrence of each given term. An occurrence that overlaps an earlier-found one is skipped.
// `used` lists the terms that were really cut out.
export function splitByTerms(text: string, ids: readonly TermId[]): { pieces: Piece[]; used: TermId[] } {
  const hits = ids
    .map((id) => ({ id, m: find(text, id) }))
    .filter((h): h is { id: TermId; m: RegExpExecArray } => h.m !== null)
    .sort((a, b) => a.m.index - b.m.index);
  const pieces: Piece[] = [];
  const used: TermId[] = [];
  let at = 0;
  for (const { id, m } of hits) {
    if (m.index < at) continue;
    if (m.index > at) pieces.push(text.slice(at, m.index));
    pieces.push({ term: id, text: m[0] });
    used.push(id);
    at = m.index + m[0].length;
  }
  if (at < text.length) pieces.push(text.slice(at));
  return { pieces: pieces.length > 0 ? pieces : [text], used };
}

// Called once per text, in reading order, while a page model is built: the first text that contains a term gets it explained, the later
// ones stay plain. The model is a pure function of the snapshot, so the same snapshot always gives the same pieces.
export class TermPlanner {
  private readonly taken = new Set<TermId>();

  text(s: string): Piece[] {
    const { pieces, used } = splitByTerms(s, TERM_IDS.filter((id) => !this.taken.has(id)));
    for (const id of used) this.taken.add(id);
    return pieces;
  }
}

