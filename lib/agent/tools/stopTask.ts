// stop_task: kills a background task by id (like Claude Code's KillShell), e.g. to free port 8080. Otherwise
// tasks live until a new run or the container stops.

import { StructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import type { IBackgroundTasks } from "../../infra/interfaces";

const schema = z.object({
  task_id: z.string().describe("The ID of the background task to stop (as reported when it was started)."),
});

export class StopTaskTool extends StructuredTool<typeof schema> {
  name = "stop_task";
  description = `Stop a background task previously started with execute_command(run_in_background: true).
Use this to free a long-running process — e.g. to restart a dev server holding port 8080, or to shut
one down when it is no longer needed. Pass the task ID reported when the task was started (running
background tasks are also listed in your context).`;
  schema = schema;

  constructor(
    private readonly workspaceId: string,
    private readonly containers: IBackgroundTasks,
  ) {
    super();
  }

  protected async _call({ task_id }: z.infer<typeof schema>): Promise<string> {
    const stopped = await this.containers.stopBackground(this.workspaceId, task_id);
    if (!stopped) {
      return `Error: no running background task found with ID: ${task_id}`;
    }
    return `Stopped background task ${task_id}.`;
  }
}
