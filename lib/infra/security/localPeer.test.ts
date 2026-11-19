// Local mode has no credential, so this predicate is the whole door. The dangerous failures are admitting a LAN
// or bridge neighbour, and misreading the gateway so the host's own browser is locked out.
import { mkdtemp, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { isLocalPeer, parseDefaultGateway, readDefaultGateway } from "./localPeer";

const HEADER = "Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT";
// Captured from the app container of the quickstart stack on Docker Desktop.
const APP_CONTAINER_ROUTES = [
  HEADER,
  "eth2\t00000000\t010014AC\t0003\t0\t0\t0\t00000000\t0\t0\t0",
  "eth0\t000012AC\t00000000\t0001\t0\t0\t0\t0000FFFF\t0\t0\t0",
  "eth1\t000013AC\t00000000\t0001\t0\t0\t0\t0000FFFF\t0\t0\t0",
  "eth2\t000014AC\t00000000\t0001\t0\t0\t0\t0000FFFF\t0\t0\t0",
].join("\n");

describe("parseDefaultGateway", () => {
  it("decodes the default route's little-endian gateway", () => {
    expect(parseDefaultGateway(APP_CONTAINER_ROUTES)).toBe("172.20.0.1");
  });

  it("finds none without a default route, as on an internal-only network", () => {
    expect(
      parseDefaultGateway(
        APP_CONTAINER_ROUTES.split("\n")
          .filter((l) => !l.includes("\t00000000\t010014AC"))
          .join("\n"),
      ),
    ).toBeNull();
  });

  it("ignores a default route that has no gateway flag", () => {
    expect(
      parseDefaultGateway([HEADER, "eth0\t00000000\t010014AC\t0001\t0\t0\t0\t00000000\t0\t0\t0"].join("\n")),
    ).toBeNull();
  });
});

describe("readDefaultGateway", () => {
  it("reads the route table file, and returns null when there is none", async () => {
    const file = join(await mkdtemp(join(tmpdir(), "route-")), "route");
    await writeFile(file, APP_CONTAINER_ROUTES);
    expect(readDefaultGateway(file)).toBe("172.20.0.1");
    expect(readDefaultGateway(join(tmpdir(), "no-such-route-file"))).toBeNull();
  });
});

describe("isLocalPeer", () => {
  const GATEWAY = "172.20.0.1";

  it("admits loopback in every form Node reports it", () => {
    for (const address of ["127.0.0.1", "127.8.9.10", "::1", "::ffff:127.0.0.1"]) {
      expect(isLocalPeer(address, GATEWAY), address).toBe(true);
    }
  });

  it("admits the bridge gateway, the address the host's browser arrives from", () => {
    expect(isLocalPeer("172.20.0.1", GATEWAY)).toBe(true);
    expect(isLocalPeer("::ffff:172.20.0.1", GATEWAY)).toBe(true);
  });

  it("refuses the LAN, other bridge peers and anything unknown", () => {
    for (const address of [
      "192.168.1.20",
      "10.0.0.5",
      "172.20.0.5",
      "203.0.113.7",
      "::ffff:192.168.1.20",
      "fe80::1",
      "",
      undefined,
    ]) {
      expect(isLocalPeer(address, GATEWAY), String(address)).toBe(false);
    }
  });

  it("admits only loopback when no gateway could be read", () => {
    expect(isLocalPeer("127.0.0.1", null)).toBe(true);
    expect(isLocalPeer("172.20.0.1", null)).toBe(false);
  });
});
