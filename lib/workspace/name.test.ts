import { describe, expect, it } from "vitest";
import { validateWorkspaceName, normalizeForUniqueness, WorkspaceNameError, MAX_WORKSPACE_NAME_LENGTH } from "./name";

describe("validateWorkspaceName", () => {
  it("returns the trimmed, NFC-normalized display name for a valid input", () => {
    expect(validateWorkspaceName("  invoice-agent  ")).toBe("invoice-agent");
    // Decomposed "é" (e + combining acute) is folded to its composed form.
    expect(validateWorkspaceName("café")).toBe("café");
  });

  it.each([
    ["empty", ""],
    ["whitespace only", "   "],
    ["over length", "a".repeat(MAX_WORKSPACE_NAME_LENGTH + 1)],
    ["forward slash", "team/invoices"],
    ["back slash", "team\\invoices"],
    ["newline control char", "foo\nbar"],
    ["null control char", "foo\u0000bar"],
    ["leading dot", ".workspaces.json"],
    ["single dot", "."],
    ["double dot", ".."],
    ["colon", "team:invoices"],
    ["question mark", "why?"],
    ["quote", 'say "hi"'],
    ["pipe", "a|b"],
    ["asterisk", "a*"],
    ["angle bracket", "<agent>"],
    ["trailing dot", "invoices."],
    ["Windows device name", "CON"],
    ["Windows device name with extension", "nul.txt"],
    ["Windows port name", "com1"],
  ])("rejects %s with WORKSPACE_NAME_INVALID", (_label, name) => {
    expect(() => validateWorkspaceName(name)).toThrowError(WorkspaceNameError);
    try {
      validateWorkspaceName(name);
    } catch (err) {
      expect((err as WorkspaceNameError).code).toBe("WORKSPACE_NAME_INVALID");
    }
  });

  it("accepts accents, spaces, dots and dashes, which are valid folder names everywhere", () => {
    for (const name of ["Équipe ventes", "café", "v1.2 release", "a_b-c", "console", "Compta 2026"]) {
      expect(validateWorkspaceName(name)).toBe(name);
    }
  });

  it("accepts a name exactly at the length limit", () => {
    const name = "a".repeat(MAX_WORKSPACE_NAME_LENGTH);
    expect(validateWorkspaceName(name)).toBe(name);
  });
});

describe("normalizeForUniqueness", () => {
  it("folds case so differently-cased names collide", () => {
    expect(normalizeForUniqueness("Sales")).toBe(normalizeForUniqueness("sales"));
    expect(normalizeForUniqueness("SALES")).toBe(normalizeForUniqueness("Sales"));
  });

  it("folds Unicode form and surrounding whitespace", () => {
    expect(normalizeForUniqueness("  café ")).toBe(normalizeForUniqueness("café"));
  });

  it("keeps genuinely different names distinct", () => {
    expect(normalizeForUniqueness("sales")).not.toBe(normalizeForUniqueness("sales-eu"));
  });
});
