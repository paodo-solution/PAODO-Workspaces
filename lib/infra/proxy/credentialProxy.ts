// Swaps opaque tokens for real secrets on HTTPS to each secret's exact host (MITM), redacts echoes back,
// and tunnels everything else untouched. Design: doc/adr/accepted/sandbox/adr-workspace-secrets-credential-proxy.md
import * as net from "net";
import * as tls from "tls";
import * as http from "http";
import * as https from "https";
import { Transform } from "stream";
import { signDomainCert, verifyProxySecret } from "./proxyCA";
import { isBlockedAddress, makeGuardedLookup } from "./destinationGuard";
import { createAuditLogger, createLogger } from "../logger";
import { throttleLog, throttleLogWithSources } from "../logThrottle";
import { WorkspaceRuleStore } from "./workspaceRuleStore";
import { checkAccess, type AccessDecision } from "./internetAccessPolicy";
import { readHttpHeaders, collectBody, pipeBody, bodyMode } from "./httpWire";
import type { DomainRule } from "../security/workspaceSecretStore";
import { hostMatches } from "../../workspace/domain";

const log = createLogger("credentialProxy");
const audit = createAuditLogger("credentialProxy");

// token → real value
type TokenMap = Map<string, string>;

// Parse the workspace id (username) and secret (password) out of a Proxy-Authorization header.
// The container's proxy URL carries both as `http://<wsId>:<secret>@host…`.
function parseProxyAuth(authHeader: string | undefined): { wsId: string; secret: string } | null {
  if (!authHeader?.startsWith("Basic ")) return null;
  const decoded = Buffer.from(authHeader.slice(6), "base64").toString();
  const colon = decoded.indexOf(":");
  if (colon === -1) return null;
  return { wsId: decoded.slice(0, colon), secret: decoded.slice(colon + 1) };
}

// Merge the token maps of every rule whose domain covers this host. If none match, the
// returned map is empty — the caller then tunnels/forwards without touching the traffic.
function tokenMapForHost(rules: DomainRule[], hostname: string): TokenMap {
  const map: TokenMap = new Map();
  for (const rule of rules) {
    if (hostMatches(hostname, rule.domain)) {
      for (const [token, value] of rule.tokenMap) map.set(token, value);
    }
  }
  return map;
}

function substituteTokens(value: string, tokenMap: TokenMap, usedTokens?: Set<string>): string {
  for (const [token, realValue] of tokenMap) {
    if (value.includes(token)) {
      usedTokens?.add(token);
      value = value.split(token).join(realValue);
    }
  }
  return value;
}

// Substitutes verbatim tokens and inside `Basic base64(user:token)`. `wireForms` records each re-encoded
// envelope so the response side can redact bytes that don't contain the literal value.
export function substituteHeaderValue(
  value: string,
  tokenMap: Map<string, string>,
  usedTokens?: Set<string>,
  wireForms?: Map<string, string>,
): string {
  const direct = substituteTokens(value, tokenMap, usedTokens);
  const basic = /^Basic\s+(\S+)\s*$/i.exec(direct);
  if (basic) {
    try {
      const decoded = Buffer.from(basic[1], "base64").toString("latin1");
      const replaced = substituteTokens(decoded, tokenMap, usedTokens);
      if (replaced !== decoded) {
        const encoded = Buffer.from(replaced, "latin1").toString("base64");
        wireForms?.set(encoded, basic[1]);
        return "Basic " + encoded;
      }
    } catch {
      // not valid base64 — keep the direct substitution
    }
  }
  return direct;
}

// Invert a token map (token → real value) into a redaction map (real value → token) for the
// response direction. Empty-string values are dropped defensively (they would match everywhere).
export function reverseTokenMap(tokenMap: TokenMap): TokenMap {
  const rev: TokenMap = new Map();
  for (const [token, value] of tokenMap) {
    if (value.length > 0) rev.set(value, token);
  }
  return rev;
}

// Streams redaction without buffering (SSE must not stall), holding back longest-value − 1 bytes so a
// value split across chunks is still caught. Latin1 keeps it byte-safe.
export function createRedactTransform(redactMap: TokenMap): Transform {
  const maxLen = Math.max(1, ...[...redactMap.keys()].map((v) => v.length));
  const holdback = maxLen - 1;
  let carry = "";
  return new Transform({
    transform(chunk: Buffer, _enc, cb) {
      const s = substituteTokens(carry + chunk.toString("latin1"), redactMap);
      const emitEnd = Math.max(0, s.length - holdback);
      carry = s.slice(emitEnd);
      if (emitEnd > 0) this.push(Buffer.from(s.slice(0, emitEnd), "latin1"));
      cb();
    },
    flush(cb) {
      // A partial value at the very end can never complete — emit the carry (one more idempotent
      // substitution pass in case the final chunk completed a value exactly at the boundary).
      if (carry.length) this.push(Buffer.from(substituteTokens(carry, redactMap), "latin1"));
      cb();
    },
  });
}

