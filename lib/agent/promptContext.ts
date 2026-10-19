// Every system-prompt path gathers AGENTS.md and the drives block here, so none can miss drive instructions.

import fs from "fs";
import path from "path";
import { createLogger } from "../infra/logger";
import { getDrivesForWorkspace, formatDriveLine } from "@/lib/drives/store";
import { listSecretMeta } from "../infra/security/workspaceSecretStore";
import { getContainers, getStore } from "../infra/services";
import { blockedHosts, enforcedDomains } from "../workspace/domain";

const log = createLogger("promptContext");

export interface WorkspacePromptInputs {
  agentsContent?: string;
  networkInfo?: string;
  drivesInfo?: string;
  secretsInfo?: string;
  backgroundTasksInfo?: string;
}

function readAgentsMd(workspaceDir: string): string | undefined {
  try {
    return fs.readFileSync(path.join(workspaceDir, "AGENTS.md"), "utf-8").trim();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      log.debug({ workspaceDir }, "AGENTS.md not found — skipping");
    } else {
      log.warn({ err, workspaceDir }, "failed to read AGENTS.md — workspace instructions omitted");
    }
    return undefined;
  }
}

// Hosts a restricted workspace may reach, or null when nothing is enforced (an empty list included).
function allowedDomains(workspaceId: string): string[] | null {
  return enforcedDomains(getStore().getWorkspace(workspaceId)?.domainAllowlist);
}

function buildRestrictedNetworkInfo(domains: string[]): string {
  return `# Internet access — RESTRICTED
Only these hosts are reachable, matched exactly (subdomains and redirect targets like www. need their own entry):
${domains.map((d) => `- ${d}`).join("\n")}
Any other host, package registries included, gets a proxy 403. Don't retry it; tell the user which exact host to add.`;
}

// Always present, on, restricted or off: the agent should never guess its network access.
function buildNetworkInfo(workspaceId: string): string {
  const ws = getStore().getWorkspace(workspaceId);
  const enabled = ws ? (ws.internetAccess ?? true) : false;
  const restricted = enabled ? allowedDomains(workspaceId) : null;
  if (restricted) return buildRestrictedNetworkInfo(restricted);
  return enabled
    ? `# Internet access
This workspace has internet access. \`http_get\` fetches public URLs; \`apt_install\` installs system packages; \`npm\`/\`pip3\`/\`git\` work normally from execute_command.`
    : `# Internet access — DISABLED
This workspace has NO internet access. Its container has no network route out. \`http_get\` and \`apt_install\` are not available as tools. Any \`curl\`/\`wget\`/\`npm install\`/\`pip install\`/\`git clone\` against an external host from execute_command will fail immediately — do not retry them, they cannot succeed until the workspace owner re-enables internet access in the UI. Work only with what's already installed in the workspace — anything installed while internet access was on is still there, since the workspace is persistent.`;
}

function buildDrivesInfo(workspaceId: string): string | undefined {
  const drives = getDrivesForWorkspace(workspaceId);
  if (!drives.length) return undefined;
  const list = drives.map(formatDriveLine).join("\n");
  return `# Connected drives
Your workspace is your local machine. Drives are shared spaces — pull files to work on them, push results back, using your drive tools:
${list}
When handing work to another agent, pass the drive id and the file path — not the file contents.
After uploading a file to a drive, delete your local copy so no stale copy is left behind.
privilege drive_read to ground yourself in the file content; if it's truncated/incomplete, go for drive_download and search locally.
downloads/ is disposable — clean it up before ending your turn.
Need to keep a file? Move it out of downloads/ into the workspace. Anything left inside downloads/ when you finish must be deleted.`;
}

function buildSecretsInfo(workspaceId: string): string | undefined {
  // No network means nothing for the proxy to inject into, so don't document secrets.
  const ws = getStore().getWorkspace(workspaceId);
  const enabled = ws ? (ws.internetAccess ?? true) : false;
  if (!enabled) return undefined;
  const secrets = listSecretMeta(workspaceId);
  if (!secrets.length) return undefined;
  const lines = secrets
    .map((s) => {
      const blocked = blockedHosts(s.domains, ws?.domainAllowlist);
      const note = blocked.length ? ` (blocked: ${blocked.join(", ")} not allowed)` : "";
      return `- ${s.name} → ${s.domains.join(", ")}${note}`;
    })
    .join("\n");
  return `# Available Secrets
These are injected into your shell environment as opaque proxy tokens — use them directly and never print them. The credential proxy swaps in the real value only on outgoing HTTPS requests to the listed hosts, so reference the variable normally:
${lines}
Use clients that honour the standard proxy environment variables. Do not validate a secret's format locally. If a CLI rejects it before making a request, use that service's HTTPS API or SDK instead; the proxy can substitute the token only after a request is sent.`;
}

// Background tasks from earlier turns, so a later run can read or stop them and knows which ports are taken.
function buildBackgroundTasksInfo(workspaceId: string): string | undefined {
  const tasks = getContainers().listBackground(workspaceId);
  if (!tasks.length) return undefined;
  const lines = tasks.map((t) => `- ${t.taskId}: \`${t.command}\` → log: ${t.logFile}`).join("\n");
  return `# Running background tasks
These are processes running in your container right now:
${lines}`;
}

// Gathers everything per-workspace the system prompt needs. Pure read I/O; safe to call per request.
export function buildWorkspacePromptInputs(workspaceId: string, workspaceDir: string): WorkspacePromptInputs {
  return {
    agentsContent: readAgentsMd(workspaceDir),
    networkInfo: buildNetworkInfo(workspaceId),
    drivesInfo: buildDrivesInfo(workspaceId),
    secretsInfo: buildSecretsInfo(workspaceId),
    backgroundTasksInfo: buildBackgroundTasksInfo(workspaceId),
  };
}
