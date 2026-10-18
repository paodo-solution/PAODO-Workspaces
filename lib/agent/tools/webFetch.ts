// http_get: fetches a URL as plain text (HTTPS only, 20k chars), via curl inside the container so it has only
// the agent's own reach. Traffic goes through the credential proxy (SSRF guard, audit, secret injection).

import { StructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import { toolError } from "../toolUtils";
import type { ExecRunner } from "../interfaces";

const MAX_REDIRECTS = 5;
const REQUEST_TIMEOUT_SECONDS = 15;
// Hard cap for responses with a declared length; chunked ones are bounded by --max-time.
const READ_CAP_BYTES = 8 * 1024 * 1024;
const MAX_CHARS = 20_000;
const USER_AGENT = "Mozilla/5.0 (compatible; ShellCopilot/1.0)";

// curl writes these to stderr so stdout is a clean body; tabs because none of the fields can contain one.
const WRITE_OUT = "%{stderr}%{http_code}\t%{content_type}\t%{url_effective}";

const schema = z.object({
  url: z.string().describe("Fully-formed URL to fetch"),
  prompt: z.string().optional().describe("What to extract or focus on from the page"),
});

// Upgrades http to https (case-insensitively) and refuses other schemes. Not an SSRF control (the proxy is).
// Redirect hops are held to https by --proto-redir.
function normalizeUrl(rawUrl: string): string {
  const upgraded = /^http:\/\//i.test(rawUrl) ? rawUrl.replace(/^http:\/\//i, "https://") : rawUrl;
  let parsed: URL;
  try {
    parsed = new URL(upgraded);
  } catch {
    throw new Error("Invalid URL");
  }
  if (parsed.protocol !== "https:") throw new Error("Only HTTPS URLs are allowed");
  return upgraded;
}

// argv only (no shell), so the URL is never interpolated. Never add --noproxy: the proxy is the SSRF guard.
// Only loopback skips it (no_proxy in containerCredentials.ts), matched by host string, never by resolved IP.
export function buildCurlArgs(url: string): string[] {
  return [
    "curl",
    // Silent, but still report real errors on stderr so a failure has a usable message.
    "-sS",
    // Follow redirects in curl rather than hop-by-hop here: every hop transits the credential proxy,
    // which guards and audits each one.
    "-L",
    "--max-redirs",
    String(MAX_REDIRECTS),
    // Keep every redirect hop on https: curl refuses a cleartext hop rather than upgrading it.
    "--proto",
    "=https",
    "--proto-redir",
    "=https",
    // Doubles as the hang guard: ExecRunner.exec() has no abort plumbing, so curl must bound itself.
    "--max-time",
    String(REQUEST_TIMEOUT_SECONDS),
    "--max-filesize",
    String(READ_CAP_BYTES),
    // curl does not auto-decompress unless asked; request identity so response bytes are plain text.
    "-H",
    "Accept-Encoding: identity",
    "-A",
    USER_AGENT,
    "-w",
    WRITE_OUT,
    url,
  ];
}

interface FetchOutcome {
  status: number;
  contentType: string;
  finalUrl: string;
  body: string;
}

// curl's -w line comes last on stderr, even on failure (`000\t\t`); split it off so diagnostics and
// metadata don't contaminate each other.
function splitStderr(stderr: string): { message: string; metaLine: string | null } {
  const lines = stderr.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^\d+\t/.test(lines[i])) {
      return { message: lines.slice(0, i).join("\n").trim(), metaLine: lines[i] };
    }
  }
  return { message: stderr.trim(), metaLine: null };
}

function parseOutcome(stdout: string, metaLine: string | null, fallbackUrl: string): FetchOutcome {
  const [code, contentType = "", finalUrl = ""] = (metaLine ?? "").split("\t");
  const status = Number.parseInt(code ?? "", 10);
  if (!Number.isFinite(status)) throw new Error("could not read the response status");
  return { status, contentType, finalUrl: finalUrl || fallbackUrl, body: stdout };
}

function htmlToText(html: string): string {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

export class WebFetchTool extends StructuredTool<typeof schema> {
  name = "http_get";
  description = `Make an HTTP GET request to any public URL and return the response body as plain text.
Always call this tool when the user provides a URL or asks for web content.
HTTP URLs are automatically upgraded to HTTPS.
Use the prompt field to describe what to extract from the response.
For GitHub repos/PRs/issues, prefer gh CLI via execute_command instead.`;
  schema = schema;

  // Runs through the workspace container, like every other tool. Tests inject a fake runner.
  constructor(private readonly runner: ExecRunner) {
    super();
  }

  protected async _call({ url, prompt }: z.infer<typeof schema>): Promise<string> {
    try {
      const target = normalizeUrl(url);
      const r = await this.runner.exec(buildCurlArgs(target));
      const { message, metaLine } = splitStderr(r.stderr);
      if (r.code !== 0) return `Error: ${message || `request failed (curl exit ${r.code})`} — ${target}`;

      const { status, contentType, finalUrl, body } = parseOutcome(r.stdout, metaLine, target);
      if (status < 200 || status >= 300) return `Error: HTTP ${status} — ${finalUrl}`;

      let text = body;
      if (contentType.includes("text/html")) text = htmlToText(text);
      const capped =
        text.length > MAX_CHARS
          ? text.slice(0, MAX_CHARS) + `\n\n[content truncated — showing first ${MAX_CHARS} chars]`
          : text;
      return prompt ? `Fetched: ${finalUrl}\nPrompt: ${prompt}\n\n${capped}` : `Fetched: ${finalUrl}\n\n${capped}`;
    } catch (err: unknown) {
      return toolError(err);
    }
  }
}