// Substitutes in the request target and every header (mutating `headers`); returns the new path.
// The body is handled by forwardRequestBody.
function substituteRequestMeta(
  requestPath: string,
  headers: Record<string, string>,
  tokenMap: TokenMap,
  usedTokens?: Set<string>,
  wireForms?: TokenMap,
): string {
  for (const k of Object.keys(headers)) {
    headers[k] = substituteHeaderValue(headers[k], tokenMap, usedTokens, wireForms);
  }
  return substituteTokens(requestPath, tokenMap, usedTokens);
}

interface ProxyRequestContext {
  workspaceId?: string;
  hostname: string;
  port: number;
  transport: "http" | "https" | "tunnel";
}

interface OpenTunnel {
  workspaceId: string;
  hostname: string;
  port: number;
  client: net.Socket;
  upstream: net.Socket;
}

function isBlockedDestinationError(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | undefined)?.code === "EBLOCKED";
}

function auditBlockedDestination(context: ProxyRequestContext): void {
  const suppressed = throttleLog("proxy_destination_blocked");
  if (suppressed === null) return;
  audit.warn(
    {
      event: "proxy_destination_blocked",
      outcome: "request_blocked",
      suppressed,
      ...context,
    },
    "credential proxy blocked a private destination",
  );
}

// Sources are the refused hosts, so a throttled window still names every host the user may need to add.
function auditDomainNotAllowed(context: ProxyRequestContext): void {
  const window = throttleLogWithSources("proxy_domain_not_allowed", context.hostname);
  if (window === null) return;
  audit.warn(
    {
      event: "proxy_domain_not_allowed",
      outcome: "request_blocked",
      suppressed: window.suppressed,
      suppressedHosts: window.sources,
      ...context,
    },
    "credential proxy refused a host outside the workspace's allowed domains",
  );
}

function auditUpstreamAuthFailure(
  context: ProxyRequestContext,
  method: string,
  status: number,
  credentialCount: number,
): void {
  const suppressed = throttleLog("credential_proxy_upstream_auth_failed");
  if (suppressed === null) return;
  audit.warn(
    {
      event: "credential_proxy_upstream_auth_failed",
      outcome: "credential_rejected_by_upstream",
      suppressed,
      method,
      status,
      credentialCount,
      ...context,
    },
    "upstream rejected a proxied credential",
  );
}

export function buildResponseHead(res: http.IncomingMessage, redactMap?: TokenMap): string {
  const redact = (val: string): string => (redactMap ? substituteTokens(val, redactMap) : val);
  let head = `HTTP/1.1 ${res.statusCode} ${res.statusMessage}\r\n`;
  for (const [k, v] of Object.entries(res.headers)) {
    const key = k.toLowerCase();
    // Node already de-chunked `res`, so forwarding `transfer-encoding: chunked` would break the client's
    // read; the body is delimited by connection close instead.
    if (key === "transfer-encoding" || key === "connection") continue;
    // When redacting (MITM path), body redaction can change its length, and the body is
    // connection-close/EOF-delimited anyway — a stale content-length would truncate the client read.
    if (redactMap && key === "content-length") continue;
    if (Array.isArray(v)) {
      for (const val of v) head += `${k}: ${redact(val)}\r\n`;
    } else if (v !== undefined) {
      head += `${k}: ${redact(v)}\r\n`;
    }
  }
  // Body length is unknown, so the client reads to EOF, which pipe() delivers on upstream end.
  head += "connection: close\r\n";
  return head + "\r\n";
}

export class CredentialProxy {
  private ruleStore = new WorkspaceRuleStore();
  private server: net.Server;
  // Predicate deciding whether a resolved destination IP is off-limits (SSRF guard), plus a
  // hostname lookup built from it. Injectable so tests can point the proxy at a loopback stub.
  private blockDestination: (ip: string) => boolean;
  private lookup: net.LookupFunction;
  // Extra CA(s) trusted for the re-originated upstream TLS. Test-only injection (lets an e2e
  // test run an HTTPS stub with a self-signed chain); production always uses the system roots.
  private upstreamCa?: string | string[];
  // The workspace's internet policy (off, or restricted to listed hosts). Injectable like blockDestination.
  private checkAccess: (wsId: string, hostname?: string) => AccessDecision;
  // Plain tunnels are opaque pipes that never re-check policy, so they're tracked for closeDisallowedTunnels.
  private tunnels = new Set<OpenTunnel>();

