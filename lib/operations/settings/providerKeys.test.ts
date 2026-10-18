// Write boundary for the key the app spends with: a value never comes back through the API, and a withdrawn
// provider cannot be re-keyed, or <PROVIDER>_AVAILABLE=false is undone by re-pasting.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { listProviderKeys, providerHasKey, removeProviderKey, storeProviderKey } from "./providerKeys";
import { SUPPORTED_PROVIDERS, providerAvailabilityEnv } from "@/lib/agent/buildModel";
import { getProviderKey, _resetProviderKeysForTest } from "@/lib/infra/security/providerKeyStore";

const offerOnly = (...providers: string[]) => {
  for (const p of SUPPORTED_PROVIDERS)
    vi.stubEnv(providerAvailabilityEnv(p)!, providers.includes(p) ? "true" : "false");
};

beforeEach(() => _resetProviderKeysForTest());
afterEach(() => {
  vi.unstubAllEnvs();
  _resetProviderKeysForTest();
});

describe("storeProviderKey", () => {
  it("stores the key and reports its status without echoing it", () => {
    offerOnly("anthropic");
    const status = storeProviderKey("anthropic", "sk-ant-the-real-value");

    expect(getProviderKey("anthropic")).toBe("sk-ant-the-real-value");
    expect(JSON.stringify(status)).not.toContain("sk-ant-the-real-value");
    expect(status).toMatchObject({ provider: "anthropic", hasKey: true, hint: "alue" });
  });

  // Dashboard pastes often carry a trailing newline, and a whitespace-broken key looks exactly like a wrong
  // one, even when re-pasted.
  it("trims surrounding whitespace rather than storing an unusable key", () => {
    offerOnly("anthropic");
    storeProviderKey("anthropic", "  sk-ant-value\n");
    expect(getProviderKey("anthropic")).toBe("sk-ant-value");
  });

  it.each([
    ["an empty string", ""],
    ["only whitespace", "   "],
    ["a number", 12345],
    ["null", null],
    ["missing entirely", undefined],
  ])("rejects %s", (_label, value) => {
    offerOnly("anthropic");
    expect(() => storeProviderKey("anthropic", value)).toThrow(/non-empty string/);
  });

  // No format check: vendors change key shapes without warning, and a confident validator eventually locks out
  // a working key. Only the provider can judge, on the next run.
  it("accepts a value that looks nothing like a key", () => {
    offerOnly("anthropic");
    expect(() => storeProviderKey("anthropic", "not-remotely-a-key")).not.toThrow();
  });

  it("replaces an existing key rather than adding a second", () => {
    offerOnly("anthropic");
    storeProviderKey("anthropic", "first-value");
    storeProviderKey("anthropic", "second-value");
    expect(getProviderKey("anthropic")).toBe("second-value");
    expect(listProviderKeys().filter((p) => p.hasKey)).toHaveLength(1);
  });

  // The enforcement half of the availability switch. Without this the purge would be theatre: the
  // operator switches openai off, the key is destroyed at startup, and anyone can paste it back.
  it("refuses to key a provider this deployment has switched off", () => {
    offerOnly("anthropic");
    expect(() => storeProviderKey("openai", "sk-openai")).toThrow(/OPENAI_AVAILABLE=false/);
    expect(getProviderKey("openai")).toBeUndefined();
  });

  // Two mistakes, two messages. Naming a variable that does not exist ("NOT-A-VENDOR_AVAILABLE")
  // sends someone who simply mistyped a provider off looking through their .env for it.
  it("tells an unknown provider apart from a switched-off one", () => {
    offerOnly("anthropic");
    expect(() => storeProviderKey("not-a-vendor", "sk")).toThrow(/not a provider this app supports/);
    expect(() => storeProviderKey("not-a-vendor", "sk")).not.toThrow(/AVAILABLE=false/);
  });
});

describe("listProviderKeys", () => {
  // The form needs a row for a provider precisely when there is nothing stored for it — otherwise
  // there is nowhere to add the first key.
  it("lists every offered provider, keyed or not", () => {
    offerOnly("anthropic", "deepseek");
    storeProviderKey("deepseek", "sk-ds-value");

    expect(listProviderKeys()).toEqual([
      { provider: "anthropic", hasKey: false },
      { provider: "deepseek", hasKey: true, createdAt: expect.any(String), hint: "alue" },
    ]);
  });

  it("never carries a value, for any provider", () => {
    offerOnly("anthropic", "deepseek");
    storeProviderKey("anthropic", "sk-ant-secret-aaa");
    storeProviderKey("deepseek", "sk-ds-secret-bbb");

    const serialized = JSON.stringify(listProviderKeys());
    expect(serialized).not.toContain("sk-ant-secret-aaa");
    expect(serialized).not.toContain("sk-ds-secret-bbb");
  });

  it("omits a provider that was switched off, even though its key may not be purged yet", () => {
    // Between the config change and the restart that purges, the store can still hold the key. The
    // list follows availability so the form cannot offer to manage a provider that is gone.
    offerOnly("anthropic", "deepseek");
    storeProviderKey("deepseek", "sk-ds");
    offerOnly("anthropic");
    expect(listProviderKeys().map((p) => p.provider)).toEqual(["anthropic"]);
  });
});

describe("removeProviderKey", () => {
  it("removes the key and says it did", () => {
    offerOnly("anthropic");
    storeProviderKey("anthropic", "sk-ant");
    expect(removeProviderKey("anthropic")).toEqual({ provider: "anthropic", removed: true });
    expect(getProviderKey("anthropic")).toBeUndefined();
  });

  // Idempotent: the caller's intent — no key for this provider — already holds, so this is a success
  // with nothing done, not an error the UI has to explain.
  it("succeeds with removed=false when there was nothing stored", () => {
    offerOnly("anthropic");
    expect(removeProviderKey("anthropic")).toEqual({ provider: "anthropic", removed: false });
  });

  it("refuses a provider this deployment does not offer", () => {
    offerOnly("anthropic");
    expect(() => removeProviderKey("openai")).toThrow(/switched off in this deployment/);
  });
});

describe("providerHasKey", () => {
  it("answers the coarse question the model catalog publishes", () => {
    offerOnly("anthropic");
    expect(providerHasKey("anthropic")).toBe(false);
    storeProviderKey("anthropic", "sk-ant");
    expect(providerHasKey("anthropic")).toBe(true);
  });
});
