// Attaches the credproxy sidecar (never the app) to each workspace network, so workspaces reach only the
// proxy. CA and env wiring live in containerCredentials.ts.
import { createLogger } from "../logger";
import type { IDockerClient } from "./dockerClient";
import { CONTAINER_PREFIX, networkName, workspaceIdFromContainerName } from "./naming";

const log = createLogger("container");

const CREDENTIAL_PROXY_ALIAS = process.env.CREDENTIAL_PROXY_ALIAS ?? "credproxy";
const CREDENTIAL_PROXY_CONTAINER = process.env.CREDENTIAL_PROXY_CONTAINER ?? "paodo_ws_credproxy";

export class ProxyNetworkManager {
  constructor(private docker: IDockerClient) {}

  // Attaches the sidecar so `${CREDENTIAL_PROXY_ALIAS}` resolves to the proxy. Idempotent.
  async attach(workspaceId: string): Promise<void> {
    const r = await this.docker.cmd(
      "network",
      "connect",
      "--alias",
      CREDENTIAL_PROXY_ALIAS,
      networkName(workspaceId),
      CREDENTIAL_PROXY_CONTAINER,
    );
    if (r.code !== 0 && !/already (exists|connected)/i.test(r.stderr)) {
      log.warn({ workspaceId, stderr: r.stderr }, "failed to attach credential proxy to workspace network");
    }
  }

  // Host-side check (network inspect), since the workspace image may lack getent/nslookup.
  private async isAttached(workspaceId: string): Promise<boolean> {
    const r = await this.docker.cmd(
      "network",
      "inspect",
      networkName(workspaceId),
      "--format",
      "{{range .Containers}}{{.Name}} {{end}}",
    );
    if (r.code !== 0) return false;
    return r.stdout.split(/\s+/).includes(CREDENTIAL_PROXY_CONTAINER);
  }

  // Reattaches a sidecar a redeploy dropped, and throws an actionable error if it's still unreachable, rather
  // than letting egress silently black-hole.
  async verify(workspaceId: string): Promise<void> {
    if (await this.isAttached(workspaceId)) return;
    log.warn({ workspaceId }, "credential proxy not attached to workspace network — reattaching");
    await this.attach(workspaceId);
    if (await this.isAttached(workspaceId)) return;
    throw new Error(
      `workspace egress proxy (${CREDENTIAL_PROXY_ALIAS}) is not attached to ${networkName(workspaceId)} — ` +
        `check the ${CREDENTIAL_PROXY_CONTAINER} sidecar is running`,
    );
  }

  // Detach the sidecar before removing a workspace network — `network rm` fails while an endpoint is
  // still attached. Non-fatal (the sidecar may not be attached).
  async detach(workspaceId: string): Promise<void> {
    const r = await this.docker.cmd(
      "network",
      "disconnect",
      "-f",
      networkName(workspaceId),
      CREDENTIAL_PROXY_CONTAINER,
    );
    if (r.code !== 0) log.debug({ workspaceId, stderr: r.stderr }, "detach credential proxy (may not be attached)");
  }

  // Detach and CONFIRM: throws if still attached so the caller can roll back, since a stale attachment is the
  // one drift that fails open.
  async ensureDetached(workspaceId: string): Promise<void> {
    await this.detach(workspaceId);
    if (await this.isAttached(workspaceId)) {
      throw new Error(
        `workspace egress proxy (${CREDENTIAL_PROXY_ALIAS}) is still attached to ${networkName(workspaceId)} ` +
          `after detach — internet access could not be disabled`,
      );
    }
  }

  // On boot, reattach the sidecar to running workspaces a redeploy cut off. `shouldAttach` excludes internet-off
  // workspaces, which the sidecar would otherwise hand a route out.
  async reattachAll(shouldAttach: (workspaceId: string) => boolean = () => true): Promise<void> {
    const r = await this.docker.cmd("ps", "--filter", `name=^${CONTAINER_PREFIX}`, "--format", "{{.Names}}");
    if (r.code !== 0) {
      log.warn({ stderr: r.stderr }, "reattachProxyNetworks: docker ps failed");
      return;
    }
    for (const name of r.stdout
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean)) {
      const workspaceId = workspaceIdFromContainerName(name);
      if (workspaceId === null || !shouldAttach(workspaceId)) continue;
      await this.attach(workspaceId);
    }
  }
}
