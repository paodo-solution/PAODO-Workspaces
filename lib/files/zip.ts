// Streams selected paths as one ZIP (fast DEFLATE, shared fd budget). Traversal follows the ignore
// contract, but an explicitly selected path is archived regardless.

import path from "path";
import type JSZip from "jszip";
import { readTransferEntries } from "./entries";
import { Fanout, MAX_CONCURRENT_WALKS, openFileLimiter, type Semaphore } from "./fdLimit";
import { RootedFsError, readFile, statEntry, withDir, type RootedDir } from "./rootedFs";
import { relativeEntryPath } from "./relpath";

// `skip` gets every entry that cannot be archived. A symlink is one of them: the agent plants links, and
// following one would archive whatever it points at.
async function addDirToZip(
  zip: JSZip,
  limits: ZipLimits,
  dir: RootedDir,
  zipPath: string,
  skip: (entryPath: string, err: unknown) => void,
) {
  const entries = await readTransferEntries(dir, limits.sem);
  // JSZip only creates folders that hold files, so add empty directories explicitly.
  if (entries.length === 0) {
    zip.folder(zipPath);
    return;
  }
  const files = entries.filter((entry) => !entry.isDirectory());
  // Read concurrently under the descriptor budget, then added in readdir order.
  const contents = await Promise.all(
    files.map((entry) =>
      limits.sem.run(async () => {
        try {
          const handle = await dir.openFile(entry.name);
          try {
            return await handle.readFile();
          } finally {
            await handle.close();
          }
        } catch (err) {
          skip(dir.childRel(entry.name), err);
          return null;
        }
      }),
    ),
  );
  files.forEach((entry, i) => {
    const bytes = contents[i];
    if (bytes) zip.file(path.join(zipPath, entry.name), bytes);
  });

  await limits.fanout.map(
    entries.filter((entry) => entry.isDirectory()),
    async (entry) => {
      try {
        const child = await dir.openDir(entry.name);
        try {
          await addDirToZip(zip, limits, child, path.join(zipPath, entry.name), skip);
        } finally {
          await child.close();
        }
      } catch (err) {
        skip(dir.childRel(entry.name), err);
      }
    },
  );
}

interface ZipLimits {
  sem: Semaphore;
  fanout: Fanout;
}

// The deepest shared parent as "dir/" ("" if none), compared by segment so `src/app` and
// `src/application` share only `src/`.
function commonParentPrefix(entryPaths: string[]): string {
  const parents = entryPaths.map((entryPath) => entryPath.split("/").slice(0, -1));
  let shared = parents[0] ?? [];
  for (const parent of parents.slice(1)) {
    let i = 0;
    while (i < shared.length && i < parent.length && shared[i] === parent[i]) i++;
    shared = shared.slice(0, i);
  }
  return shared.length > 0 ? `${shared.join("/")}/` : "";
}

// Strips the shared prefix so one nested file downloads without its empty ancestry. Anything not a
// plain relative name falls back to the full path, preventing zip-slip.
function zipEntryName(entryPath: string, prefix: string): string {
  if (prefix === "" || !entryPath.startsWith(prefix)) return entryPath;
  const stripped = entryPath.slice(prefix.length);
  if (stripped === "" || stripped.startsWith("/") || stripped.split("/").includes("..")) return entryPath;
  return stripped;
}

// Unarchivable paths, symlinks inside a selected folder included, go to `onSkip` instead of failing the
// zip. A `rootFolder` (validated, no separators) nests everything in one folder.
export async function addSelectedToZip(
  zip: JSZip,
  baseDir: string,
  paths: string[],
  onSkip: (filePath: string, err: unknown) => void,
  rootFolder?: string,
) {
  const target = rootFolder ? (zip.folder(rootFolder) ?? zip) : zip;
  const limits: ZipLimits = { sem: openFileLimiter(), fanout: new Fanout(MAX_CONCURRENT_WALKS) };

  // Validate up front: the shared prefix has to be known before the first entry is named.
  const selected: { relPath: string; entryPath: string }[] = [];
  for (const relPath of paths) {
    try {
      selected.push({ relPath, entryPath: relativeEntryPath(relPath) });
    } catch (err) {
      onSkip(relPath, err);
    }
  }
  const prefix = commonParentPrefix(selected.map((entry) => entry.entryPath));

  await Promise.all(
    selected.map(async ({ relPath, entryPath }) => {
      try {
        const zipPath = zipEntryName(entryPath, prefix);
        const stat = await statEntry(baseDir, entryPath);
        if (stat.isSymbolicLink()) throw new RootedFsError("ELOOP", entryPath, `${entryPath} is a symbolic link`);
        if (stat.isDirectory()) {
          await withDir(baseDir, entryPath, (dir) => addDirToZip(target, limits, dir, zipPath, onSkip));
        } else {
          target.file(zipPath, await limits.sem.run(() => readFile(baseDir, entryPath)));
        }
      } catch (err) {
        onSkip(relPath, err);
      }
    }),
  );
}

// Streams the zip as it's generated, so the response starts before compression finishes.
export function zipToStreamResponse(zip: JSZip, filename: string): Response {
  const internal = zip.generateInternalStream({
    type: "uint8array",
    compression: "DEFLATE",
    compressionOptions: { level: 1 },
    streamFiles: true,
  });

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      internal
        .on("data", (chunk: Uint8Array) => controller.enqueue(chunk))
        .on("error", (err: Error) => controller.error(err))
        .on("end", () => controller.close());
      internal.resume();
    },
  });

  return new Response(body, {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${filename}.zip"`,
    },
  });
}
