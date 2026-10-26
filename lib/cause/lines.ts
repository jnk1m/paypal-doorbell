// Which lines of a source file are code (plan 5.4 C1'). A comment line, a blank line and a line that holds nothing but a string literal
// are not evidence: E 4.2's decoy is a harmless file with "// NOTE: re-serializes the body" next to the real bug.
//
// A small scanner, not a parser. It knows line and block comments, quotes, and the strings that can span lines (template literals,
// Python triple quotes), per language family. What it has to get right is the direction of its mistakes: when it cannot tell, a line is
// called a comment or a string (not evidence), never code. The residue of a line is what is left after comments and string literals are
// taken out; a line is "string" when the residue is empty or just a ";" ("name",  stays code: it is an array element).
export type LineKind = "code" | "comment" | "blank" | "string";

interface Syntax {
  line: string[]; // line comment openers
  block: [string, string] | null;
  quotes: string; // single-line string delimiters
  multi: string[]; // string delimiters that may span lines
}

const C_LIKE: Syntax = { line: ["//"], block: ["/*", "*/"], quotes: "'\"", multi: ["`"] };
const SYNTAX: Record<string, Syntax> = {
  js: C_LIKE, mjs: C_LIKE, cjs: C_LIKE, jsx: C_LIKE, ts: C_LIKE, tsx: C_LIKE, go: C_LIKE,
  java: { ...C_LIKE, multi: ['"""'] }, kt: { ...C_LIKE, multi: ['"""'] }, scala: { ...C_LIKE, multi: ['"""'] }, swift: { ...C_LIKE, multi: ['"""'] },
  c: { ...C_LIKE, multi: [] }, h: { ...C_LIKE, multi: [] }, cc: { ...C_LIKE, multi: [] }, cpp: { ...C_LIKE, multi: [] }, cs: { ...C_LIKE, multi: [] }, rs: { ...C_LIKE, multi: [] }, dart: { ...C_LIKE, multi: ["'''", '"""'] },
  php: { line: ["//", "#"], block: ["/*", "*/"], quotes: "'\"", multi: [] },
  py: { line: ["#"], block: null, quotes: "'\"", multi: ["'''", '"""'] },
  rb: { line: ["#"], block: null, quotes: "'\"", multi: ["`"] },
  sh: { line: ["#"], block: null, quotes: "'\"", multi: [] }, bash: { line: ["#"], block: null, quotes: "'\"", multi: [] }, zsh: { line: ["#"], block: null, quotes: "'\"", multi: [] },
  yml: { line: ["#"], block: null, quotes: "'\"", multi: [] }, yaml: { line: ["#"], block: null, quotes: "'\"", multi: [] }, toml: { line: ["#"], block: null, quotes: "'\"", multi: [] },
  env: { line: ["#"], block: null, quotes: "'\"", multi: [] }, keys: { line: ["#"], block: null, quotes: "'\"", multi: [] }, conf: { line: ["#"], block: null, quotes: "'\"", multi: [] },
  ini: { line: ["#", ";"], block: null, quotes: "'\"", multi: [] },
  sql: { line: ["--"], block: ["/*", "*/"], quotes: "'", multi: [] },
  lua: { line: ["--"], block: ["--[[", "]]"], quotes: "'\"", multi: [] },
  json: { line: [], block: null, quotes: '"', multi: [] },
  html: { line: [], block: ["<!--", "-->"], quotes: "'\"", multi: [] }, htm: { line: [], block: ["<!--", "-->"], quotes: "'\"", multi: [] }, xml: { line: [], block: ["<!--", "-->"], quotes: "'\"", multi: [] },
  md: { line: [], block: ["<!--", "-->"], quotes: "", multi: [] },
};
// Unknown extension (md, txt, Dockerfile ...): every opener we know, so that an unknown file errs towards "comment".
const UNKNOWN: Syntax = { line: ["//", "#"], block: ["/*", "*/"], quotes: "'\"", multi: ["`"] };

export const syntaxFor = (path: string): Syntax => SYNTAX[path.split("/").pop()!.split(".").pop()!.toLowerCase()] ?? UNKNOWN;

export function classifyLines(text: string, path: string): LineKind[] {
  const syn = syntaxFor(path);
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const out: LineKind[] = [];
  let inBlock = false;
  let inMulti: string | null = null;

  for (const line of lines) {
    if (line.trim() === "") {
      // a blank line inside a template literal is still string content, but it is blank for every purpose here
      out.push("blank");
      continue;
    }
    let residue = "";
    let sawComment = false;
    let sawString = false;
    let i = 0;
    while (i < line.length) {
      if (inBlock) {
        sawComment = true;
        const end = line.indexOf(syn.block![1], i);
        if (end < 0) {
          i = line.length;
        } else {
          inBlock = false;
          i = end + syn.block![1].length;
        }
        continue;
      }
      if (inMulti) {
        sawString = true;
        const end = line.indexOf(inMulti, i);
        if (end < 0) i = line.length;
        else {
          i = end + inMulti.length;
          inMulti = null;
        }
        continue;
      }
      const rest = line.slice(i);
      const lineOpener = syn.line.find((o) => rest.startsWith(o) && !(o === "--" && syn.block?.[0] === "--[[" && rest.startsWith("--[[")));
      if (syn.block && rest.startsWith(syn.block[0])) {
        inBlock = true;
        sawComment = true;
        i += syn.block[0].length;
        continue;
      }
      if (lineOpener !== undefined && !(lineOpener === "#" && rest.startsWith("#[") && syn.line.includes("//"))) {
        sawComment = true;
        i = line.length;
        continue;
      }
      const multi = syn.multi.find((m) => rest.startsWith(m));
      if (multi) {
        sawString = true;
        const end = line.indexOf(multi, i + multi.length);
        if (end < 0) {
          inMulti = multi;
          i = line.length;
        } else {
          i = end + multi.length;
        }
        continue;
      }
      const ch = line[i];
      if (syn.quotes.includes(ch)) {
        sawString = true;
        let j = i + 1;
        while (j < line.length && line[j] !== ch) j += line[j] === "\\" ? 2 : 1;
        i = j + 1; // an unterminated quote runs to the end of the line: it never carries over
        continue;
      }
      if (!/\s/.test(ch)) residue += ch;
      i++;
    }
    if (residue === "" || residue === ";") out.push(sawString ? "string" : sawComment ? "comment" : "blank");
    else out.push("code");
  }
  return out;
}

// The kind of one line on its own (no file around it). Used when the diff comes without the files, and as the safe fallback when a
// line of the diff does not match the file at that line number.
export function classifyLine(text: string, path: string): LineKind {
  const kind = classifyLines(text, path)[0] ?? "blank";
  // Alone, the middle of a block comment (" * text", " */") looks like code; in a language with block comments it is not evidence.
  if (kind === "code" && syntaxFor(path).block && /^\s*\*(\s|\/|$)/.test(text)) return "comment";
  return kind;
}
