// Streams selected paths as one ZIP (fast DEFLATE, shared fd budget). Traversal follows the ignore
// contract, but an explicitly selected path is archived regardless.

import fs from "fs/promises";
import path from "path";
import type JSZip from "jszip";
import { resolveContained } from "./containment";
import { readTransferEntries } from "./entries";
import { openFileLimiter, type Semaphore } from "./fdLimit";
import { relativeEntryPath } from "./relpath";

async function addDirToZip(zip: JSZip, sem: Semaphore, dirPath: string, zipPath: string) {
  const entries = await readTransferEntries(dirPath, sem);
  // JSZip only creates folders that hold files, so add empty directories explicitly.
  if (entries.length === 0) {
    zip.folder(zipPath);
    return;
  }
  await Promise.all(
    entries.map(async (entry) => {
      const fullPath = path.join(dirPath, entry.name);
      const entryZipPath = path.join(zipPath, entry.name);
      if (entry.isDirectory()) await addDirToZip(zip, sem, fullPath, entryZipPath);
      else zip.file(entryZipPath, await sem.run(() => fs.readFile(fullPath)));
    }),
  );
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

// Unarchivable paths, symlink escapes included, go to `onSkip` instead of failing the zip. A
// `rootFolder` (validated, no separators) nests everything in one folder.
export async function addSelectedToZip(
  zip: JSZip,
  baseDir: string,
  paths: string[],
  onSkip: (filePath: string, err: unknown) => void,
  rootFolder?: string,
) {
  const target = rootFolder ? (zip.folder(rootFolder) ?? zip) : zip;
  const sem = openFileLimiter();

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
        const resolved = await resolveContained(baseDir, entryPath);
        if (resolved === null) throw new Error("Path resolves outside the workspace");
        const zipPath = zipEntryName(entryPath, prefix);
        const stat = await sem.run(() => fs.stat(resolved));
        if (stat.isDirectory()) await addDirToZip(target, sem, resolved, zipPath);
        else target.file(zipPath, await sem.run(() => fs.readFile(resolved)));
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
