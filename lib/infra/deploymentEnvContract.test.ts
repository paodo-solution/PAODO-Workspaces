// Compose and the path modules must agree: an unset override silently resolves under /app. Also pins that
// credproxy, the one container a sandbox can reach, inherits no .env and cannot see the provider vault.
import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";

const REPO_ROOT = path.resolve(__dirname, "../..");
const COMPOSE_FILE = path.join(REPO_ROOT, "docker-compose.yml");

const PATH_MODULES = [
  "lib/infra/paths.ts",
  "lib/infra/security/providerKeyPaths.ts",
  "lib/infra/security/workspaceSecretPaths.ts",
];

/** Env vars whose absence falls back to a path under process.cwd(). */
function cwdRelativeOverrides(): string[] {
  const found = new Set<string>();
  for (const file of PATH_MODULES) {
    const source = fs.readFileSync(path.join(REPO_ROOT, file), "utf-8");
    for (const [, name] of source.matchAll(/process\.env\.(\w+)\s*\?\?\s*path\.resolve\(\s*process\.cwd\(\)/g)) {
      found.add(name);
    }
  }
  return [...found].sort();
}

/** One service's YAML block, from its key to the next key at the same indent. */
function serviceBlock(name: string): string {
  const source = fs.readFileSync(COMPOSE_FILE, "utf-8");
  const block = new RegExp(`^ {2}${name}:\\n([\\s\\S]*?)(?=^ {2}\\S|^\\S)`, "m").exec(source);
  if (!block) throw new Error(`no "${name}" service in docker-compose.yml — the compose shape changed`);
  return block[1];
}

/** The env var names a service declares inline, ignoring their values. */
function declaredEnvNames(block: string): string[] {
  const section = /^ {4}environment:\n([\s\S]*?)(?=^ {4}\S)/m.exec(block);
  if (!section) return [];
  return [...section[1].matchAll(/^ {6}- ([A-Z0-9_]+)=/gm)].map(([, name]) => name).sort();
}

describe("deployment env contract", () => {
  it("gives every cwd-relative path override an explicit value in the app service", () => {
    const overrides = cwdRelativeOverrides();
    // A zero-length scan means the fallback idiom moved and this test stopped guarding anything.
    expect(overrides.length).toBeGreaterThan(0);
    expect(declaredEnvNames(serviceBlock("app"))).toEqual(expect.arrayContaining(overrides));
  });

  it("gives credproxy the workspace-secret vault and nothing about providers", () => {
    const declared = declaredEnvNames(serviceBlock("credproxy"));
    expect(declared).toEqual(
      expect.arrayContaining([
        "WORKSPACES_ROOT",
        "PAODO_WORKSPACE_SECRET_VAULT_ROOT",
        "PAODO_WORKSPACE_SECRET_KEY_FILE",
      ]),
    );
    expect(declared).not.toContain("PAODO_PROVIDER_VAULT_ROOT");
    expect(declared).not.toContain("PAODO_PROVIDER_KEY_FILE");
  });

  it("never lets credproxy inherit the admin credentials in .env", () => {
    expect(serviceBlock("credproxy")).not.toMatch(/^ {4}env_file:/m);
    expect(serviceBlock("app")).toMatch(/^ {4}env_file:/m);
  });
});