  constructor(opts?: {
    blockDestination?: (ip: string) => boolean;
    checkAccess?: (wsId: string, hostname?: string) => AccessDecision;
    upstreamCa?: string | string[];
    /** The production sidecar exits here so Docker can restart a dead listener. */
    onServerError?: (err: Error) => void;
  }) {
    this.blockDestination = opts?.blockDestination ?? isBlockedAddress;
    this.upstreamCa = opts?.upstreamCa;
    this.checkAccess = opts?.checkAccess ?? checkAccess;
    this.lookup = makeGuardedLookup(this.blockDestination);
    this.server = net.createServer((socket) => {
      this.handleConnection(socket).catch((err) => {
        log.warn({ err }, "proxy connection error");
        socket.destroy();
      });
    });
    this.server.on("error", (err) => {
      if (opts?.onServerError) {
        opts.onServerError(err);
        return;
      }
      log.error(
        { event: "credential_proxy_server_error", outcome: "proxy_listener_failed", err },
        "proxy server error",
      );
    });
  }

  listen(port: number): void {
    this.server.listen(port, "0.0.0.0", () => {
      log.info({ port }, "credential proxy listening");
    });
  }

  setRules(wsId: string, rules: DomainRule[]): void {
    this.ruleStore.setRules(wsId, rules);
  }

  clearRules(wsId: string): void {
    this.ruleStore.clearRules(wsId);
  }

  /** Closes every open plain tunnel the current policy refuses and returns how many; run after each policy reload. */
  closeDisallowedTunnels(): number {
    let closed = 0;
    for (const tunnel of this.tunnels) {
      const { workspaceId, hostname, port } = tunnel;
      if (this.checkAccess(workspaceId, hostname) === "allowed") continue;
      this.tunnels.delete(tunnel);
      tunnel.client.destroy();
      tunnel.upstream.destroy();
      closed += 1;
      audit.warn(
        {
          event: "proxy_tunnel_closed_by_policy",
          outcome: "tunnel_closed",
          workspaceId,
          upstreamHost: hostname,
          port,
          transport: "tunnel",
        },
        "credential proxy closed an open tunnel the workspace's policy no longer allows",
      );
    }
    return closed;
  }

  private async handleConnection(socket: net.Socket): Promise<void> {
    socket.on("error", () => socket.destroy());

    const { statusLine, headers, remaining } = await readHttpHeaders(socket);
    const auth = parseProxyAuth(headers["proxy-authorization"]);

    // Every connection must prove its workspace, or the internet-off check below could be dodged by
    // omitting or spoofing the identity. Real callers get credentials in HTTP_PROXY (containerCredentials.ts).
    if (!auth || !verifyProxySecret(auth.wsId, auth.secret)) {
      audit.warn(
        { wsId: auth?.wsId, event: "proxy_auth_required" },
        "refusing connection — no verified workspace identity",
      );
      socket.write("HTTP/1.1 407 Proxy Authentication Required\r\n\r\n");
      socket.destroy();
      return;
    }

    const rules = this.ruleStore.resolve(auth);

    // Defense in depth: an off workspace has no sidecar attached, so it only gets here through a stale
    // attachment or a redeploy race. Refused even if it has secret rules.
    if (this.checkAccess(auth.wsId) === "internet_off") {
      audit.warn(
        { wsId: auth.wsId, event: "proxy_internet_access_blocked" },
        "refusing connection — internet access is disabled for this workspace",
      );
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }

    if (statusLine.startsWith("CONNECT ")) {
      const target = statusLine.split(" ")[1] ?? "";
      const colonIdx = target.lastIndexOf(":");
      const hostname = colonIdx !== -1 ? target.slice(0, colonIdx) : target;
      const port = colonIdx !== -1 ? parseInt(target.slice(colonIdx + 1), 10) : 443;
      if (this.refuseUnlistedHost(socket, { workspaceId: auth.wsId, hostname, port, transport: "tunnel" })) return;

      // Only intercept TLS for hosts a secret is scoped to. Every other host (pypi, apt
      // mirrors, github…) is a straight tunnel, so package installs and clones are untouched.
      const tokenMap = tokenMapForHost(rules, hostname);
      if (tokenMap.size > 0) {
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        await this.handleMitm(socket, hostname, port, tokenMap, remaining, auth?.wsId);
      } else {
        // SSRF guard: IP literals are checked here because net.connect skips the guarded lookup for them.
        // The 200 waits for the upstream, so a blocked target only ever sees a 403.
        if (net.isIP(hostname) && this.blockDestination(hostname)) {
          auditBlockedDestination({ workspaceId: auth?.wsId, hostname, port, transport: "tunnel" });
          socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
          socket.destroy();
          return;
        }
        const upstream = net.connect({ host: hostname, port, lookup: this.lookup });
        let established = false;
        upstream.on("error", (err) => {
          if (isBlockedDestinationError(err)) {
            auditBlockedDestination({ workspaceId: auth?.wsId, hostname, port, transport: "tunnel" });
          } else {
            log.warn({ err, upstreamHost: hostname, port, established }, "proxy tunnel upstream error");
          }
          if (!established) {
            try {
              socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
            } catch {
              /* socket gone */
            }
          }
          socket.destroy();
          upstream.destroy();
        });
        socket.on("error", () => {
          socket.destroy();
          upstream.destroy();
        });
        upstream.on("connect", () => {
          established = true;
          const tunnel: OpenTunnel = { workspaceId: auth.wsId, hostname, port, client: socket, upstream };
          this.tunnels.add(tunnel);
          const forget = () => this.tunnels.delete(tunnel);
          socket.once("close", forget);
          upstream.once("close", forget);
          socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
          if (remaining.length) upstream.write(remaining);
          socket.pipe(upstream);
          upstream.pipe(socket);
          socket.resume();
        });
      }
    } else {
      await this.handleHttpProxy(socket, statusLine, headers, remaining, auth?.wsId);
    }
  }

