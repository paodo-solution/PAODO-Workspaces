// Pins the at-rest guarantees of the workspace-secret vault: values are sealed so only the proxy's private key
// opens them, malformed files are rejected, and the app side stores and lists secrets without any key.

import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import fs from "fs";
import path from "path";

// Redirect vault and key storage before their path module is evaluated.
const { ROOT, KEY_FILE } = vi.hoisted(() => {
  const os = require("os");
  const fs = require("fs");
  const path = require("path");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "secret-store-test-"));
  process.env.PAODO_WORKSPACE_SECRET_VAULT_ROOT = path.join(root, "workspace-vault");
  process.env.PAODO_WORKSPACE_SECRET_KEY_FILE = path.join(root, "workspace-key", "private.pem");
  delete (global as Record<string, unknown>)._workspaceSecretVaultState;
  return { ROOT: root, KEY_FILE: path.join(root, "workspace-key", "private.pem") };
});

import { initWorkspaceSecretVault } from "./workspaceSecretVaultInit";

const FILE = path.join(ROOT, "workspace-vault", "vault.json");

// The store loads from disk once at module evaluation and caches on global. To exercise the
// load paths repeatedly, each test clears the shared state and re-imports a fresh instance.
async function freshStore() {
  delete (global as Record<string, unknown>)._workspaceSecretVaultState;
  vi.resetModules();
  return await import("./workspaceSecretStore");
}

// The credential proxy's view: the same vault, plus the private key.
async function proxyRules() {
  const rules = await import("../proxy/workspaceSecretRules");
  rules.loadSecretPrivateKey();
  return rules;
}

beforeEach(() => {
  fs.rmSync(FILE, { force: true });
  fs.rmSync(KEY_FILE, { force: true });
  initWorkspaceSecretVault({ vaultFile: FILE, privateKeyFile: KEY_FILE });
});

afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));

describe("sealed at rest", () => {
  it("never writes the value in plaintext, and only the private key opens it", async () => {
    const store = await freshStore();
    store.setSecret("ws1", "OPENAI_API_KEY", "sk-live-abc123", ["api.openai.com"]);

    const raw = fs.readFileSync(FILE, "utf-8");
    expect(raw).not.toContain("sk-live-abc123");
    expect(JSON.parse(raw).version).toBe(2);

    const reloaded = await freshStore();
    expect(reloaded.listSecretMeta("ws1").map((m) => m.name)).toEqual(["OPENAI_API_KEY"]);
    const rules = (await proxyRules()).getWorkspaceRules("ws1");
    expect(rules).toHaveLength(1);
    expect(rules[0].domain).toBe("api.openai.com");
    expect([...rules[0].tokenMap.values()]).toEqual(["sk-live-abc123"]);
  });

  it("stores and deletes secrets without the private key on disk (the app's position)", async () => {
    fs.renameSync(KEY_FILE, KEY_FILE + ".away");
    try {
      const store = await freshStore();
      store.setSecret("ws1", "DEPLOY_TOKEN", "value", ["api.example.com"]);
      expect(store.listSecretMeta("ws1")).toHaveLength(1);
      expect(store.deleteSecret("ws1", "DEPLOY_TOKEN")).toBe(true);
    } finally {
      fs.renameSync(KEY_FILE + ".away", KEY_FILE);
    }
  });

  it("supports multiple allowed hosts per secret", async () => {
    const store = await freshStore();
    store.setSecret("ws1", "GITHUB_PAT", "ghp_secret", [
      "github.com",
      "api.GitHub.com",
      " https://api.github.com/path ",
    ]);

    expect(store.listSecretMeta("ws1")[0].domains).toEqual(["api.github.com", "github.com"]);
    const rules = (await proxyRules()).getWorkspaceRules("ws1").sort((a, b) => a.domain.localeCompare(b.domain));
    expect(rules.map((r) => r.domain)).toEqual(["api.github.com", "github.com"]);
    expect(rules[0].tokenMap.size + rules[1].tokenMap.size).toBe(2);
  });

  it("skips a value moved to another domain instead of injecting it there", async () => {
    const store = await freshStore();
    store.setSecret("ws1", "CRM_TOKEN", "crm-secret", ["api.crm.example"]);
    const vault = JSON.parse(fs.readFileSync(FILE, "utf-8"));
    vault.workspaceSecrets.ws1.CRM_TOKEN.domains = ["attacker.example"];
    fs.writeFileSync(FILE, JSON.stringify(vault));

    await freshStore();
    expect((await proxyRules()).getWorkspaceRules("ws1")).toEqual([]);
  });

  it("rejects a plaintext file instead of treating it as a legacy store", async () => {
    fs.writeFileSync(FILE, JSON.stringify({ ws1: { MY_KEY: { value: "plaintext-secret" } } }));

    const store = await freshStore();
    expect(store.listSecretMeta("ws1")).toEqual([]);
    expect(() => store.assertSecretStoreAvailable()).toThrow();
    expect(() => store.setSecret("ws1", "K", "v", ["api.example.com"])).toThrow(/unavailable/);
  });

  it("reports a former-format vault as needing vault-init", async () => {
    fs.writeFileSync(FILE, JSON.stringify({ v: 1, alg: "aes-256-gcm", iv: "a", tag: "b", data: "c" }));
    const store = await freshStore();
    expect(() => store.assertSecretStoreAvailable()).toThrow(/vault-init/);
  });

  it("marks a missing vault unavailable: vault-init always creates one first", async () => {
    fs.rmSync(FILE);
    const store = await freshStore();
    expect(store.listSecretMeta("anything")).toEqual([]);
    expect(() => store.assertSecretStoreAvailable()).toThrow();
  });

  it("starts empty and available on a freshly initialized vault", async () => {
    const store = await freshStore();
    expect(store.listSecretMeta("anything")).toEqual([]);
    expect(() => store.assertSecretStoreAvailable()).not.toThrow();
  });
});

