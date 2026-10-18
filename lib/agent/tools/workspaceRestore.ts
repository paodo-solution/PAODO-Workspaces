// A signal tool (like compact_context): the runner performs the restore after the turn commits, out of the
// agent's reach. Restores files only, never external side effects.

import { StructuredTool } from "@langchain/core/tools";
import { z } from "zod";

const SHA = /^[0-9a-fA-F]{4,40}$/;

const schema = z.object({
  sha: z
    .string()
    .describe(
      "Target snapshot, a sha from workspace_history. Always list history first, then restore the exact snapshot you chose.",
    ),
});

export class WorkspaceRestoreTool extends StructuredTool<typeof schema> {
  name = "workspace_restore";
  description = `Roll the workspace files back to a previous snapshot, then keep working — use it to recover from a wrong turn instead of piling fixes on a broken state.

First call workspace_history to see the snapshots and pick the right target, THEN restore — don't call this blind.
- Pass a sha from workspace_history → revert to that specific snapshot. The current snapshot is marked in the history overview, so use that list to pick the right restore point.

This restores FILES only: it cannot undo external side effects (a sent email, an API call already made). The rollback is recorded in history like any other change. After it, the files are back to the target state and you can retry from there.`;
  schema = schema;

  protected async _call({ sha }: z.infer<typeof schema>): Promise<string> {
    // Signal only — the runner performs the restore. We just validate the target shape and return
    // an ack; an obviously bad sha is rejected here so the agent re-reads workspace_history.
    if (!SHA.test(sha)) {
      return "Error: invalid sha — pass a sha from workspace_history.";
    }
    return `Restoring the workspace files to snapshot ${sha}. Files only — external side effects (sent emails, API calls) are not undone.`;
  }
}