  // Checked before any upstream connection or MITM, so an unlisted host is never contacted at all.
  private refuseUnlistedHost(socket: net.Socket, context: ProxyRequestContext): boolean {
    if (!context.workspaceId || this.checkAccess(context.workspaceId, context.hostname) === "allowed") return false;
    auditDomainNotAllowed(context);
    socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
    socket.destroy();
    return true;
  }

  private async handleMitm(
    clientSocket: net.Socket,
    hostname: string,
    port: number,
    tokenMap: TokenMap,
    prefixData: Buffer,
    workspaceId?: string,
  ): Promise<void> {
    const { cert: certPem, key: keyPem } = signDomainCert(hostname);

    const tlsSocket = new tls.TLSSocket(clientSocket, {
      isServer: true,
      key: keyPem,
      cert: certPem,
    });
    tlsSocket.on("error", () => tlsSocket.destroy());
    tlsSocket.on("tlsClientError", (err) => {
      log.debug({ err, upstreamHost: hostname }, "TLS client error in MITM");
      tlsSocket.destroy();
    });

    if (prefixData.length) clientSocket.unshift(prefixData);

    const { statusLine, headers, remaining } = await readHttpHeaders(tlsSocket);

    const parts = statusLine.split(" ");
    const method = parts[0] ?? "GET";

    delete headers["proxy-authorization"];
    // Uncompressed responses keep redaction able to scan them; a server that compresses anyway goes
    // unredacted (echo protection, not a guarantee).
    delete headers["accept-encoding"];
    headers["connection"] = "close";
    const usedTokens = new Set<string>();
    const wireForms: TokenMap = new Map();
    const requestPath = substituteRequestMeta(parts[1] ?? "/", headers, tokenMap, usedTokens, wireForms);
    const requestContext: ProxyRequestContext = { workspaceId, hostname, port, transport: "https" };

    // Redact echoed real values, plus the `Basic` envelopes we built (git/gh), which hide the literal bytes.
    const redactMap = reverseTokenMap(tokenMap);
    for (const [emitted, clientForm] of wireForms) redactMap.set(emitted, clientForm);

    const startUpstream = () =>
      https.request(
        {
          hostname,
          port,
          method,
          path: requestPath,
          headers,
          rejectUnauthorized: true,
          ca: this.upstreamCa,
          lookup: this.lookup,
        },
        (upstreamRes) => {
          const status = upstreamRes.statusCode ?? 0;
          if ((status === 401 || status === 403) && usedTokens.size > 0) {
            auditUpstreamAuthFailure(requestContext, method, status, usedTokens.size);
          }
          tlsSocket.write(buildResponseHead(upstreamRes, redactMap));
          upstreamRes.pipe(createRedactTransform(redactMap)).pipe(tlsSocket);
          upstreamRes.on("error", (err) => {
            log.warn({ err, upstreamHost: hostname, port }, "upstream response stream error");
            tlsSocket.destroy();
          });
        },
      );

    await this.forwardRequestBody(tlsSocket, headers, remaining, tokenMap, usedTokens, startUpstream, requestContext);
  }

