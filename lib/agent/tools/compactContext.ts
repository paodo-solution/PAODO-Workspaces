// A signal tool: the runner compacts `messages` after the turn commits, keeping tool_call/result pairs intact.
// For light/medium, the ack's `next_step` survives as the last ToolMessage.

import { StructuredTool } from "@langchain/core/tools";
import { z } from "zod";

const schema = z.object({
  level: z
    .enum(["light", "medium", "hard"])
    .describe(
      "Levels in increasing aggressiveness. light = strip bulky re-derivable tool output (file reads, searches, command output) in place; keeps all reasoning and decisions — lossless and cheapest, the default between units of work. medium = summarize the older part of the conversation but keep the last few turns verbatim — use when the discussion itself (not just tool output) has grown large but you still need recent context. hard = replace the entire conversation with one short summary — a clean slate, for a clear boundary between independent units where nothing earlier is needed.",
    ),
  next_step: z
    .string()
    .describe(
      "REQUIRED. The very next concrete task to do after compaction, e.g. 'map batch 16'. This is the one thing guaranteed to survive even a hard compaction.",
    ),
});

export class CompactContextTool extends StructuredTool<typeof schema> {
  name = "compact_context";
  description = `Compact your own conversation to free context during a long multi-step job, then keep working — so earlier bulky output and stale discussion don't pile up. Choose light / medium / hard via the \`level\` argument (see its description for when to use each). Always pass next_step.`;
  schema = schema;

  protected async _call({ level, next_step }: z.infer<typeof schema>): Promise<string> {
    // No surgery here (no access to messages). The runner reads this tool call and compacts.
    return `[Context compacted: ${level}.] Next step: ${next_step}`;
  }
}
