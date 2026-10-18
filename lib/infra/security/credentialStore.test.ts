// validate() authenticates every programmatic caller, so the deny paths are pinned; "no key" and "disabled"
// are the common states. The matrix runs per kind, since a bug in one shared branch breaks all three.

import { afterAll, describe, expect, it, vi } from "vitest";
import fs from "fs";

// Redirect the store to a temp dir before paths.ts reads WORKSPACES_ROOT at import; vi.hoisted runs above
// the imports, so the real ./data is never touched.
const { ROOT, auditEvents } = vi.hoisted(() => {
  const os = require("os");
  const fs = require("fs");
  const path = require("path");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "credentials-test-"));
  process.env.WORKSPACES_ROOT = root;
  return { ROOT: root, auditEvents: [] as Array<Record<string, unknown>> };
});

// The audit stream is the only record of when access ended, so it is asserted on rather than
// discarded. Both loggers are stubbed because the real ones write to a pino destination.
vi.mock("../logger", () => ({
  createLogger: () => ({ error: () => {}, warn: () => {}, info: () => {}, debug: () => {} }),
  createAuditLogger: () => ({
    info: (fields: Record<string, unknown>) => {
      auditEvents.push(fields);
    },
  }),
}));

import {
  type CredentialKind,
  type CredentialSubject,
  mint,
  remove,
  removeWorkspace,
  revoke,
  setEnabled,
  state,
  validate,
} from "./credentialStore";

afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));

// Each kind with a subject that keeps its records distinct from other tests', since the store is a
// process-global shared across this file. Workspace ids are suffixed per-case below.
const KINDS: ReadonlyArray<{ kind: CredentialKind; prefix: string; subject: (name: string) => CredentialSubject }> = [
  { kind: "workspace-api", prefix: "sk_", subject: (name) => `ws-api-${name}` },
  { kind: "workspace-mcp", prefix: "mcp_", subject: (name) => `ws-mcp-${name}` },
  // The platform credential is instance-wide, so every case shares the one record. Ordering within a
  // case is therefore what matters — each mint() below fully overwrites the previous state.
  { kind: "platform", prefix: "cli_", subject: () => null },
];

// A usable credential is minted AND on an open channel. Validation tests call issue() once, so a bare mint()
// below means deliberately nothing else.
function issue(kind: CredentialKind, target: CredentialSubject): string {
  const plain = mint(kind, target);
  setEnabled(kind, target, true);
  return plain;
}

describe.each(KINDS)("$kind — validate fails closed", ({ kind, prefix, subject }) => {
  it("denies a credential that was never configured", () => {
    expect(validate(kind, subject("never-configured"), "anything")).toBe(false);
  });

  it("denies the CORRECT key once the channel is disabled", () => {
    // The headline case: toggling access off must lock the door even for a caller holding a
    // once-valid key.
    const target = subject("disabled");
    const plain = issue(kind, target);
    expect(validate(kind, target, plain)).toBe(true); // sanity: works while enabled

    setEnabled(kind, target, false);
    expect(validate(kind, target, plain)).toBe(false);
  });

  it("denies a revoked key even while the channel stays enabled", () => {
    const target = subject("revoked");
    const plain = issue(kind, target);
    revoke(kind, target);
    expect(state(kind, target).enabled).toBe(true);
    expect(validate(kind, target, plain)).toBe(false);
  });

  it("denies a wrong or empty key on an enabled channel", () => {
    const target = subject("wrong");
    issue(kind, target);
    // A never-minted key of the right prefix and length pins the hash compare, not a shape check. A literal, since
    // re-minting the instance-wide credential would overwrite the record under test.
    expect(validate(kind, target, `${prefix}${"0".repeat(64)}`)).toBe(false);
    expect(validate(kind, target, "")).toBe(false);
  });

  it("denies the previous key after rotation, and accepts the new one", () => {
    const target = subject("rotated");
    const previous = issue(kind, target);
    // A bare mint: rotation replaces the key on a channel that is already open, and must leave it
    // open — the new key works immediately without anyone re-enabling anything.
    const current = mint(kind, target);
    expect(validate(kind, target, previous)).toBe(false);
    expect(validate(kind, target, current)).toBe(true);
  });

  it("denies a removed credential", () => {
    const target = subject("removed");
    const plain = mint(kind, target);
    remove(kind, target);
    expect(validate(kind, target, plain)).toBe(false);
  });
});