  // Forward the request body upstream, substituting tokens inside it when it is small enough to
  // buffer. Shared by the MITM (HTTPS) and plain-HTTP paths — only the request factory differs.
  private async forwardRequestBody(
    src: net.Socket,
    headers: Record<string, string>,
    remaining: Buffer,
    tokenMap: TokenMap,
    usedTokens: Set<string>,
    startUpstream: () => http.ClientRequest,
    context: ProxyRequestContext,
  ): Promise<void> {
    // Clients that send `Expect: 100-continue` (Python requests on larger POSTs) wait for a 100. We
    // re-send the body ourselves, so answer here and don't forward the expectation.
    if (/(^|,)\s*100-continue\s*($|,)/i.test(headers["expect"] ?? "")) {
      src.write("HTTP/1.1 100 Continue\r\n\r\n");
      delete headers["expect"];
    }

    if (bodyMode(headers) === "buffer") {
      let raw: Buffer;
      try {
        raw = await collectBody(src, headers, remaining);
      } catch (err) {
        log.warn({ err, upstreamHost: context.hostname }, "request body read failed");
        src.destroy();
        return;
      }
      const body = Buffer.from(substituteTokens(raw.toString("latin1"), tokenMap, usedTokens), "latin1");
      // Length changed (token → real value) and any chunked framing is gone: fix the headers.
      headers["content-length"] = String(body.length);
      delete headers["transfer-encoding"];
      const req = startUpstream();
      req.on("error", (err) => {
        if (isBlockedDestinationError(err)) auditBlockedDestination(context);
        else log.warn({ err, upstreamHost: context.hostname }, "upstream request error");
        src.destroy();
      });
      req.end(body);
    } else {
      // No body, or too large to buffer — stream it through untouched (headers/path already done).
      const req = startUpstream();
      req.on("error", (err) => {
        if (isBlockedDestinationError(err)) auditBlockedDestination(context);
        else log.warn({ err, upstreamHost: context.hostname }, "upstream request error");
        src.destroy();
      });
      pipeBody(src, req, headers, remaining);
    }
  }

  private async handleHttpProxy(
    socket: net.Socket,
    statusLine: string,
    headers: Record<string, string>,
    remaining: Buffer,
    workspaceId?: string,
  ): Promise<void> {
    // e.g. GET http://example.com/path HTTP/1.1
    const match = /^(\w+)\s+http:\/\/([^/\s]+)(\/[^\s]*)?\s/.exec(statusLine);
    if (!match) {
      socket.destroy();
      return;
    }

    const [, method, hostHeader, requestPath = "/"] = match;
    const colonIdx = hostHeader.lastIndexOf(":");
    const hostname = colonIdx !== -1 ? hostHeader.slice(0, colonIdx) : hostHeader;
    const port = colonIdx !== -1 ? parseInt(hostHeader.slice(colonIdx + 1), 10) : 80;
    if (this.refuseUnlistedHost(socket, { workspaceId, hostname, port, transport: "http" })) return;

    // SSRF guard: refuse plain-HTTP forwards to internal addresses. IP literals are checked here
    // (http.request skips DNS for them); hostnames are validated by this.lookup below.
    if (net.isIP(hostname) && this.blockDestination(hostname)) {
      auditBlockedDestination({ workspaceId, hostname, port, transport: "http" });
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }

    // HTTPS-only injection: on cleartext HTTP the opaque token travels instead, so upstream rejects it
    // rather than the secret leaking to on-path observers.
    const tokenMap: TokenMap = new Map();

    delete headers["proxy-authorization"];
    headers["connection"] = "close";
    const usedTokens = new Set<string>();
    const path = substituteRequestMeta(requestPath, headers, tokenMap, usedTokens);
    const requestContext: ProxyRequestContext = { workspaceId, hostname, port, transport: "http" };

    const startUpstream = () =>
      http.request({ hostname, port, method, path, headers, lookup: this.lookup }, (upstreamRes) => {
        socket.write(buildResponseHead(upstreamRes));
        upstreamRes.pipe(socket);
        upstreamRes.on("error", (err) => {
          log.warn({ err, upstreamHost: hostname, port }, "upstream response stream error");
          socket.destroy();
        });
      });

    await this.forwardRequestBody(socket, headers, remaining, tokenMap, usedTokens, startUpstream, requestContext);
  }
}
