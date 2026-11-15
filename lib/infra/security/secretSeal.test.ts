// A sealed value opens only with the proxy's private key and only under the binding it was sealed with.
import { describe, expect, it } from "vitest";
import { createPrivateKey } from "crypto";
import { generateRecipientKeyPair, recipientOf, seal } from "./secretSeal";
import { openSealed } from "./secretOpen";

const pair = generateRecipientKeyPair();
const privateKey = createPrivateKey(pair.privateKeyPem);
const binding = { wsId: "ws1", name: "CRM_TOKEN", domains: ["api.crm.example", "crm.example"] };

const flip = (b64: string): string => {
  const buf = Buffer.from(b64, "base64");
  buf[0] ^= 0xff;
  return buf.toString("base64");
};

describe("seal / openSealed", () => {
  it("round-trips, and the sealed form never contains the value", () => {
    const sealed = seal("crm-secret-value", pair.recipient, binding);
    expect(JSON.stringify(sealed)).not.toContain("crm-secret-value");
    expect(openSealed(sealed, privateKey, binding)).toBe("crm-secret-value");
  });

  it("ignores domain order, as the store sorts them anyway", () => {
    const sealed = seal("v", pair.recipient, binding);
    expect(openSealed(sealed, privateKey, { ...binding, domains: [...binding.domains].reverse() })).toBe("v");
  });

  it("uses a fresh ephemeral key per value", () => {
    const a = seal("same", pair.recipient, binding);
    const b = seal("same", pair.recipient, binding);
    expect(a.epk).not.toBe(b.epk);
    expect(a.data).not.toBe(b.data);
  });

  it("refuses another private key", () => {
    const other = createPrivateKey(generateRecipientKeyPair().privateKeyPem);
    expect(() => openSealed(seal("v", pair.recipient, binding), other, binding)).toThrow();
  });

  it("refuses a value moved to another workspace, name or domain", () => {
    const sealed = seal("v", pair.recipient, binding);
    expect(() => openSealed(sealed, privateKey, { ...binding, wsId: "ws2" })).toThrow();
    expect(() => openSealed(sealed, privateKey, { ...binding, name: "OTHER" })).toThrow();
    expect(() => openSealed(sealed, privateKey, { ...binding, domains: ["attacker.example"] })).toThrow();
    expect(() => openSealed(sealed, privateKey, { ...binding, domains: [...binding.domains, "x.example"] })).toThrow();
  });

  it("refuses any tampered field", () => {
    const sealed = seal("v", pair.recipient, binding);
    for (const field of ["iv", "tag", "data"] as const) {
      expect(() => openSealed({ ...sealed, [field]: flip(sealed[field]) }, privateKey, binding)).toThrow();
    }
  });
});

describe("recipientOf", () => {
  it("derives the recipient a key pair was generated with", () => {
    expect(recipientOf(pair.privateKeyPem)).toBe(pair.recipient);
  });

  it("refuses a key that is not X25519", () => {
    const { generateKeyPairSync } = require("crypto");
    const ed = generateKeyPairSync("ed25519").privateKey.export({ format: "pem", type: "pkcs8" });
    expect(() => recipientOf(ed)).toThrow(/X25519/);
  });
});
