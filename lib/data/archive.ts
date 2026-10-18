import { MANIFEST_MEMBER, type ArchiveManifest } from "../archive/manifest";

export const DATABASE_MEMBER = "paodo.db";
export const REGISTRY_MEMBER = "workspaces.json";

// The registry ships with the database, since every row is keyed by workspace id. Manifest first, so
// `tar xOf archive.tar.gz manifest.json` identifies a file without unpacking.
export const DATABASE_MEMBER_ORDER = [MANIFEST_MEMBER, DATABASE_MEMBER, REGISTRY_MEMBER] as const;

export interface DatabaseArchiveManifest extends ArchiveManifest {
  kind: "database";
  database: {
    /** SQLite's user_version, so a restore can refuse a database written by newer code. */
    userVersion: number;
  };
}
