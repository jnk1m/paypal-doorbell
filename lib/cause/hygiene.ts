// Input hygiene (R14, plan 9.4). ONE normalization for everything the cause step reads or shows: the text the model is given, the
// line a check compares, and the line the screen prints are all the output of normalizeSource, so what is shown is what was compared.
//
//   NFC                              so that a decomposed look-alike equals its composed form
//   format characters (\p{Cf})       zero-width, bidi controls, tag characters, BOM, soft hyphen: removed
//   variation selectors, stray marks removed (a mark that follows an ASCII character or another mark; real scripts keep theirs)
//   control characters               a NUL or any C0/C1 control other than tab and newline is a binary file: rejected
//   delimiter look-alikes            "<<<BEGIN-UNTRUSTED" and "<<<END-UNTRUSTED" in the text are disarmed
//   secrets                          PayPal ids/secrets, access tokens, Bearer tokens, Anthropic keys, private keys, assigned secrets: replaced
// Homoglyphs (Cyrillic "a" in a Latin word) pass NFC and \p{Cf}; hasMixedScriptToken lets a check refuse such a line as evidence, and
// escapeForDisplay prints every non-ASCII character as \u{...} so that nothing on screen can look like something else.

export type RejectReason = "binary" | "bad_encoding" | "diff_too_large" | "file_too_large" | "empty_diff";

export class InputRejected extends Error {
  constructor(
    readonly reason: RejectReason,
    detail = "",
  ) {
    super(`input rejected: ${reason}${detail ? ` (${detail})` : ""}`);
    this.name = "InputRejected";
  }
}

// Plan 9.4: diff 40 KB; at most 5 files, 60 KB together.
export const LIMITS = { diffBytes: 40 * 1024, fileCount: 5, totalFileBytes: 60 * 1024 } as const;

export interface NormalizeNotes {
  stripped: number; // invisible characters and stray marks removed
  secrets: Record<string, number>; // how many of each secret kind were replaced
  delimiters: number; // delimiter look-alikes disarmed
}

const INVISIBLE = /[\p{Cf}︀-️\u{E0100}-\u{E01EF}]/gu;
const STRAY_MARKS = /(?<=[\x20-\x7e\p{M}])\p{M}+/gu;
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/;
const DELIMITER = /<<<(BEGIN|END)-UNTRUSTED/g;

// Five secret shapes the plan lists. Every replacement keeps the line (and its line number) intact.
const SECRET_PATTERNS: { kind: string; re: RegExp; replace: string | ((...m: string[]) => string) }[] = [
  { kind: "private_key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, replace: (m: string) => `[REDACTED:private_key]${"\n".repeat((m.match(/\n/g) ?? []).length)}` },
  { kind: "anthropic_key", re: /\bsk-ant-[A-Za-z0-9_-]{8,}/g, replace: "[REDACTED:anthropic_key]" },
  { kind: "bearer", re: /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi, replace: "Bearer [REDACTED:bearer]" },
  // PayPal REST client ids start with A, secrets with E; both are 80 characters. Access tokens start with A21A.
  { kind: "paypal_token", re: /\bA21A[A-Za-z0-9_-]{20,}/g, replace: "[REDACTED:paypal_token]" },
  { kind: "paypal_id_secret", re: /\b(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[a-z])(?=[A-Za-z0-9_-]*[A-Z])[AE][A-Za-z0-9_-]{59,89}\b/g, replace: "[REDACTED:paypal_id_secret]" },
  {
    kind: "assigned_secret",
    re: /\b(client_?secret|secret|api_?key|access_?token|auth_?token|password|passwd)(["']?\s*[:=]\s*)(["'`])([^"'`\n]{8,})\3/gi,
    replace: (_m: string, name: string, sep: string, quote: string) => `${name}${sep}${quote}[REDACTED:assigned_secret]${quote}`,
  },
];

export function scrubSecrets(text: string): { text: string; secrets: Record<string, number> } {
  const secrets: Record<string, number> = {};
  let out = text;
  for (const { kind, re, replace } of SECRET_PATTERNS) {
    out = out.replace(re, (...m: unknown[]) => {
      secrets[kind] = (secrets[kind] ?? 0) + 1;
      return typeof replace === "string" ? replace : replace(...(m as string[]));
    });
  }
  return { text: out, secrets };
}

export function normalizeSource(text: string): { text: string; notes: NormalizeNotes } {
  if (!text.isWellFormed()) throw new InputRejected("bad_encoding", "lone surrogate");
  let out = text.normalize("NFC");
  const before = out.length;
  out = out.replace(INVISIBLE, "").replace(STRAY_MARKS, "");
  const stripped = before - out.length;
  out = out.replace(/\r\n?/g, "\n");
  if (CONTROL.test(out)) throw new InputRejected("binary", "control character");
  let delimiters = 0;
  out = out.replace(DELIMITER, (_m, which: string) => {
    delimiters++;
    return `<<<${which}_UNTRUSTED`;
  });
  const scrubbed = scrubSecrets(out);
  return { text: scrubbed.text, notes: { stripped, secrets: scrubbed.secrets, delimiters } };
}

// Every character outside printable ASCII is printed as \u{hex}; a tab is \t. What the screen shows is therefore ASCII only.
export function escapeForDisplay(s: string): string {
  let out = "";
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if (ch === "\t") out += "\\t";
    else if (cp >= 0x20 && cp <= 0x7e) out += ch;
    else out += `\\u{${cp.toString(16)}}`;
  }
  return out;
}

// A token that mixes Latin with Cyrillic or Greek (or those two with each other) is how a homoglyph hides: such a line is not evidence.
export function hasMixedScriptToken(line: string): boolean {
  for (const token of line.match(/[\p{L}\p{N}_$]+/gu) ?? []) {
    let scripts = 0;
    if (/\p{Script=Latin}/u.test(token)) scripts++;
    if (/\p{Script=Cyrillic}/u.test(token)) scripts++;
    if (/\p{Script=Greek}/u.test(token)) scripts++;
    if (scripts >= 2) return true;
  }
  return false;
}

export const byteLength = (s: string): number => Buffer.byteLength(s, "utf8");
