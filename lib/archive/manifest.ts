// Shape shared by every backup archive, whatever it holds. Pure types and names: no filesystem, no
// tar, no database — so both the writers and any future restore can read this without pulling infra in.

export const MANIFEST_MEMBER = "manifest.json";

/** What the archive holds. Restore dispatches on this rather than guessing from the filename. */
export type ArchiveKind = "workspace" | "database" | "graph" | "drives";

// Per kind, since formats change independently: bumping one must not relabel another. Restore reads
// this first.
export const SCHEMA_VERSIONS: Record<ArchiveKind | "set", number> = {
  workspace: 1,
  database: 1,
  graph: 1,
  drives: 1,
  set: 1,
};

/** One file packed inside an archive tar, with its size and hash. Not a whole archive — see SetEntry. */
export interface TarMember {
  name: string;
  bytes: number;
  sha256: string;
}

// `deployment` is our chosen name (cobalt-lynx), since a container's hostname changes every deploy.
// `host` is for diagnosis only; never sort or trust by it.
export interface ArchiveSource {
  deployment: string;
  host: string;
  capturedAt: string;
  paodoCommit: string | null;
}

export interface ArchiveManifest {
  schemaVersion: number;
  kind: ArchiveKind;
  source: ArchiveSource;
  contents: TarMember[];
}
