// The shape a snapshot ref must have. Defense in depth (git runs without a shell): the one git argument that
// comes verbatim from HTTP is refused by name, not left to git.

/** Abbreviated or full hex object name, matching what `git log --format=%h` and `%H` produce. */
const SNAPSHOT_SHA = /^[0-9a-fA-F]{4,40}$/;

export function isSnapshotSha(value: unknown): value is string {
  return typeof value === "string" && SNAPSHOT_SHA.test(value);
}
