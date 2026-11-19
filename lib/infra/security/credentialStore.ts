// Every bearer key PAODO mints (workspace API, MCP, CLI token, VS Code devices), stored only as SHA-256
// hashes that never leave this module. Logins and third-party secrets live elsewhere.
import { createHash, randomBytes, timingSafeEqual } from "crypto";
import path from "path";
import { WORKSPACES_ROOT } from "../paths";
import { atomicSaveJson, readJson } from "../jsonPersist";
import { globalSingleton } from "../globalSingleton";
import { createAuditLogger, createLogger } from "../logger";

const log = createLogger("credentials");
const audit = createAuditLogger("credentials");
const FILE = path.join(WORKSPACES_ROOT, ".credentials.json");

export type CredentialKind = "workspace-api" | "workspace-mcp" | "platform" | "device";

/** Workspace id for the per-workspace kinds; null for the instance-wide platform token and device switch. */
export type CredentialSubject = string | null;

// A channel has two independent axes, the access flag (`enabled`) and the key; a key works only while both
// are set. This is what callers may see: there is deliberately no hash field, so no route can leak one.
export interface CredentialState {
  enabled: boolean;
  hasKey: boolean;
  createdAt: string | null;
  lastUsedAt: string | null;
}

interface CredentialRecord {
  hash: string | null;
  enabled: boolean;
  createdAt: string;
  lastUsedAt: string | null;
}

// Prefixes are worth keeping: a leaked key stays identifiable at a glance in a log, a bug report or
// a secret scanner. Derived from `kind` here rather than hardcoded at three mint sites.
const PREFIX: Record<Exclude<CredentialKind, "device">, string> = {
  "workspace-api": "sk_",
  "workspace-mcp": "mcp_",
  platform: "cli_",
};

const WORKSPACE_KINDS: readonly CredentialKind[] = ["workspace-api", "workspace-mcp"];

// A hash written more than this long ago is refreshed on use. Every save rewrites the whole file, so
// an exact lastUsedAt would mean a disk write per authenticated request; coarse is the right trade.
const LAST_USED_REFRESH_MS = 60_000;

// One VS Code device: an access token and a refresh token, both rotated on refresh. `expiresAt` is set
// at approval and never extended, so every device signs in again in the browser after DEVICE_TTL_MS.
interface DeviceRecord {
  kind: "device";
  accessHash: string;
  accessExpiresAt: string;
  refreshHash: string;
  /** The refresh token just replaced, honoured as "superseded" for REFRESH_GRACE_MS (another window raced). */
  previousRefreshHash: string | null;
  rotatedAt: string | null;
  /** False until the current pair is first used. Absent (older records) counts as used. */
  pairUsed?: boolean;
  expiresAt: string;
}

type StoredRecord = CredentialRecord | DeviceRecord;

const store = globalSingleton<Record<string, StoredRecord>>("credentials", () =>
  readJson<Record<string, StoredRecord>>(FILE, {}),
);

// Channel records only: device records live under `device:<id>`, a key recordKey never produces.
function channel(key: string): CredentialRecord | undefined {
  const record = store[key];
  return record && !("kind" in record) ? record : undefined;
}

// `platform` and the `device` switch take no subject; workspace kinds need one. A mismatch is a
// programming error, so throw. Device tokens themselves are issued by mintDevice, never by mint().
function recordKey(kind: CredentialKind, subject: CredentialSubject): string {
  if (kind === "platform" || kind === "device") {
    if (subject) throw new Error(`The ${kind} credential is instance-wide and takes no subject.`);
    return kind;
  }
  if (!subject) throw new Error(`The ${kind} credential requires a workspace id.`);
  return `${kind}:${subject}`;
}

function save(operation: string, kind: CredentialKind, data: Record<string, StoredRecord> = store): void {
  try {
    atomicSaveJson(FILE, data);
  } catch (err) {
    log.error(
      {
        event: "credential_store_save_failed",
        outcome: "credential_change_not_persisted",
        err,
        operation,
        kind,
        filePath: FILE,
      },
      "failed to save credential store",
    );
    throw err;
  }
}

function hashSecret(plain: string): string {
  return createHash("sha256").update(plain).digest("hex");
}

