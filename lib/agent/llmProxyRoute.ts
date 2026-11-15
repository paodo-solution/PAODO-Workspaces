// Where the app sends model calls: llm-proxy, which holds the provider keys. The app sends a placeholder key
// that llm-proxy drops, so an SDK that insists on a key still builds and no real key ever passes through here.
export const LLM_PROXY_PLACEHOLDER_KEY = "llm-proxy-adds-the-key";

export function llmProxyBaseUrl(provider: string, suffix = ""): string {
  const origin = (process.env.PAODO_LLM_PROXY_URL ?? "http://llm-proxy:9997").replace(/\/+$/, "");
  return `${origin}/${provider}${suffix}`;
}
