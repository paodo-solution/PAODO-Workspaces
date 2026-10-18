// Per-workspace injection rules and their auth check, kept socket-free so it's testable on its own.
import { verifyProxySecret } from "./proxyCA";
import { createAuditLogger } from "../logger";
import type { DomainRule } from "../security/workspaceSecretStore";

const audit = createAuditLogger("credentialProxy");

// The workspace id + secret a container presented in its Proxy-Authorization header.
export interface ProxyAuth {
  wsId: string;
  secret: string;
}

export class WorkspaceRuleStore {
  private rules = new Map<string, DomainRule[]>();

  setRules(wsId: string, rules: DomainRule[]): void {
    if (rules.length === 0) {
      this.rules.delete(wsId);
    } else this.rules.set(wsId, rules);
  }

  clearRules(wsId: string): void {
    this.rules.delete(wsId);
  }

  // Rules apply only if the secret matches the id; a wrong secret gets none, so nothing is substituted
  // (fails closed).
  resolve(auth: ProxyAuth | null): DomainRule[] {
    if (auth && verifyProxySecret(auth.wsId, auth.secret)) {
      return this.rules.get(auth.wsId) ?? [];
    }
    const wsId = auth?.wsId ?? "";
    if (this.rules.has(wsId)) {
      audit.warn({ wsId, event: "proxy_auth_rejected" }, "proxy secret mismatch — refusing credential injection");
    }
    return [];
  }
}