// Mints or rotates the key and returns the plaintext once. Never touches `enabled`: a key minted on a
// closed channel stays inert until someone opens it.
export function mint(kind: CredentialKind, subject: CredentialSubject = null): string {
  if (kind === "device") throw new Error("Device tokens are issued by mintDevice.");
  const key = recordKey(kind, subject);
  const plain = PREFIX[kind] + randomBytes(32).toString("hex");
  store[key] = {
    hash: hashSecret(plain),
    enabled: channel(key)?.enabled ?? false,
    createdAt: new Date().toISOString(),
    lastUsedAt: null,
  };
  save("mint", kind);
  audit.info({ kind, subject, event: "credential_minted" }, "credential minted");
  return plain;
}

// Destroys the key but keeps `enabled` (disabling is a separate intent). Idempotent, and audits only
// when a key existed, so `credential_revoked` always marks when access actually ended.
export function revoke(kind: CredentialKind, subject: CredentialSubject = null): void {
  const key = recordKey(kind, subject);
  const record = channel(key);
  if (!record?.hash) return;
  record.hash = null;
  save("revoke", kind);
  audit.info({ kind, subject, event: "credential_revoked" }, "credential revoked");
}

// Turns the access channel on or off. A channel may be enabled before a key exists — that is the
// UI's "Key required" state — but a disabled channel rejects every key.
export function setEnabled(kind: CredentialKind, subject: CredentialSubject, enabled: boolean): void {
  const key = recordKey(kind, subject);
  const previous = channel(key);
  store[key] = {
    hash: previous?.hash ?? null,
    enabled,
    createdAt: previous?.createdAt ?? new Date().toISOString(),
    lastUsedAt: previous?.lastUsedAt ?? null,
  };
  save("set_enabled", kind);
  audit.info({ kind, subject, enabled, event: "credential_enabled_changed" }, "credential enabled state changed");
}

export function state(kind: CredentialKind, subject: CredentialSubject = null): CredentialState {
  const record = channel(recordKey(kind, subject));
  return {
    enabled: record?.enabled ?? false,
    hasKey: (record?.hash ?? null) !== null,
    createdAt: record?.createdAt ?? null,
    lastUsedAt: record?.lastUsedAt ?? null,
  };
}

/** Forgets the credential entirely. For cleanup, not revocation — prefer revoke() to invalidate. */
export function remove(kind: CredentialKind, subject: CredentialSubject = null): void {
  const key = recordKey(kind, subject);
  if (!(key in store)) return;
  delete store[key];
  save("remove", kind);
  audit.info({ kind, subject, event: "credential_removed" }, "credential removed");
}

/** Drops every credential belonging to a workspace. Called when the workspace itself is deleted. */
export function removeWorkspace(subject: string): void {
  for (const kind of WORKSPACE_KINDS) remove(kind, subject);
}

function touchLastUsed(key: string, record: CredentialRecord): void {
  const now = Date.now();
  const previous = record.lastUsedAt ? Date.parse(record.lastUsedAt) : 0;
  if (Number.isFinite(previous) && now - previous < LAST_USED_REFRESH_MS) return;
  record.lastUsedAt = new Date(now).toISOString();
  try {
    atomicSaveJson(FILE, store);
  } catch (err) {
    // Best-effort only: last-used is telemetry, and a disk problem must not turn a valid
    // authentication into a failure. Deliberately does not use save(), which rethrows.
    log.warn(
      {
        event: "credential_last_used_not_persisted",
        outcome: "authentication_succeeded_telemetry_lost",
        err,
        credential: key,
        filePath: FILE,
      },
      "failed to persist credential last-used timestamp",
    );
  }
}

// Auth chokepoint for every programmatic caller. Fails closed on any doubt, including a malformed
// stored hash: a hand-edited or truncated file must deny, not throw.
export function validate(kind: CredentialKind, subject: CredentialSubject, plain: string): boolean {
  const key = recordKey(kind, subject);
  const record = channel(key);
  if (!record || !record.enabled || !record.hash || !plain) return false;

  if (!hashMatches(plain, record.hash)) return false;

  touchLastUsed(key, record);
  return true;
}

// Constant-time, and false rather than a throw on a length mismatch, which only a corrupted store produces.
function hashMatches(plain: string, hash: string | null): boolean {
  if (!hash) return false;
  const presented = Buffer.from(hashSecret(plain));
  const stored = Buffer.from(hash);
  if (presented.byteLength !== stored.byteLength) return false;
  return timingSafeEqual(presented, stored);
}

