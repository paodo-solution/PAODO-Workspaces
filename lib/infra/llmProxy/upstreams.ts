// Where llm-proxy may send each provider's calls, and how that provider takes its key. The only addresses it
// forwards to: a request names a provider, never a host.
export interface ProviderUpstream {
  origin: string;
  auth: "x-api-key" | "bearer";
}

export const PROVIDER_UPSTREAMS: Readonly<Record<string, ProviderUpstream>> = {
  anthropic: { origin: "https://api.anthropic.com", auth: "x-api-key" },
  openai: { origin: "https://api.openai.com", auth: "bearer" },
  deepseek: { origin: "https://api.deepseek.com", auth: "bearer" },
  moonshot: { origin: "https://api.moonshot.ai", auth: "bearer" },
  mistral: { origin: "https://api.mistral.ai", auth: "bearer" },
  scaleway: { origin: "https://api.scaleway.ai", auth: "bearer" },
};
