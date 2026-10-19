import { describe, expect, it } from "vitest";
import {
  deleteWorkspaceSecret,
  listWorkspaceSecrets,
  storeWorkspaceSecret,
  validateSecret,
  type SecretStore,
} from "./secrets";
import { WorkspaceUpdateError } from "./errors";
import type { Workspace } from "@/lib/workspace/types";

const offline = {
  id: "ws-1",
  name: "Alpha",
  dir: "/private/alpha",
  createdAt: new Date("2026-01-02T03:04:05Z"),
  maxIterations: 30,
  maxRunMinutes: 20,
  internetAccess: false,
} satisfies Workspace;

const lookup = (workspace: Workspace | undefined) => ({ getWorkspace: () => workspace });

const secretStore = (overrides: Partial<SecretStore> = {}): SecretStore => ({
  save: (_id, name) => ({ name, createdAt: "2026-08-03T00:00:00.000Z", domains: ["api.example.com"] }),
  read: () => [],
  ...overrides,
});

describe("third-party secret validation", () => {
  it("accepts a well-formed secret unchanged", () => {
    const input = { name: "API_TOKEN", value: "top-secret", domains: ["api.openai.com"] };
    expect(validateSecret(input)).toEqual(input);
  });

  // `secret` is the one object-valued field on the wire, so its shape is a claim. Reading `.name` off a
  // non-object threw a non-AppError 500; every malformed shape must be a named 400.
  it("refuses a secret that is not an object", () => {
    for (const input of [null, "TOKEN=x", 42, true, ["TOKEN"]]) {
      expect(() => validateSecret(input)).toThrow(WorkspaceUpdateError);
      expect(() => validateSecret(input)).toThrow("secret must be an object");
    }
  });

  // A missing member and a wrong-typed one are the same thing to a caller — a field not usably supplied
  // — so both get the message naming the accepted form rather than one of them getting a 500.
  it("refuses a wrong-typed member with the same message a missing one gets", () => {
    expect(() => validateSecret({})).toThrow("name must be uppercase");
    expect(() => validateSecret({ name: 5, value: "v", domains: ["api.example.com"] })).toThrow(
      "name must be uppercase",
    );
    expect(() => validateSecret({ name: "TOKEN", value: 5, domains: ["api.example.com"] })).toThrow("value required");
    expect(() => validateSecret({ name: "TOKEN", value: "v", domains: "api.example.com" })).toThrow(
      "add at least one allowed domain",
    );
    expect(() => validateSecret({ name: "TOKEN", value: "v", domains: [5] })).toThrow(
      "each allowed domain must be a hostname",
    );
    expect(() => validateSecret({ name: "TOKEN", value: "v", domains: [null] })).toThrow(
      "each allowed domain must be a hostname",
    );
  });

  it("requires an environment-variable name", () => {
    for (const name of ["bad-name", "lowercase", "1LEADING", ""]) {
      expect(() => validateSecret({ name, value: "v", domains: ["api.example.com"] })).toThrow(
        "name must be uppercase",
      );
    }
  });

  // Secrets go in as `docker exec -e`, outranking the container env, so names like the proxy, CA or shell vars
  // would break HTTPS in a way that looks like anything but a name clash.
  it("refuses names the container itself already uses", () => {
    for (const name of ["HTTPS_PROXY", "SSL_CERT_FILE", "NODE_EXTRA_CA_CERTS", "PATH", "BASH_ENV", "LD_PRELOAD"]) {
      expect(() => validateSecret({ name, value: "v", domains: ["api.example.com"] })).toThrow(WorkspaceUpdateError);
      expect(() => validateSecret({ name, value: "v", domains: ["api.example.com"] })).toThrow(
        "used by the workspace container itself",
      );
    }
  });

  // GH_TOKEN is what buildExecEnv aliases the github.com-scoped secret to, so a user naming their
  // token that outright is the expected case — reserving it would reject the obvious spelling.
  it("still accepts GH_TOKEN", () => {
    const input = { name: "GH_TOKEN", value: "ghp_x", domains: ["github.com"] };
    expect(validateSecret(input)).toEqual(input);
  });

  it("requires a non-blank value", () => {
    expect(() => validateSecret({ name: "TOKEN", value: "   ", domains: ["api.example.com"] })).toThrow(
      "value required",
    );
  });

  it("requires at least one allowed domain", () => {
    expect(() => validateSecret({ name: "TOKEN", value: "v", domains: [] })).toThrow("add at least one allowed domain");
  });

  it("rejects anything that cannot be read as a public hostname", () => {
    for (const domain of ["not a host", "localhost", "example", "", "api_example.com"]) {
      expect(() => validateSecret({ name: "TOKEN", value: "v", domains: [domain] })).toThrow(
        "each allowed domain must be a hostname",
      );
    }
  });

  // Hosts are normalized (scheme, path and port stripped) before checking, so a pasted endpoint URL is reduced
  // to its host, not rejected, despite the "must be a hostname" message.
  it("accepts a host that only needs normalizing, including a pasted URL", () => {
    for (const domain of ["API.EXAMPLE.COM", "https://api.example.com/v1/chat", "api.example.com:8443", " host.io "]) {
      expect(() => validateSecret({ name: "TOKEN", value: "v", domains: [domain] })).not.toThrow();
    }
  });
});

