// Records apt packages (the only installs outside the durable $HOME) so a rebuilt container can reinstall them.
// Names, not files, so replays get current versions; AptInstallTool is the sole path, so the list is exact.
import { workspaceAptRecipeFile } from "./paths";
import { atomicSaveJson, readJson } from "./jsonPersist";
import { createLogger } from "./logger";

const log = createLogger("aptRecipe");

/** Package specs as passed to apt-get: a bare name, or name=version. */
export type AptRecipe = string[];

export function readAptRecipe(workspaceId: string): AptRecipe {
  const recipe = readJson<AptRecipe>(workspaceAptRecipeFile(workspaceId), []);
  return Array.isArray(recipe) ? recipe.filter((p) => typeof p === "string") : [];
}

// Called only after apt-get succeeds, so a failing package never replays on rebuild. Deduped by name:
// a new pin replaces the old spec but keeps its position, so replay order stays stable.
export function recordAptPackages(workspaceId: string, packages: string[]): void {
  const byName = new Map<string, string>();
  for (const spec of [...readAptRecipe(workspaceId), ...packages]) {
    byName.set(spec.split("=")[0], spec);
  }
  const recipe = [...byName.values()];
  try {
    atomicSaveJson(workspaceAptRecipeFile(workspaceId), recipe);
  } catch (err) {
    // The packages ARE installed and usable — only their replay-after-rebuild record is missing.
    log.error(
      { event: "apt_recipe_save_failed", outcome: "packages_not_recorded_for_rebuild", err, workspaceId, packages },
      "failed to record apt packages — they will not be reinstalled if the container is rebuilt",
    );
  }
}
