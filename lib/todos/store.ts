// In-memory per-workspace checklist written by todo_write and read by the UI; resets on restart.
export type TodoStatus = "pending" | "in_progress" | "completed";
export type TodoPriority = "low" | "medium" | "high";

export interface Todo {
  id: string;
  content: string;
  displayText: string;
  status: TodoStatus;
  priority: TodoPriority;
}

const store = new Map<string, Todo[]>();

export function setTodos(workspaceId: string, todos: Todo[]): { old: Todo[]; updated: Todo[] } {
  const old = store.get(workspaceId) ?? [];
  store.set(workspaceId, todos);
  return { old, updated: todos };
}
