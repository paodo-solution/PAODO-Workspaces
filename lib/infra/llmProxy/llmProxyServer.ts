// The llm-proxy HTTP server: `/{provider}/{path}` is forwarded to that provider's fixed origin with the real
// key added, and the reply streams back untouched. Whatever credential the caller sent is dropped.
import http from "http";
import https from "https";
import { createAuditLogger } from "../logger";
import type { ProviderUpstream } from "./upstreams";

const audit = createAuditLogger("llmProxy");

// Hop-by-hop headers are per connection; the credential headers are replaced by the real key.
const DROPPED_REQUEST_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "authorization",
  "x-api-key",
  "api-key",
]);
const DROPPED_RESPONSE_HEADERS = new Set(["connection", "keep-alive", "transfer-encoding", "upgrade"]);

const ROUTE = /^\/([a-z0-9-]+)(\/[^?#]*)?(\?.*)?$/;

export interface LlmProxyOptions {
  upstreams: Readonly<Record<string, ProviderUpstream>>;
  apiKey: (provider: string) => string | undefined;
}

function sendError(res: http.ServerResponse, status: number, type: string, message: string): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ type: "error", error: { type, message } }));
}

function forwardHeaders(incoming: http.IncomingHttpHeaders, upstream: ProviderUpstream, key: string) {
  const headers: http.OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(incoming)) {
    if (value !== undefined && !DROPPED_REQUEST_HEADERS.has(name)) headers[name] = value;
  }
  if (upstream.auth === "x-api-key") headers["x-api-key"] = key;
  else headers.authorization = `Bearer ${key}`;
  return headers;
}

function responseHeaders(incoming: http.IncomingHttpHeaders): http.OutgoingHttpHeaders {
  const headers: http.OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(incoming)) {
    if (value !== undefined && !DROPPED_RESPONSE_HEADERS.has(name)) headers[name] = value;
  }
  return headers;
}

const agents = { "https:": new https.Agent({ keepAlive: true }), "http:": new http.Agent({ keepAlive: true }) };

export function createLlmProxyServer({ upstreams, apiKey }: LlmProxyOptions): http.Server {
  return http.createServer((req, res) => {
    const startedAt = Date.now();
    const match = ROUTE.exec(req.url ?? "");
    const provider = match?.[1];
    const upstream = provider !== undefined && Object.hasOwn(upstreams, provider) ? upstreams[provider] : undefined;
    if (!match || !provider || !upstream || !match[2]) {
      audit.warn({ event: "llm_proxy_unknown_route", method: req.method }, "llm-proxy refused an unknown provider route");
      sendError(res, 404, "not_found_error", "unknown provider route");
      return;
    }
    const key = apiKey(provider);
    if (!key) {
      sendError(res, 401, "authentication_error", `no API key is stored for ${provider} — add it in Settings`);
      return;
    }

    const origin = new URL(upstream.origin);
    const transport = origin.protocol === "http:" ? http : https;
    const upstreamReq = transport.request({
      protocol: origin.protocol,
      hostname: origin.hostname,
      port: origin.port || undefined,
      method: req.method,
      path: `${match[2]}${match[3] ?? ""}`,
      headers: forwardHeaders(req.headers, upstream, key),
      agent: agents[origin.protocol as "https:" | "http:"],
    });

    upstreamReq.on("response", (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode ?? 502, responseHeaders(upstreamRes.headers));
      upstreamRes.pipe(res);
      upstreamRes.on("error", () => res.destroy());
    });
    upstreamReq.on("error", (err) => {
      audit.warn({ event: "llm_proxy_upstream_failed", provider, err }, "llm-proxy could not reach the provider");
      if (!res.headersSent) sendError(res, 502, "api_error", `llm-proxy could not reach ${provider}`);
      else res.destroy();
    });
    // A caller that hangs up stops the provider call too, so an abandoned run is not billed to the end.
    res.on("close", () => {
      if (!res.writableFinished) upstreamReq.destroy();
      audit.info(
        {
          event: "llm_proxy_call",
          provider,
          method: req.method,
          path: match[2],
          status: res.statusCode,
          completed: res.writableFinished,
          durationMs: Date.now() - startedAt,
        },
        "llm-proxy forwarded a provider call",
      );
    });
    req.pipe(upstreamReq);
  });
}
