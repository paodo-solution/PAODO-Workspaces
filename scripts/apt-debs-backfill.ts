// Ahead of the lib imports: paths.ts reads WORKSPACES_ROOT at module load, and PAODO_DEPLOYMENT is
// fatal when unset, so both have to be in the environment before either module evaluates.
import "dotenv/config";
import { readAptRecipe } from "../lib/infra/aptRecipe";
import { defaultContainerManager } from "../lib/infra/docker/defaultContainerManager";
import { defaultWorkspaceStore } from "../lib/infra/workspace/registry";

const USAGE = `Usage:
  npm run apt:backfill -- <workspace-id>… | --all

Saves the .deb files of the apt packages an existing container already has installed, so a rebuilt
container can reinstall them with no network. The container is started if needed, never recreated.
It downloads those exact versions again, so the workspace needs internet while this runs: turn it on,
or add the Ubuntu mirror hosts to its allowlist, then put the setting back afterwards.`;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const all = args.includes("--all");
  const ids = args.filter((arg) => !arg.startsWith("--"));
  if (!all && ids.length === 0) throw new Error(USAGE);

  const workspaces = defaultWorkspaceStore.listWorkspaces().filter((ws) => all || ids.includes(ws.id));
  const unknown = ids.filter((id) => !workspaces.some((ws) => ws.id === id));
  if (unknown.length > 0) throw new Error(`Unknown workspace id(s): ${unknown.join(", ")}`);

  let failures = 0;
  for (const ws of workspaces) {
    const label = `${ws.name} (${ws.id})`;
    if (readAptRecipe(ws.id).length === 0) {
      console.log(`${label}: no apt packages installed, skipped.`);
      continue;
    }
    try {
      const { saved, failed } = await defaultContainerManager.backfillAptDebs(ws.id, ws.dir);
      console.log(`${label}: saved ${saved.length} package(s)${saved.length ? `: ${saved.join(", ")}` : ""}.`);
      if (failed.length > 0) {
        failures++;
        console.log(`${label}: could not save ${failed.length}: ${failed.join(", ")}`);
      }
    } catch (error) {
      failures++;
      console.log(`${label}: failed — ${error instanceof Error ? error.message : error}`);
    }
  }
  if (failures > 0) process.exitCode = 1;
}

// Explicit exit: ensure() arms the idle reaper's timer, which would otherwise hold the process open.
void main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => process.exit());
