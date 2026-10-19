// buildWorkspacePromptInputs gathers AGENTS.md and the drives block for every system prompt; pins each
// present/absent combination.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import type { Drive } from "@/lib/drives/store";

// Drive lookup is mocked so the test owns it; formatDriveLine mirrors production so assertions see the real
// `- <name> (id: <id>)<desc>` shape.
const getDrivesForWorkspace = vi.fn<(workspaceId: string) => Drive[]>();
vi.mock("@/lib/drives/store", () => ({
  getDrivesForWorkspace: (id: string) => getDrivesForWorkspace(id),
  formatDriveLine: (d: Drive) => `- ${d.name} (id: ${d.id})${d.description ? ` — ${d.description}` : ""}`,
}));

const listSecretMeta = vi.fn();
vi.mock("../infra/security/workspaceSecretStore", () => ({
  listSecretMeta: (id: string) => listSecretMeta(id),
}));

// Controls the workspace's internetAccess flag that buildSecretsInfo (and buildNetworkInfo) read —
// mocked so tests don't depend on the real on-disk workspace registry.
const getWorkspace = vi.fn();
vi.mock("../infra/services", () => ({
  getStore: () => ({ getWorkspace: (id: string) => getWorkspace(id) }),
  getContainers: () => ({ listBackground: () => [] }),
}));

import { buildWorkspacePromptInputs } from "./promptContext";

