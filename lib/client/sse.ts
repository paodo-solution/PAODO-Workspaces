// Parses an SSE body into typed events: one `data: <json>` frame each, partial lines buffered across chunks,
// malformed lines skipped.

export async function* parseSseStream<T>(body: ReadableStream<Uint8Array>): AsyncGenerator<T> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      try {
        yield JSON.parse(line.slice(6)) as T;
      } catch {
        /* skip malformed lines */
      }
    }
  }
}
