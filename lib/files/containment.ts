// Containment for caller paths (uploads, agent file tools): realpaths the nearest existing ancestor, since a
// symlink inside the root can point anywhere. assertContained.ts covers absolute paths from HTTP routes.
import fs from "fs/promises";
import path from "path";

/**
 * Resolve `requestedPath` against `rootDir`, returning the resolved real path, or `null` if it would
 * escape `rootDir` — via `..`, an absolute path, or a symlink anywhere along the way (including
 * `rootDir` itself). `rootDir` must already exist; `requestedPath` need not.
 */
export async function resolveContained(rootDir: string, requestedPath: string): Promise<string | null> {
  const root = await fs.realpath(rootDir);
  const target = path.normalize(path.resolve(root, requestedPath));
  if (target !== root && !target.startsWith(root + path.sep)) return null; // lexical escape

  // Walk up from the target until we hit something that actually exists, realpath'ing it (this is
  // what resolves an interior symlink), then reattach whatever tail didn't exist yet.
  const tail: string[] = [];
  let existing = target;
  for (;;) {
    try {
      existing = await fs.realpath(existing);
      break;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw err;
      const parent = path.dirname(existing);
      if (parent === existing) return null; // reached the filesystem root without finding `root`
      tail.unshift(path.basename(existing));
      existing = parent;
    }
  }
  const real = tail.length > 0 ? path.join(existing, ...tail) : existing;
  return real === root || real.startsWith(root + path.sep) ? real : null;
}