function drive(name: string, description?: string, id = `${name}-id`): Drive {
  return { id, name, description, createdAt: "2026-01-01T00:00:00Z" };
}

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "promptctx-"));
  getDrivesForWorkspace.mockReset();
  getDrivesForWorkspace.mockReturnValue([]);
  listSecretMeta.mockReset();
  listSecretMeta.mockReturnValue([]);
  getWorkspace.mockReset();
  getWorkspace.mockReturnValue(undefined); // no workspace record at all → internetAccess fails closed to false
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("buildWorkspacePromptInputs", () => {
  it("returns trimmed AGENTS.md content when the file exists", () => {
    fs.writeFileSync(path.join(dir, "AGENTS.md"), "\n  # House rules\nBe nice.\n  ");
    const { agentsContent } = buildWorkspacePromptInputs("ws1", dir);
    expect(agentsContent).toBe("# House rules\nBe nice.");
  });

  it("leaves agentsContent undefined when AGENTS.md is missing", () => {
    const { agentsContent } = buildWorkspacePromptInputs("ws1", dir);
    expect(agentsContent).toBeUndefined();
  });

  it("leaves drivesInfo undefined when no drives are connected", () => {
    const { drivesInfo } = buildWorkspacePromptInputs("ws1", dir);
    expect(drivesInfo).toBeUndefined();
  });

  it("builds a drives block listing each connected drive and the one-home rule", () => {
    getDrivesForWorkspace.mockReturnValue([drive("shared", "team files"), drive("scratch")]);
    const { drivesInfo } = buildWorkspacePromptInputs("ws1", dir);
    expect(getDrivesForWorkspace).toHaveBeenCalledWith("ws1");
    expect(drivesInfo).toContain("# Connected drives");
    expect(drivesInfo).toContain("- shared (id: shared-id) — team files");
    expect(drivesInfo).toContain("- scratch (id: scratch-id)"); // no description → no em dash
    expect(drivesInfo).not.toContain("scratch-id) —");
    expect(drivesInfo).toContain("After uploading a file to a drive, delete your local copy");
    expect(drivesInfo).toContain("downloads/ is disposable");
  });

  it("gathers AGENTS.md and drives independently in one call", () => {
    fs.writeFileSync(path.join(dir, "AGENTS.md"), "rules");
    getDrivesForWorkspace.mockReturnValue([drive("d1")]);
    const inputs = buildWorkspacePromptInputs("ws1", dir);
    expect(inputs.agentsContent).toBe("rules");
    expect(inputs.drivesInfo).toContain("- d1");
  });

  it("lists each secret's allowed hosts and proxy-compatible usage guidance", () => {
    getWorkspace.mockReturnValue({ internetAccess: true });
    listSecretMeta.mockReturnValue([{ name: "VERCEL_TOKEN", domains: ["api.vercel.com"], createdAt: "2026-01-01" }]);
    const { secretsInfo } = buildWorkspacePromptInputs("ws1", dir);
    expect(secretsInfo).toContain("VERCEL_TOKEN → api.vercel.com");
    expect(secretsInfo).toContain("never print them");
    expect(secretsInfo).toContain("before making a request");
  });

  it("omits secretsInfo entirely when internet access is off, even with secrets configured", () => {
    getWorkspace.mockReturnValue({ internetAccess: false });
    listSecretMeta.mockReturnValue([{ name: "VERCEL_TOKEN", domains: ["api.vercel.com"], createdAt: "2026-01-01" }]);
    const { secretsInfo } = buildWorkspacePromptInputs("ws1", dir);
    expect(secretsInfo).toBeUndefined();
  });

  it("documents secrets again once internet access is back on", () => {
    getWorkspace.mockReturnValue({ internetAccess: true });
    listSecretMeta.mockReturnValue([{ name: "VERCEL_TOKEN", domains: ["api.vercel.com"], createdAt: "2026-01-01" }]);
    const { secretsInfo } = buildWorkspacePromptInputs("ws1", dir);
    expect(secretsInfo).toContain("VERCEL_TOKEN → api.vercel.com");
  });

  describe("domain allowlist", () => {
    const restricted = (domains: string[]) => ({
      internetAccess: true,
      domainAllowlist: { restricted: true, domains },
    });

    it("lists the allowed hosts and tells the agent to name a refused host instead of retrying", () => {
      getWorkspace.mockReturnValue(restricted(["api.vercel.com", "registry.npmjs.org"]));
      const { networkInfo } = buildWorkspacePromptInputs("ws1", dir);
      expect(networkInfo).toContain("# Internet access — RESTRICTED");
      expect(networkInfo).toContain("- api.vercel.com\n- registry.npmjs.org");
      expect(networkInfo).toContain("matched exactly");
      expect(networkInfo).toContain("tell the user which exact host to add");
    });

    it("keeps the open-internet text while the list is empty, since nothing is enforced yet", () => {
      getWorkspace.mockReturnValue(restricted([]));
      const { networkInfo } = buildWorkspacePromptInputs("ws1", dir);
      expect(networkInfo).toContain("This workspace has internet access.");
      expect(networkInfo).not.toContain("RESTRICTED");
    });

    it("keeps the open-internet text while a kept list isn't restricted", () => {
      getWorkspace.mockReturnValue({
        internetAccess: true,
        domainAllowlist: { restricted: false, domains: ["a.com"] },
      });
      const { networkInfo } = buildWorkspacePromptInputs("ws1", dir);
      expect(networkInfo).toContain("This workspace has internet access.");
      expect(networkInfo).not.toContain("RESTRICTED");
    });

    it("keeps the disabled text when internet is off, whatever the allowlist says", () => {
      getWorkspace.mockReturnValue({ ...restricted(["api.vercel.com"]), internetAccess: false });
      expect(buildWorkspacePromptInputs("ws1", dir).networkInfo).toContain("# Internet access — DISABLED");
    });

    it("marks a secret whose host the allowlist omits", () => {
      getWorkspace.mockReturnValue(restricted(["api.vercel.com"]));
      listSecretMeta.mockReturnValue([
        { name: "VERCEL_TOKEN", domains: ["api.vercel.com"], createdAt: "2026-01-01" },
        { name: "OPENAI_KEY", domains: ["api.openai.com"], createdAt: "2026-01-01" },
      ]);
      const { secretsInfo } = buildWorkspacePromptInputs("ws1", dir);
      expect(secretsInfo).toContain("- VERCEL_TOKEN → api.vercel.com\n");
      expect(secretsInfo).toContain("- OPENAI_KEY → api.openai.com (blocked: api.openai.com not allowed)");
    });
  });
});
