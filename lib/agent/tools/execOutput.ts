// Caps command output held in memory: unbounded, `+=` would throw RangeError in a stream handler and crash the
// instance. Past the cap, output streams to a file in the container that the agent can grep or tail.

import type { OutputSink } from "../../infra/interfaces";
import { MAX_INLINE_BYTES, PREVIEW_BYTES, STDERR_SAMPLE_BYTES, formatOutputBytes } from "../../infra/limits";

// One command's stdout and stderr. Under the cap they're kept whole and separate; over it, everything
// goes to a sink and only a head preview is kept.
export class ExecOutput {
  // Arrival-order copy, used to flush a complete file at spill time and to cut the preview. Only
  // retained until the spill happens, which is the only moment it is needed.
  private ordered: Buffer[] = [];
  private stdoutKept: Buffer[] = [];
  private stderrKept: Buffer[] = [];
  private inlineBytes = 0;
  private totalBytes = 0;
  private sink: OutputSink | null = null;
  private preview: Buffer | null = null;
  // Bounded stderr sample, kept alongside the streams above and — unlike them — NOT dropped at spill
  // time. Costs at most 2 × STDERR_SAMPLE_BYTES regardless of how much stderr the command produces.
  private stderrHead = Buffer.alloc(0);
  private stderrTail: Buffer[] = [];
  private stderrTailBytes = 0;
  private stderrSeen = 0;

  /** openSink is called at most once, lazily — a command that stays under the cap never spawns one. */
  constructor(
    private readonly openSink: () => OutputSink,
    private readonly limit = MAX_INLINE_BYTES,
  ) {}

  append(stream: "stdout" | "stderr", text: string): void {
    const buf = Buffer.from(text, "utf8");
    this.totalBytes += buf.length;
    if (stream === "stderr") this.sampleStderr(buf);

    if (this.sink) {
      this.sink.write(buf);
      return;
    }

    // Keep the WHOLE crossing chunk before spilling, or the bytes past the cap would be missing from the
    // file too.
    this.ordered.push(buf);
    (stream === "stdout" ? this.stdoutKept : this.stderrKept).push(buf);
    this.inlineBytes += buf.length;
    if (this.inlineBytes > this.limit) this.spill();
  }

  // Fixed-size window over stderr: fill the head once, then keep a rolling tail. A single chunk
  // larger than the window contributes only its own tail, so neither buffer tracks stderr's size.
  private sampleStderr(buf: Buffer): void {
    this.stderrSeen += buf.length;

    const headRoom = STDERR_SAMPLE_BYTES - this.stderrHead.length;
    if (headRoom > 0) this.stderrHead = Buffer.concat([this.stderrHead, buf.subarray(0, headRoom)]);

    const piece = buf.length > STDERR_SAMPLE_BYTES ? buf.subarray(buf.length - STDERR_SAMPLE_BYTES) : buf;
    this.stderrTail.push(piece);
    this.stderrTailBytes += piece.length;
    while (this.stderrTail.length > 1 && this.stderrTailBytes - this.stderrTail[0].length >= STDERR_SAMPLE_BYTES) {
      this.stderrTailBytes -= this.stderrTail.shift()!.length;
    }
  }

  // head + tail, with the gap between them quantified rather than spliced over.
  private stderrSample(): string {
    const head = this.stderrHead;
    if (this.stderrSeen <= head.length) return head.toString("utf8");

    const joined = Buffer.concat(this.stderrTail);
    const tail = joined.length > STDERR_SAMPLE_BYTES ? joined.subarray(joined.length - STDERR_SAMPLE_BYTES) : joined;
    const hidden = this.stderrSeen - head.length - tail.length;
    // Non-positive means the two ends overlap and between them hold all of stderr — drop the
    // duplicated bytes rather than printing them twice.
    if (hidden <= 0) return head.toString("utf8") + tail.subarray(-hidden).toString("utf8");
    return [
      head.toString("utf8"),
      `… ${formatOutputBytes(hidden)} of stderr omitted (full output is in the saved file) …`,
      tail.toString("utf8"),
    ].join("\n");
  }

  private spill(): void {
    const all = Buffer.concat(this.ordered);
    this.preview = all.subarray(0, PREVIEW_BYTES);
    this.sink = this.openSink();
    this.sink.write(all);
    // Everything retained for the inline path is now either in the preview or in the file. Dropping
    // these is what actually bounds the memory — without it the cap would only slow the growth.
    this.ordered = [];
    this.stdoutKept = [];
    this.stderrKept = [];
  }

  /** True once output passed the cap, i.e. the result is a preview + file rather than whole output. */
  get overflowed(): boolean {
    return this.sink !== null;
  }

  get bytes(): number {
    return this.totalBytes;
  }

  stdoutText(): string {
    return Buffer.concat(this.stdoutKept).toString("utf8");
  }

  /** Whole stderr under the cap; the bounded head+tail sample once the streams have been spilled. */
  stderrText(): string {
    return this.overflowed ? this.stderrSample() : Buffer.concat(this.stderrKept).toString("utf8");
  }

  // Size, file path and head preview for an over-cap result, modelled on Claude Code's message so the
  // agent knows to go query the file.
  overflowNotice(): string {
    const sink = this.sink;
    if (!sink || !this.preview) return "";
    const lines = [
      `Output too large (${formatOutputBytes(this.totalBytes)}). Full output saved to: ${sink.path}`,
      `Read it with execute_command, e.g. tail -n 200 ${sink.path} or grep -n "error" ${sink.path}.`,
    ];
    if (sink.truncated) {
      // The file has its own ceiling, so "full output" would otherwise be a promise we did not keep.
      lines.push(`(The saved file itself was capped — it holds the first ${formatOutputBytes(sink.limit)}.)`);
    }
    lines.push("", `Preview (first ${formatOutputBytes(PREVIEW_BYTES)}):`, this.preview.toString("utf8"), "...");
    return lines.join("\n");
  }

  /** Closes the sink if one was opened. Safe to call when the command produced little output. */
  close(): void {
    this.sink?.close();
  }
}
