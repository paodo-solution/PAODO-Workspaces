// Flattens a provider message's content (string or typed blocks) into text, for every consumer. Free of
// LangChain imports so messageSerialization.ts can use it.

/** A text-bearing block, whatever else the provider attached to it. */
function blockText(block: unknown): string {
  if (typeof block === "string") return block;
  if (block && typeof block === "object" && "text" in block) return String((block as { text: unknown }).text ?? "");
  return "";
}

// Text blocks joined with no separator, since streaming splits them mid-word. Non-text blocks are
// skipped.
export function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map(blockText).join("");
}

// One paragraph per block, for authored sections like the system prompt's. Empty blocks are dropped,
// leaving no blank gaps.
export function contentToParagraphs(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map(blockText).filter(Boolean).join("\n\n");
}
