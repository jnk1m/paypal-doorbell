// Which folder of cases a run is allowed to read (R21). Two kinds, and nothing in between:
//   --set <dir>       a development folder. It may NOT be, or lie under, the sealed folder (symbolic links followed). A sealed set read this way
//                     would skip the hash check, so it is refused, and so is --validate on it.
//   --sealed ha[,b2]  sealed sets named in SEAL.md. Before anything is read: the freeze must hold, FREEZE.json and SEAL.md must be
//                     byte-identical to the last commit, and every named set must pass the seal hash check. --set cannot be combined with it
//                     (that would verify one folder and run another). --sub picks a subfolder (a variant) and cannot leave the set.
// A --b2 module is code that gets imported: it may come from a sealed folder only through --sealed <cases>,b2.
// Pure with respect to the folders it is given: the real sealed folders are only touched when the caller passes their rows and paths in.
import { dirname, join, resolve, sep } from "node:path";
import { isUnderRoot, verifySeal, type SealCheck, type SealRow } from "./seal.ts";

export interface SetFlags {
  set?: string;
  sealed?: string;
  sub?: string;
  b2?: string;
}

export interface SetDeps {
  sealedRoot: string;
  home: string;
  sealRows: () => SealRow[]; // read lazily: only a sealed run needs SEAL.md
  freezeProblems: () => string[];
  uncommittedProblems: () => string[];
  verify?: (row: SealRow, home: string) => SealCheck;
  log?: (line: string) => void;
}

export interface ResolvedSet {
  setDir: string;
  b2?: string;
  sealed: boolean;
}

export function resolveSet(flags: SetFlags, deps: SetDeps): ResolvedSet {
  const log = deps.log ?? (() => undefined);
  if (flags.set && flags.sealed) throw new Error("refusing: --set cannot be combined with --sealed (one folder would be checked and another run)");

  if (flags.set) {
    if (isUnderRoot(flags.set, deps.sealedRoot)) throw new Error("refusing: --set points into the sealed folder; a sealed set is only read through --sealed <name>, after its hash check");
    if (flags.b2 && isUnderRoot(flags.b2, deps.sealedRoot)) throw new Error("refusing: --b2 points into the sealed folder; use --sealed <cases>,b2");
    if (flags.sub) throw new Error("--sub belongs to --sealed; with --set, give the folder itself");
    return { setDir: resolve(flags.set), ...(flags.b2 ? { b2: resolve(flags.b2) } : {}), sealed: false };
  }

  if (!flags.sealed) throw new Error("give --set <folder of case folders> or --sealed <name>");
  const frozen = deps.freezeProblems();
  if (frozen.length) throw new Error(`refusing to run a sealed set: the freeze does not hold:\n  ${frozen.join("\n  ")}`);
  const uncommitted = deps.uncommittedProblems();
  if (uncommitted.length) throw new Error(`refusing to run a sealed set: the files that bind it are not the committed ones:\n  ${uncommitted.join("\n  ")}`);

  const rows = deps.sealRows();
  const verify = deps.verify ?? verifySeal;
  const folderOf = (manifest: string) => dirname(manifest.startsWith("~/") ? join(deps.home, manifest.slice(2)) : manifest);
  let setDir: string | undefined;
  let b2Dir: string | undefined;
  for (const name of flags.sealed.split(",")) {
    const row = rows.find((r) => r.set === name);
    if (!row) throw new Error(`SEAL.md has no set named ${name}`);
    const check = verify(row, deps.home);
    if (!check.ok) throw new Error(`refusing to run a sealed set: the seal does not hold:\n  ${check.problems.slice(0, 10).join("\n  ")}`);
    log(`seal ok for ${name}: ${check.listed} files match SEAL.md; freeze ok; freeze and SEAL.md are the committed ones`);
    if (name === "b2") b2Dir = resolve(folderOf(row.manifest));
    else setDir ??= resolve(folderOf(row.manifest));
  }
  if (!setDir) throw new Error("--sealed names only b2: name the set of cases too, e.g. --sealed ha,b2");
  const root = setDir;
  setDir = flags.sub ? resolve(setDir, flags.sub) : setDir;
  if (!(setDir === root || setDir.startsWith(`${root}${sep}`))) throw new Error("refusing: --sub leaves the sealed set");
  let b2: string | undefined;
  if (flags.b2) {
    b2 = resolve(flags.b2);
    if (!b2Dir || !b2.startsWith(`${b2Dir}${sep}`)) throw new Error("refusing to use a --b2 module that is not inside the checked b2 set: pass --sealed <cases>,b2");
  }
  return { setDir, ...(b2 ? { b2 } : {}), sealed: true };
}
