// What a patch leaves behind (LOCAL ONLY, record time: it reads the whole patched file, which is not deployed).
//
// The patch is built from the lines the cause cited, so the bad deploy's other lines stay, and a line the deploy added that nothing cited (a comment, a
// helper, a declaration) can stay with them. The proof cannot see that: its checks compare behaviour, not tidiness. This diffs the patched file against
// the shop's last good build and sorts each place where they still differ into a few kinds (types.ts Leftover). Nothing here is written by hand per
// mode, and nothing is a verdict on the patch: it names what differs and lets types.ts say it in fixed words.
import { diffFiles, splitLines } from "../shop/diffs.ts";
import type { Leftover } from "./types.ts";

interface Changed {
  text: string;
  line: number | null; // the line number in the patched file for an added line
}
interface Block {
  add: Changed[];
  del: Changed[];
}

const IMPORT = /^\s*import\b/;
const COMMENT = /^\s*(\/\/|\/\*|\*)/;
const BLANK = /^\s*$/;
// A declaration at the left margin: what a helper or a constant looks like once the deploy has added it.
const DECLARATION = /^(?:export\s+)?(?:async\s+)?(function\*?|const|let|var|class)\s+([A-Za-z_$][\w$]*)/;

// The names an import line brings in: `import { a, b as c } from "x"` gives a and b; a default import gives its name.
function importedNames(text: string): string[] {
  const names: string[] = [];
  const braces = /\{([^}]*)\}/.exec(text);
  if (braces) for (const part of braces[1].split(",")) if (part.trim()) names.push(part.trim().split(/\s+as\s+/)[0].replace(/^type\s+/, ""));
  const lead = /^\s*import\s+(?:type\s+)?([A-Za-z_$][\w$]*)\s*(?:,|from)/.exec(text);
  if (lead) names.push(lead[1]);
  return names.sort();
}

const sameNames = (a: string[], b: string[]): boolean => a.length === b.length && a.every((n, i) => n === b[i]);

// How many lines of the patched file use `name`, not counting the block's own lines or comments.
function usesOutside(name: string, patched: string[], own: Set<number>): number {
  const re = new RegExp(`(?<![\\w$])${name.replace(/[$]/g, "\\$")}(?![\\w$])`);
  return patched.filter((text, i) => !own.has(i + 1) && !COMMENT.test(text) && re.test(text)).length;
}

function sortOut(block: Block, patched: string[]): Leftover[] {
  const { add, del } = block;
  const other: Leftover = { kind: "other", added: add.length, removed: del.length };
  const all = [...add, ...del];

  if (all.every((l) => IMPORT.test(l.text))) {
    const names = (side: Changed[]) => side.flatMap((l) => importedNames(l.text)).sort();
    return sameNames(names(add), names(del)) && names(add).length > 0 ? [{ kind: "imports" }] : [other];
  }
  if (del.length > 0) return [other];

  const declared = add.flatMap((l) => {
    const m = DECLARATION.exec(l.text);
    return m ? [{ name: m[2], declares: m[1].startsWith("function") ? ("function" as const) : ("value" as const) }] : [];
  });
  if (declared.length > 0) {
    const own = new Set(add.flatMap((l) => (l.line !== null ? [l.line] : [])));
    // Two declarations of the same name in one block are one thing to say, and a name the rest of the file uses is not a leftover.
    const unused = declared.every((d) => usesOutside(d.name, patched, own) === 0);
    return unused ? declared.map((d) => ({ kind: "unused" as const, name: d.name, declares: d.declares })) : [other];
  }
  if (add.every((l) => COMMENT.test(l.text) || BLANK.test(l.text))) {
    const comments = add.filter((l) => COMMENT.test(l.text)).length;
    return comments > 0 ? [{ kind: "comment", lines: comments }] : [other];
  }
  return [other];
}

// The places where `patched` still differs from `good`, in file order. [] when the two files are the same.
export function leftoversOf(good: string, patched: string): Leftover[] {
  const lines = splitLines(patched);
  const out: Leftover[] = [];
  for (const hunk of diffFiles("good", "patched", good, patched)) {
    let block: Block = { add: [], del: [] };
    const flush = (): void => {
      if (block.add.length > 0 || block.del.length > 0) out.push(...sortOut(block, lines));
      block = { add: [], del: [] };
    };
    for (const l of hunk.lines) {
      if (l.kind === "ctx") flush();
      else if (l.kind === "add") block.add.push({ text: l.text, line: Number(l.id.slice(l.id.lastIndexOf(":") + 1)) });
      else block.del.push({ text: l.text, line: null });
    }
    flush();
  }
  return out;
}