describe("proxyToken", () => {
  it("is stable and alphanumeric-only so common CLIs can accept it before the proxy substitutes it", async () => {
    const { proxyToken } = await freshStore();
    const token = proxyToken("3923f8e7-c383-4802-a270-66877ea0a940", "VERCEL_TOKEN");
    expect(token).toMatch(/^p[a-f0-9]{64}$/);
    expect(proxyToken("3923f8e7-c383-4802-a270-66877ea0a940", "VERCEL_TOKEN")).toBe(token);
    expect(proxyToken("3923f8e7-c383-4802-a270-66877ea0a940", "OTHER_TOKEN")).not.toBe(token);
  });

  it("maps only its CLI-safe token to the real value", async () => {
    const store = await freshStore();
    store.setSecret("ws1", "API_KEY", "real-value", ["api.example.com"]);
    const map = (await proxyRules()).getWorkspaceRules("ws1")[0].tokenMap;
    expect(map.get(store.proxyToken("ws1", "API_KEY"))).toBe("real-value");
    expect(map.size).toBe(1);
  });
});

describe("reloadSecretStore (credential-proxy sidecar reader)", () => {
  it("picks up secrets written by another process after reload", async () => {
    // `reader` models the sidecar: loaded once while the app mutates the shared file; only reloadSecretStore()
    // shows it the changes.
    const reader = await freshStore();
    const rules = await proxyRules();
    reader.setSecret("ws1", "K1", "v1", ["api.openai.com"]);
    expect(reader.listSecretWorkspaceIds()).toEqual(["ws1"]);

    const app = await freshStore(); // fresh in-memory instance, same FILE on disk
    app.setSecret("ws2", "K2", "v2", ["api.example.com"]);

    expect(reader.listSecretWorkspaceIds()).toEqual(["ws1"]);
    reader.reloadSecretStore();
    expect(reader.listSecretWorkspaceIds().sort()).toEqual(["ws1", "ws2"]);
    expect(rules.getWorkspaceRules("ws2")).toEqual([
      { domain: "api.example.com", tokenMap: new Map([[reader.proxyToken("ws2", "K2"), "v2"]]) },
    ]);
  });

  it("drops a workspace whose secrets were all removed on disk after reload", async () => {
    const reader = await freshStore();
    reader.setSecret("ws1", "K1", "v1", ["api.openai.com"]);

    const app = await freshStore();
    app.deleteAllForWorkspace("ws1");

    reader.reloadSecretStore();
    expect(reader.listSecretWorkspaceIds()).toEqual([]);
  });
});

describe("selectGithubTokenSecret", () => {
  it("returns null when no secret is scoped to github.com", async () => {
    const { selectGithubTokenSecret } = await freshStore();
    expect(selectGithubTokenSecret([])).toBeNull();
    expect(selectGithubTokenSecret([{ name: "OPENAI_KEY", domains: ["api.openai.com"] }])).toBeNull();
  });

  it("picks the github.com-scoped secret regardless of its name", async () => {
    const { selectGithubTokenSecret } = await freshStore();
    expect(selectGithubTokenSecret([{ name: "MY_PAT", domains: ["github.com"] }])).toBe("MY_PAT");
  });

  it("prefers GITHUB_TOKEN, then GH_TOKEN, then a GITHUB/GH-ish name on ties", async () => {
    const { selectGithubTokenSecret } = await freshStore();
    const gh = { name: "GH_TOKEN", domains: ["github.com"] };
    const ghToken = { name: "GITHUB_TOKEN", domains: ["github.com"] };
    const ish = { name: "MY_GH_PAT", domains: ["github.com"] };
    const plain = { name: "MY_PAT", domains: ["github.com"] };
    expect(selectGithubTokenSecret([plain, gh, ghToken])).toBe("GITHUB_TOKEN");
    expect(selectGithubTokenSecret([plain, gh])).toBe("GH_TOKEN");
    expect(selectGithubTokenSecret([plain, ish])).toBe("MY_GH_PAT");
    expect(selectGithubTokenSecret([plain])).toBe("MY_PAT");
  });

  it("does not treat an incidental GH/GITHUB substring as a token-name match on ties", async () => {
    const { selectGithubTokenSecret } = await freshStore();
    // HIGH_SCORE contains "GH" but is not a github token name; with two non-special candidates the
    // GH/GITHUB tiebreak must skip it and fall through to the first candidate.
    const high = { name: "HIGH_SCORE", domains: ["github.com"] };
    const plain = { name: "MY_PAT", domains: ["github.com"] };
    expect(selectGithubTokenSecret([high, plain])).toBe("HIGH_SCORE"); // falls through to first
    // But a real token-style name still wins the tiebreak over a plain one.
    expect(selectGithubTokenSecret([high, { name: "MY_GITHUB_PAT", domains: ["github.com"] }])).toBe("MY_GITHUB_PAT");
  });

  it("requires an exact github.com host — subdomains like api.github.com do not qualify", async () => {
    const { selectGithubTokenSecret } = await freshStore();
    expect(selectGithubTokenSecret([{ name: "API_ONLY", domains: ["api.github.com"] }])).toBeNull();
  });
});