describe.each(KINDS)("$kind — validate authorizes the legitimate case", ({ kind, prefix, subject }) => {
  it("mints a prefixed key that validates while enabled", () => {
    const target = subject("valid");
    const plain = issue(kind, target);
    expect(plain.startsWith(prefix)).toBe(true);
    expect(validate(kind, target, plain)).toBe(true);
  });

  // Mint is the credential axis, the flag the access axis; if mint opened the channel, issuing a key in advance
  // would silently expose it.
  it("leaves the channel's enabled flag untouched", () => {
    const closed = subject("mint-keeps-closed");
    setEnabled(kind, closed, false);
    const plain = mint(kind, closed);
    expect(state(kind, closed)).toMatchObject({ enabled: false, hasKey: true });
    expect(validate(kind, closed, plain)).toBe(false);

    const open = subject("mint-keeps-open");
    setEnabled(kind, open, true);
    mint(kind, open);
    expect(state(kind, open).enabled).toBe(true);
  });

  it("accepts again after disable then re-enable", () => {
    const target = subject("toggle");
    const plain = mint(kind, target);
    setEnabled(kind, target, false);
    expect(validate(kind, target, plain)).toBe(false);
    setEnabled(kind, target, true);
    expect(validate(kind, target, plain)).toBe(true);
  });

  it("produces a unique key per mint", () => {
    expect(mint(kind, subject("unique-a"))).not.toBe(mint(kind, subject("unique-b")));
  });
});

describe("state — never exposes a hash", () => {
  it("returns only the public fields", () => {
    mint("workspace-api", "ws-state");
    // Asserting on the key set, not just the absence of one name: a future field carrying hash
    // material would fail this instead of slipping through to a JSON response.
    expect(Object.keys(state("workspace-api", "ws-state")).sort()).toEqual([
      "createdAt",
      "enabled",
      "hasKey",
      "lastUsedAt",
    ]);
  });

  it("reports a channel enabled before any key exists", () => {
    // The UI's "Key required" state — enabling must not imply a usable credential.
    setEnabled("workspace-api", "ws-no-key", true);
    expect(state("workspace-api", "ws-no-key")).toMatchObject({ enabled: true, hasKey: false });
    expect(validate("workspace-api", "ws-no-key", "sk_anything")).toBe(false);
  });

  // Revoking destroys the key and leaves the channel exactly as open as it was: the two are
  // separate decisions, and a revocation must not quietly make one of them for the operator.
  it("reports hasKey false after revocation, without closing the channel", () => {
    issue("workspace-api", "ws-state-revoked");
    revoke("workspace-api", "ws-state-revoked");
    expect(state("workspace-api", "ws-state-revoked")).toMatchObject({ enabled: true, hasKey: false });
  });

  it("records createdAt on mint and lastUsedAt on first successful validate", () => {
    const plain = issue("workspace-api", "ws-timestamps");
    expect(state("workspace-api", "ws-timestamps")).toMatchObject({ lastUsedAt: null });
    expect(typeof state("workspace-api", "ws-timestamps").createdAt).toBe("string");

    validate("workspace-api", "ws-timestamps", plain);
    expect(state("workspace-api", "ws-timestamps").lastUsedAt).not.toBeNull();
  });

  it("does not record lastUsedAt for a failed validate", () => {
    mint("workspace-api", "ws-failed-use");
    validate("workspace-api", "ws-failed-use", "sk_wrong");
    expect(state("workspace-api", "ws-failed-use").lastUsedAt).toBeNull();
  });
});

