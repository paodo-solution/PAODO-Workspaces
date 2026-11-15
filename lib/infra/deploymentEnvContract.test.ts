// Compose and the path modules must agree: an unset override silently resolves under /app. Also pins that the
// proxies inherit no .env, and that the app never holds a private key: those stay in credproxy and llm-proxy.
import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";

const REPO_ROOT = path.resolve(__dirname, "../..");
const COMPOSE_FILE = path.join(REPO_ROOT, "docker-compose.yml");

const PATH_MODULES = [
  "lib/infra/paths.ts",
  "lib/infra/proxy/proxyCaPaths.ts",
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
        "PAODO_PROXY_CA_ROOT",
        "PAODO_WORKSPACE_SECRET_VAULT_ROOT",
        "PAODO_WORKSPACE_SECRET_KEY_FILE",
      ]),
    );
    expect(declared).not.toContain("PAODO_PROVIDER_VAULT_ROOT");
    expect(declared).not.toContain("PAODO_PROVIDER_PRIVATE_KEY_FILE");
    expect(serviceBlock("credproxy")).not.toMatch(/provider-(vault|key)|llm_/);
  });

  it("keeps the provider private key out of the app, in llm-proxy and vault-init only", () => {
    const app = serviceBlock("app");
    expect(declaredEnvNames(app)).not.toContain("PAODO_PROVIDER_PRIVATE_KEY_FILE");
    expect(declaredEnvNames(app)).not.toContain("PAODO_PROVIDER_KEY_FILE");
    expect(app).not.toMatch(/provider-key/);
    for (const service of ["llm-proxy", "vault-init"]) {
      expect(serviceBlock(service)).toMatch(
        /^ {6}- PAODO_PROVIDER_PRIVATE_KEY_FILE=\/var\/lib\/paodo\/provider-key\//m,
      );
    }
  });

  it("gives llm-proxy its vault and key read-only, and nothing an agent can write to", () => {
    const llm = serviceBlock("llm-proxy");
    expect(llm).toMatch(/^ {6}- provider-vault:\/var\/lib\/paodo\/provider-vault:ro$/m);
    expect(llm).toMatch(/^ {6}- provider-key:\/var\/lib\/paodo\/provider-key:ro$/m);
    expect(llm).not.toMatch(/workspaces:|proxy-ca|workspace-secret|socket/);
    expect(llm).not.toMatch(/^ {4}env_file:/m);
    expect(llm).toMatch(/^ {4}read_only: true$/m);
  });

  it("lets only the app reach llm-proxy, over a network with no route out", () => {
    expect(serviceBlock("llm-proxy")).toMatch(/^ {4}networks:\n {6}- llm_net\n {6}- llm_egress_net\n/m);
    expect(serviceBlock("app")).toMatch(/^ {6}- llm_net$/m);
    expect(serviceBlock("app")).toMatch(/^ {6}- PAODO_LLM_PROXY_URL=http:\/\/llm-proxy:9997$/m);
    const networks = /^networks:\n([\s\S]*)$/m.exec(fs.readFileSync(COMPOSE_FILE, "utf-8"))?.[1] ?? "";
    expect(networks).toMatch(/^ {2}llm_net:\n {4}internal: true$/m);
  });

  it("mounts the proxy CA outside the workspaces root in every service", () => {
    for (const service of ["app", "credproxy"]) {
      const block = serviceBlock(service);
      expect(block).toMatch(/^ {6}- PAODO_PROXY_CA_ROOT=\/var\/lib\/paodo\/proxy-ca$/m);
      expect(block).toMatch(/^ {6}- proxy-ca:\/var\/lib\/paodo\/proxy-ca(:ro)?$/m);
      expect(block).not.toMatch(/\/var\/lib\/paodo\/data\//);
    }
  });

  it("keeps the workspace-secret private key out of the app, in credproxy and vault-init only", () => {
    const app = serviceBlock("app");
    expect(declaredEnvNames(app)).not.toContain("PAODO_WORKSPACE_SECRET_KEY_FILE");
    expect(app).not.toMatch(/workspace-secret-key/);
    for (const service of ["credproxy", "vault-init"]) {
      expect(serviceBlock(service)).toMatch(
        /^ {6}- PAODO_WORKSPACE_SECRET_KEY_FILE=\/var\/lib\/paodo\/workspace-secret-key\//m,
      );
    }
    expect(serviceBlock("credproxy")).toMatch(
      /^ {6}- workspace-secret-key:\/var\/lib\/paodo\/workspace-secret-key:ro$/m,
    );
  });

  it("runs vault-init with no network before both services that use the vault", () => {
    expect(serviceBlock("vault-init")).toMatch(/^ {4}network_mode: none$/m);
    for (const service of ["app", "credproxy", "llm-proxy"]) {
      expect(serviceBlock(service)).toMatch(/^ {6}vault-init:\n {8}condition: service_completed_successfully$/m);
    }
  });

  it("never lets credproxy inherit the admin credentials in .env", () => {
    expect(serviceBlock("credproxy")).not.toMatch(/^ {4}env_file:/m);
    expect(serviceBlock("llm-proxy")).not.toMatch(/^ {4}env_file:/m);
    expect(serviceBlock("app")).toMatch(/^ {4}env_file:/m);
  });
});
