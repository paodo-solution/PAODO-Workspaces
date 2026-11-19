// The quickstart compose is a hand copy of docker-compose.yml with prebuilt images and no password. The
// danger is drift: a hardening added to one file and not the other, so this pins every difference.
import { readFileSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

type Service = Record<string, unknown> & { environment?: string[] | Record<string, unknown>; image?: string };
type ComposeFile = { name: string; services: Record<string, Service>; volumes: unknown; networks: unknown };

const load = (file: string) =>
  parse(readFileSync(path.join(__dirname, "../..", file), "utf8"), { merge: true }) as ComposeFile;
const base = load("docker-compose.yml");
const quick = load("docker-compose.quickstart.yml");

// Keys that may legitimately differ: where the image comes from, the optional .env, and the default port.
const IMAGE_KEYS = new Set(["build", "image", "pull_policy", "env_file", "environment", "ports"]);
// PORT too: without a .env, nothing else hands the app the port that compose publishes.
const QUICKSTART_ONLY_ENV = /^(PORT|PAODO_AUTH_MODE|PAODO_WORKSPACE_IMAGE_SOURCE|[A-Z]+_AVAILABLE)=/;
const REGISTRY = "ghcr.io/paodo-solution/";

const envList = (s: Service) =>
  Array.isArray(s.environment)
    ? s.environment
    : Object.entries(s.environment ?? {}).map(([k, v]) => `${k}=${String(v)}`);
const withoutImageKeys = (s: Service) => Object.fromEntries(Object.entries(s).filter(([k]) => !IMAGE_KEYS.has(k)));

describe("docker-compose.quickstart.yml", () => {
  it("keeps the project name, volumes and networks of docker-compose.yml", () => {
    expect(quick.name).toBe(base.name);
    expect(quick.volumes).toEqual(base.volumes);
    expect(quick.networks).toEqual(base.networks);
    expect(Object.keys(quick.services).sort()).toEqual(Object.keys(base.services).sort());
  });

  it("matches every service's isolation, limits, mounts and networks", () => {
    for (const [name, service] of Object.entries(base.services)) {
      expect(withoutImageKeys(quick.services[name]), name).toEqual(withoutImageKeys(service));
    }
  });

  it("keeps every variable of docker-compose.yml and adds only the allowed ones", () => {
    for (const [name, service] of Object.entries(base.services)) {
      const quickEnv = envList(quick.services[name]);
      expect(quickEnv, name).toEqual(expect.arrayContaining(envList(service)));
      const extra = quickEnv.filter((entry) => !envList(service).includes(entry));
      expect(
        extra.filter((entry) => !QUICKSTART_ONLY_ENV.test(entry)),
        name,
      ).toEqual([]);
    }
  });

  it("builds nothing: PAODO's own images all come from the registry", () => {
    for (const [name, service] of Object.entries(quick.services)) {
      expect(service.build, name).toBeUndefined();
      if (base.services[name].build || base.services[name].pull_policy === "never") {
        expect(service.image, name).toMatch(new RegExp(`^${REGISTRY}`));
      } else {
        expect(service.image, name).toBe(base.services[name].image);
      }
    }
  });

  // 3000 is crowded on a developer's machine; local mode is safe only while it listens on loopback.
  it("publishes an uncommon default port, on 127.0.0.1 only", () => {
    expect(quick.services.app.ports).toEqual(["127.0.0.1:${PORT:-7373}:${PORT:-7373}"]);
    expect(envList(quick.services.app)).toContain("PORT=${PORT:-7373}");
    for (const [name, service] of Object.entries(quick.services)) {
      if (name !== "app") expect(service.ports, name).toEqual(base.services[name].ports);
    }
  });

  it("runs without a password and pulls the sandbox image of the same release", () => {
    const env = envList(quick.services.app);
    // Not ${PAODO_AUTH_MODE:-local}: the env_file and .env interpolation must not be able to switch the mode.
    expect(env.filter((entry) => entry.startsWith("PAODO_AUTH_MODE="))).toEqual(["PAODO_AUTH_MODE=local"]);
    expect(env).toContain(`PAODO_WORKSPACE_IMAGE_SOURCE=${REGISTRY}paodo-workspaces-sandbox:\${PAODO_VERSION:-latest}`);
    expect(quick.services.app.image).toBe(`${REGISTRY}paodo-workspaces:\${PAODO_VERSION:-latest}`);
  });
});
