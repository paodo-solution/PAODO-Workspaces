// Workspace skill definitions — one JSON file per skill under data/<workspace-name>/.skills/. A
// skill is a named action with JSON Schema input and output, both enforced in executeSkill.

/** Loose JSON Schema shape — we validate with ajv at runtime, not at the type level. */
export interface SkillSchema {
  type?: string;
  properties?: Record<string, SkillSchemaProperty>;
  required?: string[];
  /** JSON Schema annotation: representative valid values, shown during skill discovery. */
  examples?: unknown[];
  [key: string]: unknown;
}

export interface SkillSchemaProperty {
  type?: string;
  description?: string;
  enum?: unknown[];
  [key: string]: unknown;
}

export interface SkillDefinition {
  /** Stable, human-readable key referenced as `action` in call_agent and as the MCP tool name. */
  id: string;
  description: string;
  /** JSON Schema for the input args — validated before the callee runs. */
  input: SkillSchema;
  /** JSON Schema for the response — validated before the caller sees the result. */
  output: SkillSchema;
}

// `conversationId` is the callee's conversation, set whenever the callee ran (absent on pre-run
// rejections). UI deep-link metadata, never shown to the calling model.
export type SkillCallResult =
  | { state: "completed"; output: Record<string, unknown>; conversationId?: string }
  | { state: "failed"; code: SkillErrorCode; message: string; conversationId?: string };

export type SkillErrorCode =
  | "NOT_CONNECTED"
  | "SKILL_NOT_FOUND"
  | "INPUT_VALIDATION_ERROR"
  | "OUTPUT_VALIDATION_ERROR"
  | "NEEDS_INPUT"
  | "TIMEOUT"
  | "CANCELLED"
  | "CAPACITY_REACHED"
  | "INFRASTRUCTURE_UNAVAILABLE"
  // The callee cannot reach a working model, and no retry the caller makes changes that — only an
  // operator can. Mirrors TERMINAL_PROVIDER_CODES; a retryable cause stays EXECUTION_ERROR.
  | "PROVIDER_CREDIT_EXHAUSTED"
  | "PROVIDER_KEY_INVALID"
  | "PROVIDER_ACCESS_DENIED"
  | "PROVIDER_KEY_MISSING"
  | "MODEL_UNAVAILABLE"
  | "PROVIDER_UNAVAILABLE"
  | "EXECUTION_ERROR";

// A callee that can't resolve its args replies `{ "_needs_input": "<question>" }`; executeSkill turns
// it into a NEEDS_INPUT failure so the caller can retry.
export const NEEDS_INPUT_KEY = "_needs_input";