// ---------------------------------------------------------------- VS Code devices

// A short-lived access token, a refresh token replaced on every use, and a hard limit counted from the
// browser approval, after which the device must be approved again.
export const DEVICE_ACCESS_TTL_MS = 8 * 60 * 60_000;
export const DEVICE_TTL_MS = 30 * 24 * 60 * 60_000;
/** Two windows refreshing with the same token both stay signed in: the loser is told it was superseded. */
export const DEVICE_REFRESH_GRACE_MS = 60_000;

const DEVICE_TOKEN = /^(dat|drt)_([0-9a-f]{16})_[0-9a-f]{64}$/;

export interface DeviceTokens {
  deviceId: string;
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: string;
  expiresAt: string;
}

type DeviceRotation =
  { ok: true; tokens: DeviceTokens } | { ok: false; reason: "invalid" | "superseded" | "expired" | "disabled" };

const deviceKey = (id: string) => `device:${id}`;

function parseDeviceToken(plain: string, type: "dat" | "drt"): string | null {
  const match = DEVICE_TOKEN.exec(plain);
  return match && match[1] === type ? match[2] : null;
}

function device(id: string): DeviceRecord | undefined {
  const record = store[deviceKey(id)];
  return record && "kind" in record ? record : undefined;
}

// Two fresh secrets for `id`, written into `record`; returns their plaintexts.
function issuePair(id: string, record: DeviceRecord, now: number): DeviceTokens {
  const accessToken = `dat_${id}_${randomBytes(32).toString("hex")}`;
  const refreshToken = `drt_${id}_${randomBytes(32).toString("hex")}`;
  record.accessHash = hashSecret(accessToken);
  record.accessExpiresAt = new Date(now + DEVICE_ACCESS_TTL_MS).toISOString();
  record.refreshHash = hashSecret(refreshToken);
  record.pairUsed = false;
  return {
    deviceId: id,
    accessToken,
    refreshToken,
    accessExpiresAt: record.accessExpiresAt,
    expiresAt: record.expiresAt,
  };
}

// Puts `next` at `key` (null removes it), writing to disk before memory: if the write fails, memory is
// untouched and the error goes up, so a caller is never handed tokens the store does not hold.
function commitDevice(key: string, next: DeviceRecord | null, operation: string): void {
  const snapshot = { ...store };
  if (next) snapshot[key] = next;
  else delete snapshot[key];
  save(operation, "device", snapshot);
  if (next) store[key] = next;
  else delete store[key];
}

/** The "Allow VS Code connections" switch: every device token is refused while it is off. */
export function deviceAccessEnabled(): boolean {
  return state("device").enabled;
}

// Turning access off also forgets every device ("sign out every VS Code"). Switch and devices are saved in
// one write; if it fails, memory is put back as it was and the error goes up, so nothing is half-applied.
export function setDeviceAccess(enabled: boolean): void {
  const previous = store.device;
  const removed = enabled ? [] : Object.entries(store).filter(([key]) => key.startsWith("device:"));
  const channelBefore = channel("device");
  store.device = {
    hash: null,
    enabled,
    createdAt: channelBefore?.createdAt ?? new Date().toISOString(),
    lastUsedAt: channelBefore?.lastUsedAt ?? null,
  };
  for (const [key] of removed) delete store[key];
  try {
    save("set_device_access", "device");
  } catch (err) {
    if (previous) store.device = previous;
    else delete store.device;
    for (const [key, record] of removed) store[key] = record;
    throw err;
  }
  audit.info({ kind: "device", enabled, event: "credential_enabled_changed" }, "credential enabled state changed");
  if (removed.length > 0) {
    audit.info(
      { kind: "device", count: removed.length, event: "credential_revoked", reason: "access_off" },
      "devices revoked",
    );
  }
}

/** Approves a new device and returns its first token pair, the only time the plaintexts exist. */
export function mintDevice(now = Date.now()): DeviceTokens {
  const id = randomBytes(8).toString("hex");
  const record: DeviceRecord = {
    kind: "device",
    accessHash: "",
    accessExpiresAt: "",
    refreshHash: "",
    previousRefreshHash: null,
    rotatedAt: null,
    expiresAt: new Date(now + DEVICE_TTL_MS).toISOString(),
  };
  const tokens = issuePair(id, record, now);
  commitDevice(deviceKey(id), record, "mint_device");
  audit.info({ kind: "device", subject: id, event: "credential_minted" }, "device approved");
  return tokens;
}

