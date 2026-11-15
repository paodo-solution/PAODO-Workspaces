// llm-proxy must forward only to a provider's fixed origin, replace whatever credential the caller sent with the
// real key, stream replies through untouched, and cover every provider the app can build a model for.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "http";
import type { AddressInfo } from "net";
import { createLlmProxyServer } from "./llmProxyServer";
import { PROVIDER_UPSTREAMS } from "./upstreams";
import { SUPPORTED_PROVIDERS } from "../../agent/buildModel";

interface Seen {
  method?: string;
  url?: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

let seen: Seen;
let upstream: http.Server;
let proxy: http.Server;
let proxyUrl: string;

function listen(server: http.Server): Promise<string> {
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)),
  );
}

beforeAll(async () => {
  upstream = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen = { method: req.method, url: req.url, headers: req.headers, body };
      res.writeHead(200, { "content-type": "text/event-stream", "anthropic-ratelimit-requests-remaining": "41" });
      res.write("data: one\n\n");
      setTimeout(() => res.end("data: two\n\n"), 20);
    });
  });
  const origin = await listen(upstream);
  proxy = createLlmProxyServer({
    upstreams: {
      anthropic: { origin, auth: "x-api-key" },
      openai: { origin, auth: "bearer" },
    },
    apiKey: (provider) => (provider === "anthropic" || provider === "openai" ? `real-${provider}-key` : undefined),
  });
  proxyUrl = await listen(proxy);
});

afterAll(() => {
  proxy.close();
  upstream.close();
});

describe("llm-proxy forwarding", () => {
  it("adds the real key in the provider's header and drops the caller's placeholder", async () => {
    const res = await fetch(`${proxyUrl}/anthropic/v1/messages?beta=true`, {
      method: "POST",
      headers: { "x-api-key": "placeholder", authorization: "Bearer stolen", "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: "m" }),
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("data: one\n\ndata: two\n\n");
    expect(seen.method).toBe("POST");
    expect(seen.url).toBe("/v1/messages?beta=true");
    expect(seen.headers["x-api-key"]).toBe("real-anthropic-key");
    expect(seen.headers.authorization).toBeUndefined();
    expect(seen.headers["anthropic-version"]).toBe("2023-06-01");
    expect(seen.body).toBe('{"model":"m"}');
  });

  it("sends a bearer key to providers that take one, and passes rate-limit headers back", async () => {
    const res = await fetch(`${proxyUrl}/openai/v1/responses`, {
      method: "POST",
      headers: { authorization: "Bearer placeholder", "x-api-key": "other" },
      body: "{}",
    });
    await res.text();
    expect(seen.headers.authorization).toBe("Bearer real-openai-key");
    expect(seen.headers["x-api-key"]).toBeUndefined();
    expect(res.headers.get("anthropic-ratelimit-requests-remaining")).toBe("41");
  });

  it("refuses an unknown provider, an inherited property name and a bare provider route", async () => {
    for (const route of ["/evil/v1/x", "/constructor/v1/x", "/anthropic", "/", "//api.evil.example/v1"]) {
      expect((await fetch(`${proxyUrl}${route}`)).status).toBe(404);
    }
  });

  it("refuses a known provider with no stored key, without contacting it", async () => {
    const empty = createLlmProxyServer({ upstreams: PROVIDER_UPSTREAMS, apiKey: () => undefined });
    const url = await listen(empty);
    const res = await fetch(`${url}/mistral/v1/chat/completions`, { method: "POST", body: "{}" });
    expect(res.status).toBe(401);
    expect(await res.text()).toMatch(/no API key is stored for mistral/);
    empty.close();
  });
});

describe("provider coverage", () => {
  // Scaleway's host is the whole EU-sovereignty claim: a changed origin would send an EU client's traffic
  // elsewhere while still looking correct.
  it("pins each provider's origin", () => {
    expect(Object.fromEntries(Object.entries(PROVIDER_UPSTREAMS).map(([p, u]) => [p, u.origin]))).toEqual({
      anthropic: "https://api.anthropic.com",
      openai: "https://api.openai.com",
      deepseek: "https://api.deepseek.com",
      moonshot: "https://api.moonshot.ai",
      mistral: "https://api.mistral.ai",
      scaleway: "https://api.scaleway.ai",
    });
  });

  it("has a fixed HTTPS origin for every provider the app can build a model for", () => {
    for (const provider of SUPPORTED_PROVIDERS) {
      expect(PROVIDER_UPSTREAMS[provider]?.origin).toMatch(/^https:\/\/[a-z.]+$/);
    }
  });
});
