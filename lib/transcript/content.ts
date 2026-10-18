// Flattens a provider message's content (string or typed blocks) into text, for every consumer. Free of
// LangChain imports so messageSerialization.ts can use it.

/** A text-bearing block, whatever else the provider attached to it. */
function blockText(block: unknown): string {
  if (typeof block === "string") return block;
  if (block && typeof block === "object" && "text" in block) return String((block as { text: unknown }).text ?? "");
  return "";
}

/**
 * The message's text as one run, blocks concatenated with no separator — the provider split them at
 * arbitrary points mid-sentence while streaming, so anything inserted between them lands inside a
 * word. Non-text blocks (reasoning, tool calls, images) contribute nothing.
 */
export function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map(blockText).join("");
}

/**
 * The message's text with each block as its own paragraph, for content whose blocks are authored
 * sections rather than stream fragments — the system prompt, whose blocks are the model config, the
 * AGENTS.md body, and the drives and secrets listings. Empty blocks are dropped so a section that
 * rendered to nothing does not leave a blank gap.
 */
export function contentToParagraphs(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map(blockText).filter(Boolean).join("\n\n");
}
