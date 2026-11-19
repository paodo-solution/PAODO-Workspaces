// Which TCP peers count as "this machine" for PAODO_AUTH_MODE=local: loopback, and the Docker bridge gateway that
// the host's own requests arrive from. Never a private range: that is the LAN local mode must keep out.
import { readFileSync } from "fs";

const RTF_GATEWAY = 0x2;

// The default route's gateway in /proc/net/route, whose addresses are little-endian hex (010014AC = 172.20.0.1).
export function parseDefaultGateway(routeTable: string): string | null {
  for (const line of routeTable.split("\n").slice(1)) {
    const [, destination, gateway, flags] = line.trim().split(/\s+/);
    if (destination !== "00000000" || !gateway || !(parseInt(flags, 16) & RTF_GATEWAY)) continue;
    const octets = gateway.match(/../g)?.map((byte) => parseInt(byte, 16));
    if (octets?.length !== 4 || octets.some(Number.isNaN)) continue;
    return octets.reverse().join(".");
  }
  return null;
}

/** Null outside Linux or without a default route, which leaves loopback as the only local peer. */
export function readDefaultGateway(path = "/proc/net/route"): string | null {
  try {
    return parseDefaultGateway(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/** The socket's own address only: a forwarded header is client-supplied and would let anyone claim to be local. */
export function isLocalPeer(remoteAddress: string | undefined, gateway: string | null): boolean {
  if (!remoteAddress) return false;
  const address = remoteAddress.startsWith("::ffff:") ? remoteAddress.slice(7) : remoteAddress;
  if (address === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(address)) return true;
  return gateway !== null && address === gateway;
}
