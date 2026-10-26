// The seal check (plan 6.2, R21): before any sealed set is run, the sha256 of its MANIFEST.sha256 must equal the one committed in
// docs/planning/eval/SEAL.md, every file the manifest lists must hash to what it says, and no file may exist that the manifest does not list.
// This module only reads the paths it is given. The S4 tests run it on a synthetic folder; the real sealed sets are not opened in S4.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

export interface SealRow {
  set: string;
  manifest: string; // as written in SEAL.md (may start with ~/)
  sha256: string;
  files: number;
}

const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

export function parseSeal(md: string): SealRow[] {
  const rows: SealRow[] = [];
  for (const line of md.split("\n")) {
    const m = /^\|\s*([A-Za-z0-9_-]+)\s*\|\s*(\S+MANIFEST\.sha256)\s*\|\s*([0-9a-f]{64})\s*\|\s*(\d+)\s*\|/.exec(line);
    if (m) rows.push({ set: m[1], manifest: m[2], sha256: m[3], files: Number(m[4]) });
  }
  return rows;
}

export interface SealCheck {
  ok: boolean;
  problems: string[];
  listed: number;
}

// SEAL.md: "src/ upstream clones are not part of the sealed set", so unlisted files under src/ are not a problem.
export function verifySeal(row: SealRow, home: string = homedir(), ignorePrefixes: string[] = ["src/"]): SealCheck {
  const problems: string[] = [];
  const path = row.manifest.startsWith("~/") ? join(home, row.manifest.slice(2)) : row.manifest;
  if (!existsSync(path)) return { ok: false, problems: [`${row.set}: manifest ${path} does not exist`], listed: 0 };
  const bytes = readFileSync(path);
  if (sha256(bytes) !== row.sha256) problems.push(`${row.set}: MANIFEST.sha256 hashes to ${sha256(bytes).slice(0, 12)}..., SEAL.md says ${row.sha256.slice(0, 12)}...`);

  const root = path.slice(0, path.lastIndexOf("/"));
  const listed = new Map<string, string>();
  for (const line of bytes.toString("utf8").split("\n")) {
    const m = /^([0-9a-f]{64})\s+\*?(.+)$/.exec(line.trim());
    if (m) listed.set(m[2].replace(/^\.\//, ""), m[1]);
  }
  if (listed.size !== row.files) problems.push(`${row.set}: the manifest lists ${listed.size} files, SEAL.md says ${row.files}`);
  for (const [rel, want] of listed) {
    const full = join(root, rel);
    if (!existsSync(full) || !statSync(full).isFile()) problems.push(`${row.set}: ${rel} is listed but missing`);
    else if (sha256(readFileSync(full)) !== want) problems.push(`${row.set}: ${rel} has changed since it was sealed`);
  }
  const walk = (dir: string) => {
    for (const d of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, d.name);
      if (d.isDirectory()) walk(full);
      else {
        const rel = relative(root, full).split("\\").join("/");
        if (rel !== "MANIFEST.sha256" && !listed.has(rel) && !ignorePrefixes.some((p) => rel.startsWith(p))) problems.push(`${row.set}: ${rel} is not in the manifest`);
      }
    }
  };
  walk(root);
  return { ok: problems.length === 0, problems, listed: listed.size };
}

// ---- where a path points, and whether the files that bind a sealed run are the committed ones ----------------------------------------

// True when `candidate` is `root` or lies under it once every symbolic link on the way is followed (the nearest existing ancestor is
// resolved, the rest is appended), so neither a link nor a path that does not exist yet can reach a folder this check guards.
// Both sides go through the same resolution (the root may itself be a link), and on macOS and Windows the file system ignores case, so
// "~/Doorbell-Eval-Sealed" is the same folder and is compared case-folded.
export function isUnderRoot(candidate: string, root: string): boolean {
  const fold = process.platform === "darwin" || process.platform === "win32" ? (p: string) => p.toLowerCase() : (p: string) => p;
  const real = fold(canonical(candidate));
  const base = fold(canonical(root));
  return real === base || real.startsWith(`${base}${sep}`);
}

function canonical(path: string): string {
  let existing = resolve(path);
  const rest: string[] = [];
  while (!existsSync(existing) && dirname(existing) !== existing) {
    rest.unshift(basename(existing));
    existing = dirname(existing);
  }
  return join(realpathSync.native(existing), ...rest);
}

// The folder SEAL.md calls ~/doorbell-eval-sealed. Computed from the home folder's name only: this does not look at the folder.
export const sealedRootOf = (home: string = homedir()): string => join(realpathSync(home), "doorbell-eval-sealed");

// A sealed run is bound by two files: eval/harness/FREEZE.json and docs/planning/eval/SEAL.md. Both must be byte-identical to the
// ones in the last commit (git show HEAD:<path>). A file that is untracked, modified, staged but not committed, or missing is a problem.
export function uncommittedProblems(files: string[], working: (rel: string) => Buffer | null, committed: (rel: string) => Buffer | null): string[] {
  const problems: string[] = [];
  for (const rel of files) {
    const w = working(rel);
    const c = committed(rel);
    if (!w) problems.push(`${rel} does not exist in the working tree`);
    else if (!c) problems.push(`${rel} is not in the last commit (untracked, or never committed)`);
    else if (!w.equals(c)) problems.push(`${rel} differs from the last commit (uncommitted changes)`);
  }
  return problems;
}

export const gitHead = (root: string) => (rel: string): Buffer | null => {
  try {
    return execFileSync("git", ["show", `HEAD:${rel}`], { cwd: root, stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 });
  } catch {
    return null;
  }
};
