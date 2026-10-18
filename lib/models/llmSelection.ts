// The stored model-choice vocabulary, here rather than agent/ since the workspace entity owns it. No
// default constant: defaultModelSelection() picks the first provider .env enables.

// Every effort level, quietest first; each model accepts a subset, validated against its own list.
export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

// Stored placeholder for a model with no effort dial, never sent; the field isn't nullable.
export const NO_DIAL_EFFORT: ReasoningEffort = "low";

// How "thinking off" is stored, so a model that can switch thinking off must list "none".
export const THINKING_OFF_EFFORT: ReasoningEffort = "none";
