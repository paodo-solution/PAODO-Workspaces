// Moves a workspace's saved .deb files between its container and the volume with `docker cp`, never a mount,
// so an existing container needs no recreation. Package names only ever travel as argv, never through a shell.
import { rm } from "fs/promises";
import { createLogger } from "../logger";
import { workspaceAptDebsDir } from "../paths";
import {
  createDebStaging,
  parseDebFileName,
  readAptDebIndex,
  storeCapturedDebs,
  verifyAptDebs,
  type InstalledPackage,
} from "../aptDebs";
import { containerName } from "./naming";
import type { IDockerClient } from "./dockerClient";
import { APT_KEEP_DIR } from "../../workspace/apt";

const log = createLogger("aptDebs");

// Under /root, which the uid-1000 agent cannot enter, and `docker cp` writes as root.
const REPLAY_DIR = "/root/.paodo-apt-debs";
const AS_ROOT = { asRoot: true, trimStdout: true } as const;
const QUERY_FORMAT = "-f=${Package}\\t${Architecture}\\t${Version}\\t${Status}\\n";
const INSTALLED = "install ok installed";

function parseInstalled(stdout: string): InstalledPackage[] {
  return stdout
    .split("\n")
    .map((line) => line.split("\t"))
    .filter((cols) => cols.length === 4 && cols[3] === INSTALLED)
    .map(([pkg, arch, version]) => ({ package: pkg, arch, version }));
}

/** Installed state of the named packages; a name dpkg does not know is simply absent from the result. */
async function queryInstalled(docker: IDockerClient, name: string, packages: string[]): Promise<InstalledPackage[]> {
  if (packages.length === 0) return [];
  const r = await docker.exec(name, ["dpkg-query", "-W", QUERY_FORMAT, ...packages], AS_ROOT);
  // Exit 1 only means some name matched no package.
  if (r.code > 1) throw new Error(`dpkg-query failed: ${r.stderr || `exit ${r.code}`}`);
  return parseInstalled(r.stdout);
}

/** Recipe specs (`name` or `name=version`) with no installed package of that name. */
export async function missingPackages(docker: IDockerClient, name: string, specs: string[]): Promise<string[]> {
  const installed = new Set(
    (
      await queryInstalled(
        docker,
        name,
        specs.map((s) => s.split("=")[0]),
      )
    ).map((p) => p.package),
  );
  return specs.filter((spec) => !installed.has(spec.split("=")[0]));
}

// Saves what apt left in its download cache, keeping only installed versions. Call it before the cache is
// cleaned. Returns the keys it added; throws on failure, which callers log without failing the install.
export async function captureDebs(docker: IDockerClient, workspaceId: string): Promise<string[]> {
  const name = containerName(workspaceId);
  const list = await docker.exec(
    name,
    ["find", APT_KEEP_DIR, "-maxdepth", "1", "-type", "f", "-name", "*.deb", "-printf", "%f\\n"],
    AS_ROOT,
  );
  if (list.code !== 0) throw new Error(`listing apt downloads failed: ${list.stderr || `exit ${list.code}`}`);
  const downloaded = list.stdout.split("\n").flatMap((file) => parseDebFileName(file) ?? []);
  const saved = Object.values(readAptDebIndex(workspaceId));
  const names = [...new Set([...downloaded, ...saved].map((p) => p.package))];
  if (names.length === 0) return [];

  const installed = await queryInstalled(docker, name, names);
  const staging = await createDebStaging(workspaceId);
  try {
    if (downloaded.length > 0) {
      const cp = await docker.cmd("cp", `${name}:${APT_KEEP_DIR}/.`, staging);
      if (cp.code !== 0) throw new Error(`docker cp of apt downloads failed: ${cp.stderr || `exit ${cp.code}`}`);
    }
    return await storeCapturedDebs(workspaceId, staging, installed);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

// Installs the saved set with no network: apt resolves dependencies from the files and the image alone.
// A set that fails its hashes is never handed to root. Never throws: the caller downloads whatever is left.
export async function installSavedDebs(docker: IDockerClient, workspaceId: string): Promise<void> {
  const { debs, problems } = await verifyAptDebs(workspaceId);
  if (problems.length > 0) {
    log.error(
      { event: "apt_debs_integrity_failed", outcome: "saved_packages_not_installed", workspaceId, problems },
      "saved apt packages failed verification — not installing them",
    );
    return;
  }
  if (debs.length === 0) return;

  const name = containerName(workspaceId);
  const failed = (stderr: string) =>
    log.warn(
      { event: "apt_debs_install_failed", outcome: "saved_packages_not_installed", workspaceId, stderr },
      "offline install of the saved apt packages failed",
    );
  try {
    const cp = await docker.cmd("cp", `${workspaceAptDebsDir(workspaceId)}/.`, `${name}:${REPLAY_DIR}`);
    if (cp.code !== 0) return failed(`docker cp: ${cp.stderr || `exit ${cp.code}`}`);
    const files = debs.map((deb) => `${REPLAY_DIR}/${deb.file}`);
    const install = await docker.exec(name, ["apt-get", "install", "-y", "--no-install-recommends", ...files], AS_ROOT);
    if (install.code !== 0) failed(install.stderr);
  } catch (err) {
    failed(err instanceof Error ? err.message : String(err));
  } finally {
    await docker.exec(name, ["rm", "-rf", REPLAY_DIR], AS_ROOT).catch(() => {});
  }
}
