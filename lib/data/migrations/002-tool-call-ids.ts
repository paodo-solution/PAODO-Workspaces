import type { Migration } from "./index";

// Backfills ids on stored tool calls, which could only be told apart by position. Content only; an
// existing id is kept.
export const toolCallIds: Migration = {
  version: 2,
  name: "tool-call-ids",
  up(db) {
    const turns = db
      .prepare("SELECT seq, tool_calls_json FROM turns WHERE json_array_length(tool_calls_json) > 0")
      .all() as Array<{ seq: number; tool_calls_json: string }>;
    const update = db.prepare("UPDATE turns SET tool_calls_json = ? WHERE seq = ?");

    for (const turn of turns) {
      const calls: unknown = JSON.parse(turn.tool_calls_json);
      if (!Array.isArray(calls)) continue;
      let changed = false;
      const withIds = calls.map((call: unknown) => {
        if (!call || typeof call !== "object" || Array.isArray(call)) return call;
        if (typeof (call as { id?: unknown }).id === "string") return call;
        changed = true;
        return { id: crypto.randomUUID(), ...call };
      });
      if (changed) update.run(JSON.stringify(withIds), turn.seq);
    }
  },
};