// revoke() is idempotent, so `credential_revoked` must mean a key stopped working right then; retries and
// keyless channels must not log revocations that never happened.
describe("revoke — audits only a revocation that happened", () => {
  const revocations = () => auditEvents.filter((event) => event.event === "credential_revoked");

  it("emits one event for the mint that was actually destroyed", () => {
    const before = revocations().length;
    issue("workspace-api", "ws-audit-once");

    revoke("workspace-api", "ws-audit-once");

    expect(revocations()).toHaveLength(before + 1);
    expect(revocations().at(-1)).toMatchObject({ kind: "workspace-api", subject: "ws-audit-once" });
  });

  it("stays silent on a repeat revoke, and on a channel that never had a key", () => {
    const before = revocations().length;
    issue("workspace-api", "ws-audit-repeat");
    revoke("workspace-api", "ws-audit-repeat");

    revoke("workspace-api", "ws-audit-repeat");
    revoke("workspace-api", "ws-audit-never-keyed");
    setEnabled("workspace-api", "ws-audit-enabled-only", true);
    revoke("workspace-api", "ws-audit-enabled-only");

    expect(revocations()).toHaveLength(before + 1);
  });

  it("still succeeds on all of those, because revoking must never throw", () => {
    expect(() => revoke("workspace-api", "ws-audit-absent")).not.toThrow();
    expect(state("workspace-api", "ws-audit-absent").hasKey).toBe(false);
  });
});

describe("persistence", () => {
  it("writes only the hash, never the plaintext", () => {
    const plain = mint("workspace-api", "ws-persisted");
    expect(fs.readFileSync(`${ROOT}/.credentials.json`, "utf8")).not.toContain(plain);
  });

  it("denies rather than throws when a stored hash is the wrong length", () => {
    // timingSafeEqual throws on a length mismatch from a corrupted store; that must fail closed, not 500. Reaching
    // into the singleton is the only way to hit that branch.
    const plain = mint("workspace-api", "ws-corrupt");
    const singletons = (global as typeof global & { __singletons: Record<string, unknown> }).__singletons;
    const records = singletons.credentials as Record<string, { hash: string }>;
    records["workspace-api:ws-corrupt"].hash = "deadbeef"; // valid hex, wrong length

    expect(() => validate("workspace-api", "ws-corrupt", plain)).not.toThrow();
    expect(validate("workspace-api", "ws-corrupt", plain)).toBe(false);
  });
});

describe("subject rules", () => {
  it("rejects a subject on the instance-wide platform credential", () => {
    expect(() => state("platform", "ws-1")).toThrow(/instance-wide/);
  });

  it("rejects a missing workspace id on the per-workspace kinds", () => {
    expect(() => state("workspace-api", null)).toThrow(/requires a workspace id/);
    expect(() => state("workspace-mcp", null)).toThrow(/requires a workspace id/);
  });
});

describe("removeWorkspace", () => {
  it("drops both workspace credentials and leaves the platform token alone", () => {
    const apiKey = mint("workspace-api", "ws-doomed");
    const mcpKey = mint("workspace-mcp", "ws-doomed");
    const platformToken = mint("platform");

    removeWorkspace("ws-doomed");

    expect(validate("workspace-api", "ws-doomed", apiKey)).toBe(false);
    expect(validate("workspace-mcp", "ws-doomed", mcpKey)).toBe(false);
    expect(state("workspace-api", "ws-doomed").hasKey).toBe(false);
    expect(state("workspace-mcp", "ws-doomed").hasKey).toBe(false);
    expect(validate("platform", null, platformToken)).toBe(true);
  });

  it("is a no-op for a workspace that never had credentials", () => {
    expect(() => removeWorkspace("ws-never-existed")).not.toThrow();
  });
});
