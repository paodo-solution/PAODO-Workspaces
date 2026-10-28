// The saved .deb files of a workspace's installed apt packages, so a rebuilt container reinstalls them with no
// network. Filesystem only: getting files out of and into a container is aptDebsTransfer.ts's job.
import { mkdir, mkdtemp, readdir, rename, rm } from "fs/promises";
import path from "path";
import { WORKSPACES_ROOT, workspaceAptDebsDir } from "./paths";
import { atomicSaveJson, readJson } from "./jsonPersist";
import { exists, sha256File } from "./archive/core";

export const APT_DEBS_INDEX = "index.json";

export interface InstalledPackage {
  package: string;
  arch: string;
  version: string;
}

export interface SavedDeb extends InstalledPackage {
  file: string;
  sha256: string;
}

/** One entry per installed package, keyed by `debKey`. */
export type AptDebIndex = Record<string, SavedDeb>;

const debKey = (p: { package: string; arch: string }): string => `${p.package}:${p.arch}`;

// apt names its downloads <package>_<version>_<arch>.deb, percent-encoding the epoch's ':'. Anything else,
// including a name that could leave the folder, is not one of its files.
export function parseDebFileName(file: string): InstalledPackage | null {
  const match = /^([^_/]+)_([^_/]+)_([^_/]+)\.deb$/.exec(file);
  if (!match) return null;
  try {
    return {
      package: decodeURIComponent(match[1]),
      version: decodeURIComponent(match[2]),
      arch: decodeURIComponent(match[3]),
    };
  } catch {
    return null;
  }
}

const indexFile = (workspaceId: string, root: string) =>
  path.join(workspaceAptDebsDir(workspaceId, root), APT_DEBS_INDEX);

export function readAptDebIndex(workspaceId: string, root: string = WORKSPACES_ROOT): AptDebIndex {
  const index = readJson<AptDebIndex>(indexFile(workspaceId, root), {});
  return index && typeof index === "object" && !Array.isArray(index) ? index : {};
}

/** A scratch folder beside the saved set, so moving a staged file into it is a rename. */
export async function createDebStaging(workspaceId: string, root: string = WORKSPACES_ROOT): Promise<string> {
  const dir = workspaceAptDebsDir(workspaceId, root);
  await mkdir(path.dirname(dir), { recursive: true });
  return mkdtemp(`${dir}.tmp-`);
}

// Keeps the staged downloads that match an installed version, then drops every entry whose package was
// removed or upgraded, so the set is exactly what is installed. Returns the keys it added.
export async function storeCapturedDebs(
  workspaceId: string,
  stagingDir: string,
  installed: InstalledPackage[],
  root: string = WORKSPACES_ROOT,
): Promise<string[]> {
  const dir = workspaceAptDebsDir(workspaceId, root);
  await mkdir(dir, { recursive: true });
  const installedVersion = new Map(installed.map((p) => [debKey(p), p.version]));
  const index = readAptDebIndex(workspaceId, root);
  const added: string[] = [];

  for (const file of await readdir(stagingDir)) {
    const deb = parseDebFileName(file);
    if (!deb || installedVersion.get(debKey(deb)) !== deb.version) continue;
    const target = path.join(dir, file);
    await rename(path.join(stagingDir, file), target);
    index[debKey(deb)] = { ...deb, file, sha256: await sha256File(target) };
    added.push(debKey(deb));
  }
  for (const [key, deb] of Object.entries(index)) {
    if (installedVersion.get(key) !== deb.version) delete index[key];
  }
  atomicSaveJson(indexFile(workspaceId, root), index);

  const referenced = new Set(Object.values(index).map((deb) => deb.file));
  for (const file of await readdir(dir)) {
    if (file.endsWith(".deb") && !referenced.has(file)) await rm(path.join(dir, file), { force: true });
  }
  return added;
}

export interface VerifiedDebs {
  debs: SavedDeb[];
  problems: string[];
}

// Re-hashes every saved file against the index before root installs it. The set may have come back from a
// backup, so a file the index does not vouch for is a problem, not something to install.
export async function verifyAptDebs(workspaceId: string, root: string = WORKSPACES_ROOT): Promise<VerifiedDebs> {
  const dir = workspaceAptDebsDir(workspaceId, root);
  const debs = Object.values(readAptDebIndex(workspaceId, root));
  const problems: string[] = [];
  for (const deb of debs) {
    if (!parseDebFileName(deb.file)) {
      problems.push(`${deb.file}: not a .deb file name`);
      continue;
    }
    const file = path.join(dir, deb.file);
    if (!(await exists(file))) problems.push(`${deb.file}: missing`);
    else if ((await sha256File(file)) !== deb.sha256) problems.push(`${deb.file}: sha256 does not match the index`);
  }
  return { debs, problems };
}
