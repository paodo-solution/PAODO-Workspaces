import { describe, it, expect } from "vitest";
import { egressBlockMessage, type EgressPolicy } from "./egressBlock";

const open: EgressPolicy = { internetAccess: true };
const off: EgressPolicy = { internetAccess: false };
const restricted = (...domains: string[]): EgressPolicy => ({
  internetAccess: true,
  domainAllowlist: { restricted: true, domains },
});

const curlRefused = "curl https://example.com/x\ncurl: (56) CONNECT tunnel failed, response 403";

describe("egressBlockMessage", () => {
  it("names the target and the allowed domains when the allowlist refuses it", () => {
    expect(egressBlockMessage(restricted("api.github.com", "pypi.org"), curlRefused)).toBe(
      "Cannot reach example.com: this workspace can only access api.github.com, pypi.org.",
    );
  });

  it("says no domain is allowed when the restricted list is empty", () => {
    expect(egressBlockMessage(restricted(), curlRefused)).toBe(
      "Cannot reach example.com: this workspace has no allowed domains.",
    );
  });

  it("says internet access is off", () => {
    expect(egressBlockMessage(off, curlRefused)).toBe(
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
    expect(egressBlockMessage(open, curlRefused)).toBe("");
  });

  it("stays silent when the failing host is on the allowlist", () => {
    const text = "curl https://api.github.com/x\nerror: 403 Forbidden";
    expect(egressBlockMessage(restricted("api.github.com"), text)).toBe("");
  });

  it("stays silent for a failure that isn't a network refusal", () => {
    expect(egressBlockMessage(off, "ls nope\nls: cannot access 'nope': No such file or directory")).toBe("");
  });

  it("stays silent without a workspace", () => {
    expect(egressBlockMessage(undefined, curlRefused)).toBe("");
  });
});
