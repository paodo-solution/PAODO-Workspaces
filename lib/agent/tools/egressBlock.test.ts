import { describe, it, expect } from "vitest";
import { egressBlockMessage, type EgressPolicy } from "./egressBlock";

const open: EgressPolicy = { internetAccess: true };
const off: EgressPolicy = { internetAccess: false };
const restricted = (...domains: string[]): EgressPolicy => ({
  internetAccess: true,
  domainAllowlist: { restricted: true, domains },
});

const curlCommand = "curl https://example.com/x";
const curlRefused = "curl: (56) CONNECT tunnel failed, response 403";

describe("egressBlockMessage", () => {
  it("names the target and the allowed domains when the allowlist refuses it", () => {
    expect(egressBlockMessage(restricted("api.github.com", "pypi.org"), curlRefused, curlCommand)).toBe(
      "Cannot reach example.com: this workspace can only access api.github.com, pypi.org.",
    );
  });

  it("says no domain is allowed when the restricted list is empty", () => {
    expect(egressBlockMessage(restricted(), curlRefused, curlCommand)).toBe(
      "Cannot reach example.com: this workspace has no allowed domains.",
    );
  });

  it("says internet access is off", () => {
    expect(egressBlockMessage(off, curlRefused, curlCommand)).toBe(
      "Cannot reach example.com: internet access is off for this workspace.",
    );
  });

  it("ignores the relay's own loopback address when naming the target", () => {
    const pip = "ProxyError('Unable to connect to proxy', ... 'http://127.0.0.1:3128')";
    expect(egressBlockMessage(off, pip)).toBe("Cannot reach the target: internet access is off for this workspace.");
  });

  it("names the blocked host from pip's error, skipping the allowed index it came from", () => {
    const pip =
      "pip3 download requests\nCollecting requests (from https://pypi.org/simple/requests/)\n" +
      "ProxyError: HTTPSConnectionPool(host='files.pythonhosted.org', port=443) (Caused by ProxyError(" +
      "'Cannot connect to proxy.', OSError('Tunnel connection failed: 403 Forbidden')))";
    expect(egressBlockMessage(restricted("pypi.org"), pip)).toBe(
      "Cannot reach files.pythonhosted.org: this workspace can only access pypi.org.",
    );
  });

  it("explains the relay's 502 while internet is off", () => {
    const npm = "npm error 502 Unable to connect to upstream proxy - GET https://registry.npmjs.org/left-pad";
    expect(egressBlockMessage(off, npm)).toBe(
      "Cannot reach registry.npmjs.org: internet access is off for this workspace.",
    );
  });

  it("stays silent for an open workspace", () => {
    expect(egressBlockMessage(open, curlRefused, curlCommand)).toBe("");
  });

  it("stays silent when the failing host is on the allowlist", () => {
    expect(
      egressBlockMessage(restricted("api.github.com"), "error: 403 Forbidden", "curl https://api.github.com/x"),
    ).toBe("");
  });

  it("never treats the command text as proof of a refusal", () => {
    expect(egressBlockMessage(off, "", "grep -r '403 Forbidden' logs/")).toBe("");
  });

  it("names a private address or service name, which no_proxy still sends through the proxy", () => {
    expect(egressBlockMessage(restricted("pypi.org"), curlRefused, "curl http://10.0.0.5/x")).toBe(
      "Cannot reach 10.0.0.5: this workspace can only access pypi.org.",
    );
    expect(egressBlockMessage(restricted("pypi.org"), curlRefused, "curl http://db:8080/x")).toBe(
      "Cannot reach db: this workspace can only access pypi.org.",
    );
  });

  it("stays silent for a local server's own 403", () => {
    expect(egressBlockMessage(restricted("pypi.org"), "403 Forbidden", "curl http://localhost:8000/admin")).toBe("");
  });

  it("blames an unnamed host when the proxy refused a connection from an allowed one", () => {
    expect(
      egressBlockMessage(restricted("github.com"), curlRefused, "curl -L https://github.com/x/releases/download/v1"),
    ).toBe(
      "Cannot reach a host outside the allowlist (likely a redirect from github.com): this workspace can only access github.com.",
    );
  });

  it("reads the host past a URL's credentials", () => {
    expect(egressBlockMessage(restricted("pypi.org"), curlRefused, "curl https://user:pw@evil.com/x")).toBe(
      "Cannot reach evil.com: this workspace can only access pypi.org.",
    );
  });

  it("explains a DNS failure with no URL while internet is off", () => {
    expect(egressBlockMessage(off, "npm error getaddrinfo ENOTFOUND registry", "npm install")).toBe(
      "Cannot reach the target: internet access is off for this workspace.",
    );
  });

  it("stays silent for an unnamed DNS failure while internet is on", () => {
    expect(egressBlockMessage(restricted("pypi.org"), "getaddrinfo ENOTFOUND registry", "npm install")).toBe("");
  });

  it("does not read an @ in a query string as credentials", () => {
    expect(
      egressBlockMessage(
        restricted("api.example.com"),
        "error: 403 Forbidden",
        "curl 'https://api.example.com?email=a@b.com'",
      ),
    ).toBe("");
  });

  it("does not call a dead proxy a redirect when every host is allowed", () => {
    const pip = "ProxyError('Unable to connect to proxy', ... 'http://127.0.0.1:3128')";
    expect(egressBlockMessage(restricted("pypi.org"), pip, "pip install requests -i https://pypi.org/simple")).toBe("");
  });

  it("blames the host the error names over others in the command", () => {
    const err = "curl: (6) Could not resolve host: evil.com";
    expect(egressBlockMessage(restricted("pypi.org"), err, "curl https://pypi.org/x; curl https://evil.com/y")).toBe(
      "Cannot reach evil.com: this workspace can only access pypi.org.",
    );
  });

  it("stays silent for a failure that isn't a network refusal", () => {
    expect(egressBlockMessage(off, "ls nope\nls: cannot access 'nope': No such file or directory")).toBe("");
  });

  it("stays silent without a workspace", () => {
    expect(egressBlockMessage(undefined, curlRefused, curlCommand)).toBe("");
  });

  it("names the target when curl -f reports the proxy's 403", () => {
    const err = "curl: (22) The requested URL returned error: 403";
    expect(egressBlockMessage(restricted("github.com"), err, "curl -fsSL https://api.github.com/zen")).toBe(
      "Cannot reach api.github.com: this workspace can only access github.com.",
    );
  });

  it("stays silent when curl -f gets a 403 from an allowed host", () => {
    const err = "curl: (22) The requested URL returned error: 403";
    expect(egressBlockMessage(restricted("api.github.com"), err, "curl -fsS https://api.github.com/x")).toBe("");
  });

  it("explains Node fetch's tunnel refusal", () => {
    const err = "cause: RequestAbortedError [AbortError]: Proxy response (403) !== 200 when HTTP Tunneling";
    expect(egressBlockMessage(restricted("pypi.org"), err, `node -e "fetch('https://example.com')"`)).toBe(
      "Cannot reach example.com: this workspace can only access pypi.org.",
    );
  });

  it("explains Node fetch's dead relay while internet is off", () => {
    const err = "cause: RequestAbortedError [AbortError]: Proxy response (502) !== 200 when HTTP Tunneling";
    expect(egressBlockMessage(off, err, `node -e "fetch('https://example.com')"`)).toBe(
      "Cannot reach example.com: internet access is off for this workspace.",
    );
  });

  it("stays silent for Node fetch's dead relay while every named host is allowed", () => {
    const err = "cause: RequestAbortedError [AbortError]: Proxy response (502) !== 200 when HTTP Tunneling";
    expect(egressBlockMessage(restricted("pypi.org"), err, `node -e "fetch('https://pypi.org')"`)).toBe("");
  });

  it("explains curl -f's 502 from the dead relay while internet is off", () => {
    const err = "curl: (22) The requested URL returned error: 502";
    expect(egressBlockMessage(off, err, "curl -fsSL https://example.com")).toBe(
      "Cannot reach example.com: internet access is off for this workspace.",
    );
  });

  it("stays silent for an allowed server's own 502", () => {
    const err = "curl: (22) The requested URL returned error: 502";
    expect(egressBlockMessage(restricted("pypi.org"), err, "curl -fsS https://pypi.org/x")).toBe("");
    expect(egressBlockMessage(open, err, "curl -fsS https://example.com")).toBe("");
  });

  it("stays silent for a local server's own 502 while internet is off", () => {
    const err = "curl: (22) The requested URL returned error: 502";
    expect(egressBlockMessage(off, err, "curl -fsS http://127.0.0.1:8099/")).toBe("");
  });

  it("does not blame a blocked host the command only mentions for an allowed server's 403", () => {
    const err = "curl: (22) The requested URL returned error: 403";
    const command = "curl -fsS -H 'Referer: https://example.com/' https://httpbin.org/status/403";
    expect(egressBlockMessage(restricted("httpbin.org"), err, command)).toBe("");
  });

  it("counts the allowed domains instead of listing a long allowlist", () => {
    const many = restricted(...Array.from({ length: 11 }, (_, i) => `host${i}.example.net`));
    expect(egressBlockMessage(many, curlRefused, curlCommand)).toBe(
      "Cannot reach example.com: this workspace can only access its 11 allowed domains.",
    );
  });

  it("names the host from ssh's DNS error", () => {
    const err = "ssh: Could not resolve hostname github.com: Temporary failure in name resolution";
    expect(egressBlockMessage(off, err, "git ls-remote git@github.com:o/r.git")).toBe(
      "Cannot reach github.com: internet access is off for this workspace.",
    );
    expect(egressBlockMessage(restricted("pypi.org"), err, "git ls-remote git@github.com:o/r.git")).toBe(
      "Cannot reach github.com: this workspace can only access pypi.org.",
    );
  });
});
