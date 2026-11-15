// Every key and vault sits outside the workspace data root, so no bug in serving workspace files can reach it.
import { describe, expect, it, vi } from "vitest";
import path from "path";

const { BASE } = vi.hoisted(() => {
  const os = require("os");
  const fs = require("fs");
  const path = require("path");
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "secret-boundaries-test-"));
  process.env.PAODO_PROXY_CA_ROOT = path.join(base, "proxy-ca");
  process.env.PAODO_PROVIDER_VAULT_ROOT = path.join(base, "provider-vault");
  process.env.PAODO_WORKSPACE_SECRET_VAULT_ROOT = path.join(base, "workspace-secret-vault");
  process.env.PAODO_WORKSPACE_SECRET_KEY_FILE = path.join(base, "workspace-secret-key", "master.key");
  return { BASE: base };
});

import { assertSecretStorageSeparated } from "./secretVaultPaths";

describe("assertSecretStorageSeparated", () => {
  it("accepts a data root beside every key and vault", () => {
    expect(() => assertSecretStorageSeparated(path.join(BASE, "data"))).not.toThrow();
  });

  it("refuses a data root that contains the proxy CA (the old .proxy-ca layout)", () => {
    expect(() => assertSecretStorageSeparated(BASE)).toThrow(/workspace data and proxy CA/);
  });
});
