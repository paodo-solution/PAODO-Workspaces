// Shared POST/DELETE/PATCH for the three credential endpoints (workspace API key, MCP key, CLI token).
// GET stays per-route because each returns different extras; they all spread the same credential state.
import { NextResponse } from "next/server";
import type { CredentialKind, CredentialSubject } from "@/lib/infra/security/credentialStore";
import { issueCredential, revokeCredential, setCredentialEnabled } from "@/lib/operations/credentials/manage";
import type { WorkspaceAccessDetails } from "@/lib/operations/workspace/access";
import { appErrorResponse, errorResponse, readJsonObject } from "@/lib/api/errorResponse";
import { createLogger } from "@/lib/infra/logger";

const log = createLogger("api").child({ route: "credentials" });

// Resolves the credential's subject from the route's params, or returns a Response to short-circuit
// with (a 404 from requireWorkspace, say). Instance-wide credentials resolve to null.
export type SubjectResolver<P> = (params: P, request: Request) => Promise<CredentialSubject | Response>;

export interface CredentialHandlers<P> {
  /** Generates or rotates as requested in the body. The plaintext is returned here and never again. */
  POST(request: Request, context: { params: Promise<P> }): Promise<Response>;
  // Revokes the key but leaves `enabled`; refused if there's no key. Returns both axes, so a channel
  // left open without a key is visible.
  DELETE(request: Request, context: { params: Promise<P> }): Promise<Response>;
  /** Opens or closes the channel: `{ enabled: boolean }`. */
  PATCH(request: Request, context: { params: Promise<P> }): Promise<Response>;
}

interface CredentialHandlerOptions {
  // Overrides the plain toggle for channels that do more than flip a flag. Gets the request so its
  // errors carry the route's request id.
  setEnabled?: (
    kind: CredentialKind,
    subject: CredentialSubject,
    enabled: boolean,
    request: Request,
  ) => void | Response | Promise<void | Response>;
  /** Receipt name for the plaintext instead of `plain`, matching the workspace vocabulary. */
  keyField?: string;
  // Revocation-receipt names for the two axes, typed against WorkspaceAccessDetails so `revoke` and
  // `get` can't drift. Defaults to `enabled`/`hasKey` for the CLI token.
  axisFields?: { access: keyof WorkspaceAccessDetails; hasKey: keyof WorkspaceAccessDetails };
  // Extra subject facts on every receipt, so all verbs share one shape (e.g. `internetAccess`, reported
  // but gating nothing). Absent for the CLI token.
  receiptContext?: (subject: CredentialSubject) => Record<string, unknown>;
}

const NO_STORE = { "Cache-Control": "no-store" } as const;

async function readCredentialOperation(request: Request): Promise<unknown | Response> {
  const body = await readJsonObject(request);
  if (body instanceof Response) return body;
  return body.operation;
}

async function readEnabled(request: Request): Promise<boolean | Response> {
  const body = await readJsonObject(request);
  if (body instanceof Response) return body;
  const enabled = body.enabled;
  if (typeof enabled !== "boolean") {
    return errorResponse("INVALID_REQUEST", "enabled must be true or false", {
      request,
      details: { field: "enabled" },
    });
  }
  return enabled;
}

export function credentialHandlers<P>(
  kind: CredentialKind,
  resolveSubject: SubjectResolver<P>,
  options: CredentialHandlerOptions = {},
): CredentialHandlers<P> {
  async function subjectFor(request: Request, context: { params: Promise<P> }): Promise<CredentialSubject | Response> {
    return resolveSubject(await context.params, request);
  }

  const axisFields = options.axisFields ?? ({ access: "enabled", hasKey: "hasKey" } as const);
  // Not named `context`: every handler below already takes a route `context` parameter, which would
  // shadow this and turn each receipt into an opaque 500.
  const subjectFacts = (subject: CredentialSubject) => options.receiptContext?.(subject) ?? {};

  function failed(request: Request, operation: string, err: unknown): Response {
    const expected = appErrorResponse(err, request);
    if (expected) return expected;
    log.error(
      {
        event: "credential_operation_failed",
        outcome: "credential_not_changed",
        code: "INTERNAL_ERROR",
        err,
        credentialKind: kind,
        operation,
      },
      "credential operation failed",
    );
    return errorResponse("INTERNAL_ERROR", "credential operation failed", { request });
  }

  return {
    async POST(request, context) {
      try {
        const subject = await subjectFor(request, context);
        if (subject instanceof Response) return subject;
        const operation = await readCredentialOperation(request);
        if (operation instanceof Response) return operation;
        // Naming generate vs rotate stops either one from hitting a slot the caller misjudged. no-store keeps
        // the one-time plaintext out of caches; the reply carries both axes, like DELETE's.
        const issued = issueCredential(kind, subject, operation);
        const keyFieldName = options.keyField || "plain";
        return NextResponse.json(
          {
            ok: true,
            [keyFieldName]: issued.plain,
            [axisFields.access]: issued.enabled,
            [axisFields.hasKey]: issued.hasKey,
            ...subjectFacts(subject),
          },
          { headers: NO_STORE },
        );
      } catch (err) {
        return failed(request, "mint", err);
      }
    },

    async DELETE(request, context) {
      try {
        const subject = await subjectFor(request, context);
        if (subject instanceof Response) return subject;
        // 409 on an empty slot, so a caller clearing a leak knows this request destroyed it. Works whether or
        // not the channel is enabled; replies with both axes but no timestamps (they'd describe the dead key).
        const after = revokeCredential(kind, subject);
        return NextResponse.json(
          { ok: true, [axisFields.access]: after.enabled, [axisFields.hasKey]: after.hasKey, ...subjectFacts(subject) },
          { headers: NO_STORE },
        );
      } catch (err) {
        return failed(request, "revoke", err);
      }
    },

    async PATCH(request, context) {
      try {
        const subject = await subjectFor(request, context);
        if (subject instanceof Response) return subject;
        const enabled = await readEnabled(request);
        if (enabled instanceof Response) return enabled;
        const response = options.setEnabled
          ? await options.setEnabled(kind, subject, enabled, request)
          : setCredentialEnabled(kind, subject, enabled);
        if (response instanceof Response) return response;
        return NextResponse.json({ ok: true }, { headers: NO_STORE });
      } catch (err) {
        return failed(request, "set_enabled", err);
      }
    },
  };
}

// The API/MCP origin, a DNS-direct host separate from the UI (Caddyfile). Null when unconfigured, so the
// UI shows a relative path rather than a wrong absolute one.
export function publicBaseUrl(): string | null {
  const configured = process.env.WORKSPACE_API_DOMAIN?.trim();
  if (!configured) return null;
  return `https://${configured.replace(/^https?:\/\//, "").replace(/\/+$/, "")}`;
}
