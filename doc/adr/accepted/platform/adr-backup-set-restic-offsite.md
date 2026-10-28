# ADR — Self-describing backup set shipped offsite by restic

Status: Accepted

## Context

A deployment's durable state is spread over several stores that reference each other by workspace id: the database and workspace registry, the agent graph, shared drives, and each workspace. A box can be lost entirely, so backups must leave it, be encrypted, stay bounded in size, and restore as one coherent state.

Offsite transport, meaning encryption, deduplication, retention and repository checks, is a solved problem. Knowing what a consistent, restorable deployment looks like is not, and only the app knows it.

## Decision

Split backup into two responsibilities, joined by `scripts/backup-offsite.sh`:

- **The app builds a self-describing backup set on disk** (`npm run backup`). A set has one archive per store and per workspace, plus a `backup.json` manifest. A workspace archive also carries its saved apt packages (`apt-debs.tar`, uncompressed so restic stores each package once), so a restored workspace gets them back with no internet. Each archive carries its own manifest with hashes and a schema version. The set records which deployment produced it, and it never contains secrets or vaults. The app knows nothing about S3.
- **Restic ships the set offsite.** It pushes to the box's own S3 bucket, using the S3 keys already in `.env` and a repository password kept on the box. It also handles deduplication, rolling retention (about a year of recovery points) and integrity checks. Each box opts in to a nightly systemd timer.

Restore is the reverse, run by an operator. `restic restore` fetches one day's set to disk. Then, with the app stopped, `npm run restore` verifies the whole set before writing anything and applies it as one unit, in dependency order. Restoring a single store on its own is deliberately not supported.

## Consequences

- The app only has to define what a correct set is. Encryption, dedup and retention come from a proven tool, with no code of ours.
- A set can be inspected and verified without the app. A corrupted set, or one from another deployment, is caught before anything is written.
- No new credentials are needed, but recovery depends on two secrets: the restic password and the S3 keys. Losing either makes every backup unrecoverable.
- A restored box has no credentials. Vaults must be backed up separately from their keys, or the credentials re-entered.
- A set is not one point-in-time snapshot: its archives are captured one after another while the app is running.
- A restore stops before writing anything if verification fails. A failure after writing has started leaves the box half-restored, so the operator must fix the cause and re-run.
- Scheduling is manual for each box, so a newly commissioned box can be left without one by mistake.

## Alternatives considered

- **The app pushes to S3 itself**: we would reimplement encryption, dedup and retention, and do them less well than restic.
- **Snapshotting volumes or the host disk**: these snapshots are not self-describing and are tied to the host layout. They are unsafe for a live SQLite database and cannot be verified before restoring.
- **Restoring one store at a time**: the stores reference each other, so a partial restore breaks those links.
- **Including vaults in the set**: one leaked backup would expose every credential.

## Notes

- Runbook: `doc/backup-restic.md`.
- Code: `lib/infra/backup/` (set build and restore) and `scripts/backup-offsite.sh` (restic seam).