// A device past its hard limit is forgotten on sight. This runs on the request path, so a failed write is
// only logged: the device is refused either way, and is forgotten again after a restart.
function expired(id: string, record: DeviceRecord, now: number): boolean {
  if (now < Date.parse(record.expiresAt)) return false;
  delete store[deviceKey(id)];
  try {
    atomicSaveJson(FILE, store);
  } catch (err) {
    log.warn(
      { event: "device_expiry_not_persisted", outcome: "device_refused_state_lost", err, subject: id },
      "failed to persist device expiry",
    );
  }
  audit.info({ kind: "device", subject: id, event: "credential_removed", reason: "expired" }, "device expired");
  return true;
}

/** The device id of a valid access token, or null. Fails closed, like validate(). */
export function validateDeviceAccess(plain: string, now = Date.now()): string | null {
  const id = parseDeviceToken(plain, "dat");
  if (!id || !deviceAccessEnabled()) return null;
  const record = device(id);
  if (!record || expired(id, record, now)) return null;
  if (now >= Date.parse(record.accessExpiresAt)) return null;
  if (!hashMatches(plain, record.accessHash)) return null;
  if (record.pairUsed === false) markPairUsed(id, record);
  return id;
}

// Written once per pair: it is what tells a lost refresh answer from a stolen token. Best-effort, like
// touchLastUsed, so a disk problem never turns a valid authentication into a failure.
function markPairUsed(id: string, record: DeviceRecord): void {
  record.pairUsed = true;
  try {
    atomicSaveJson(FILE, store);
  } catch (err) {
    log.warn(
      { event: "device_pair_use_not_persisted", outcome: "authentication_succeeded_state_lost", err, subject: id },
      "failed to persist device token use",
    );
  }
}

// Replaces both tokens. The old refresh token is "superseded" during the grace (another window); after it,
// an unused new pair means its answer was lost (reissue), a used one means a copy (revoke, RFC 9700).
export function rotateDevice(refreshPlain: string, now = Date.now()): DeviceRotation {
  if (!deviceAccessEnabled()) return { ok: false, reason: "disabled" };
  const id = parseDeviceToken(refreshPlain, "drt");
  const record = id ? device(id) : undefined;
  if (!id || !record) return { ok: false, reason: "invalid" };
  if (expired(id, record, now)) return { ok: false, reason: "expired" };

  if (hashMatches(refreshPlain, record.refreshHash)) {
    const next: DeviceRecord = {
      ...record,
      previousRefreshHash: record.refreshHash,
      rotatedAt: new Date(now).toISOString(),
    };
    const tokens = issuePair(id, next, now);
    commitDevice(deviceKey(id), next, "rotate_device");
    return { ok: true, tokens };
  }

  if (hashMatches(refreshPlain, record.previousRefreshHash)) {
    const rotatedAt = record.rotatedAt ? Date.parse(record.rotatedAt) : 0;
    if (now - rotatedAt <= DEVICE_REFRESH_GRACE_MS) return { ok: false, reason: "superseded" };
    if (record.pairUsed === false) {
      // Once only: the unused pair becomes "previous", so the old token is spent and that pair is a reuse tripwire.
      const next: DeviceRecord = {
        ...record,
        previousRefreshHash: record.refreshHash,
        rotatedAt: new Date(now).toISOString(),
      };
      const tokens = issuePair(id, next, now);
      commitDevice(deviceKey(id), next, "reissue_device");
      return { ok: true, tokens };
    }
    revokeDevice(id, "refresh_token_reused");
    return { ok: false, reason: "invalid" };
  }
  return { ok: false, reason: "invalid" };
}

// Forgets a device and both its tokens; returns whether it existed. Memory first, unlike issuing: a
// revocation must hold in this process even if the write fails, which still throws so the caller knows.
export function revokeDevice(id: string, reason = "revoked"): boolean {
  if (!device(id)) return false;
  delete store[deviceKey(id)];
  save("revoke_device", "device");
  audit.info({ kind: "device", subject: id, event: "credential_revoked", reason }, "device revoked");
  return true;
}
