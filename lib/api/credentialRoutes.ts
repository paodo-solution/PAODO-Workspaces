// Shared POST/DELETE/PATCH for the three credential endpoints (workspace API key, MCP key, CLI token).
// GET stays per-route because each returns different extras; they all spread the same credential state.
import { NextResponse } from "next/server";
import type { CredentialKind, CredentialSubject } from "@/lib/infra/security/credentialStore";
import { issueCredential, revokeCredential, setCredentialEnabled } from "@/lib/operations/credentials/manage";
import type { WorkspaceAccessDetails } from "@/lib/operations/workspace/access";
import { appErrorResponse, errorResponse, readJsonObject } from "@/lib/api/errorResponse";
import { createLogger } from "@/lib/infra/logger";

const log = createLogger("api").child({ route: "credentials" });

/**
 * Resolves the credential's subject from the route's params, or returns a Response to short-circuit
 * with (a 404 from requireWorkspace, say). Instance-wide credentials resolve to null.
 */
export type SubjectResolver<P> = (params: P, request: Request) => Promise<CredentialSubject | Response>;

export interface CredentialHandlers<P> {
  /** Generates or rotates as requested in the body. The plaintext is returned here and never again. */
  POST(request: Request, context: { params: Promise<P> }): Promise<Response>;
  /**
   * Revokes the key, leaving the channel's enabled flag alone. Refused when there is no key to
   * destroy. Answers with both axes as they stand afterwards, so the caller sees a channel left open
   * without a key.
   */
  DELETE(request: Request, context: { params: Promise<P> }): Promise<Response>;
  /** Opens or closes the channel: `{ enabled: boolean }`. */
  PATCH(request: Request, context: { params: Promise<P> }): Promise<Response>;
}

interface CredentialHandlerOptions {
  /**
   * Replaces the plain credential-store toggle for channels that have more to do than flip a flag.
   * Receives the request so any error it returns carries the same request id as every other response
   * on this route — an override that cannot correlate its own failures is worse than the default.
   */
  setEnabled?: (
    kind: CredentialKind,
    subject: CredentialSubject,
    enabled: boolean,
    request: Request,
  ) => void | Response | Promise<void | Response>;
  /**
   * Wire name for the key field in issue receipts. When supplied, the plaintext is returned under
   * this name instead of `plain`, so the receipt vocabulary matches the broader context (workspace
   * get, channel state). Absent for the instance-wide CLI token.
   */
  keyField?: string;
  /**
   * Wire names for the two axes in the revocation receipt. A workspace channel passes the same pair the
   * workspace projection uses, so `revoke` and `get` describe one channel in one vocabulary instead of
   * renaming it between calls. Typed against WorkspaceAccessDetails so a rename there fails the build
   * here rather than quietly splitting the two apart again.
   *
   * Defaults to the credential routes' own `enabled` / `hasKey` for the instance-wide token, which has
   * no workspace field to borrow a name from.
   */
  axisFields?: { access: keyof WorkspaceAccessDetails; hasKey: keyof WorkspaceAccessDetails };
  /**
   * Extra facts about the subject to carry on every key receipt, so generate, rotate and revoke all
   * answer with the same set of fields and a caller reads one shape whichever verb it called.
   *
   * A workspace channel supplies its workspace's `internetAccess` here. That flag does not gate either
   * channel — egress and inbound are independent (lib/operations/workspace/access.ts) — and it is
   * reported rather than acted on for exactly that reason: a caller assembling a workspace's external
   * posture wants all of it in one answer, and getting it as a plain boolean beside the two axes is
   * what stops it being mistaken for the thing that made a key work or not.
   *
   * Absent for the instance-wide CLI token, which has no subject to describe.
   */
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

/**
 * The externally reachable origin for the workspace API and MCP endpoints, which are published on a
 * DNS-direct host (see deploy/caddy/Caddyfile) rather than the UI's. Null when unconfigured,
 * so the UI can fall back to showing a relative path instead of a wrong absolute one.
 */
export function publicBaseUrl(): string | null {
  const configured = process.env.WORKSPACE_API_DOMAIN?.trim();
  if (!configured) return null;
  return `https://${configured.replace(/^https?:\/\//, "").replace(/\/+$/, "")}`;
}