describe("listing third-party secrets", () => {
  it("reports name, date and scoped hosts — never the value", () => {
    const read = () => [
      { name: "VERCEL_TOKEN", createdAt: "2026-08-03T00:00:00.000Z", domains: ["api.vercel.com"], value: "secret" },
    ];
    const result = listWorkspaceSecrets("ws-1", lookup(offline), secretStore({ read }));

    expect(result).toEqual([
      {
        name: "VERCEL_TOKEN",
        createdAt: "2026-08-03T00:00:00.000Z",
        domains: ["api.vercel.com"],
        // The workspace has internetAccess: false, so a scoped secret is still dormant.
        blockedBy: "internetAccess",
      },
    ]);
    // The store shape could grow a value-bearing field; the operation must keep projecting it away.
    expect(result[0]).not.toHaveProperty("value");
  });

  // Without this, `domains` next to internetAccess:false reads as a live capability to any caller
  // that does not already know the two interact.
  it("omits blockedBy entirely once the workspace has egress", () => {
    const read = () => [{ name: "VERCEL_TOKEN", createdAt: "2026-08-03T00:00:00.000Z", domains: ["api.vercel.com"] }];
    const result = listWorkspaceSecrets("ws-1", lookup({ ...offline, internetAccess: true }), secretStore({ read }));

    expect(result).toEqual([
      { name: "VERCEL_TOKEN", createdAt: "2026-08-03T00:00:00.000Z", domains: ["api.vercel.com"] },
    ]);
    expect(result[0]).not.toHaveProperty("blockedBy");
  });

  it("marks a secret blocked when the allowlist restricts away every one of its hosts", () => {
    const read = () => [
      { name: "VERCEL_TOKEN", createdAt: "2026-08-03T00:00:00.000Z", domains: ["api.vercel.com"] },
      { name: "OPENAI_KEY", createdAt: "2026-08-03T00:00:00.000Z", domains: ["api.openai.com"] },
    ];
    const restricted = {
      ...offline,
      internetAccess: true,
      domainAllowlist: { restricted: true, domains: ["api.vercel.com"] },
    };
    const result = listWorkspaceSecrets("ws-1", lookup(restricted), secretStore({ read }));
    expect(result[0]).not.toHaveProperty("blockedBy");
    expect(result[1]).toMatchObject({ name: "OPENAI_KEY", blockedBy: "domainAllowlist" });
  });

  it("lists no secrets for an unknown workspace instead of reading the secret store", () => {
    const read = () => {
      throw new Error("must not read secrets for a workspace that does not exist");
    };
    expect(listWorkspaceSecrets("missing", lookup(undefined), secretStore({ read }))).toEqual([]);
  });
});

describe("storing a third-party secret", () => {
  it("passes the secret through to the store and reports it without its value", () => {
    const saves: unknown[][] = [];
    const result = storeWorkspaceSecret(
      "ws-1",
      { name: "API_TOKEN", value: "top-secret", domains: ["API.EXAMPLE.COM"] },
      lookup({ ...offline, internetAccess: true }),
      secretStore({
        save: (id, name, value, domains) => {
          saves.push([id, name, value, domains]);
          return { name, createdAt: "2026-08-03T00:00:00.000Z", domains: ["api.example.com"] };
        },
      }),
    );

    expect(saves).toEqual([["ws-1", "API_TOKEN", "top-secret", ["API.EXAMPLE.COM"]]]);
    expect(result).toEqual({
      name: "API_TOKEN",
      createdAt: "2026-08-03T00:00:00.000Z",
      domains: ["api.example.com"],
    });
    expect(result).not.toHaveProperty("value");
  });

  // Adding a key to a workspace with no egress succeeds, but the caller has to learn immediately that
  // it will not be spent — this is the one rule the list and the write share.
  it("marks a freshly stored secret as blocked when the workspace has no egress", () => {
    expect(
      storeWorkspaceSecret(
        "ws-1",
        { name: "API_TOKEN", value: "v", domains: ["api.example.com"] },
        lookup(offline),
        secretStore(),
      ),
    ).toMatchObject({ blockedBy: "internetAccess" });
  });

  it("reports a secret as blocked when the workspace vanished during the write", () => {
    expect(
      storeWorkspaceSecret(
        "ws-1",
        { name: "API_TOKEN", value: "v", domains: ["api.example.com"] },
        lookup(undefined),
        secretStore(),
      ),
    ).toMatchObject({ blockedBy: "internetAccess" });
  });
});

describe("deleting a third-party secret", () => {
  it("delegates the store mutation through one operation", () => {
    const calls: unknown[][] = [];
    expect(
      deleteWorkspaceSecret("ws-1", "API_TOKEN", lookup(offline), {
        delete: (id, name) => {
          calls.push([id, name]);
          return true;
        },
      }),
    ).toBe(true);
    expect(calls).toEqual([["ws-1", "API_TOKEN"]]);
  });

  it("returns null without mutating secrets for an unknown workspace", () => {
    expect(
      deleteWorkspaceSecret("missing", "API_TOKEN", lookup(undefined), {
        delete: () => {
          throw new Error("must not delete for an unknown workspace");
        },
      }),
    ).toBeNull();
  });
});
