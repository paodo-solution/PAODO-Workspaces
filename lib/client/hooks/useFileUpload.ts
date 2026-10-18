"use client";

import { useRef, useState } from "react";
import { MAX_UPLOAD_BYTES, formatBytes } from "@/lib/uploads/limits";
import { partitionByIgnore } from "@/lib/files/ignore";

/** A file paired with its intended path inside the workspace (folder uploads keep structure). */
export interface PathedFile {
  file: File;
  path: string;
}

// One request per file, bounded in parallel to stay under the server's upload rate limit. No archive, which
// would sit whole in memory on both ends.
const CONCURRENCY = 6;

// Thousands of files would mean thousands of re-renders, and no one reads every increment.
const PROGRESS_STEP = 10;

// A 429 here is expected backpressure on large trees, not a failure; wait as Retry-After says.
const RATE_LIMIT_RETRIES = 5;
const RETRY_AFTER_CAP_SECONDS = 30;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Prefer the server's own explanation: a 413 body carries the actual size and the limit. */
const failureReason = async (res: Response): Promise<string> => {
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  return body?.error ?? `${res.status} ${res.statusText}`.trim();
};

export interface UploadQueueResult {
  uploaded: number;
  /** Every path that didn't make it in — each file is attempted on its own, so one failure only ever costs that one file. */
  notUploaded: string[];
  /** Subset of `notUploaded` rejected as over the per-file size limit (413), tracked so the summary can say "over the limit" rather than lumping them with genuine errors. */
  overLimit: string[];
  /** A representative server-provided reason a file failed (507 out of disk, 500, ...), shown for context. Informational only — it never stops the rest of the queue. */
  errorSummary: string | null;
}

// One request per file, bounded concurrency; a failure costs only that file. Outside the hook so it
// can be tested without React.
export async function runUploadQueue(
  initialQueue: PathedFile[],
  opts: { apiBase: string; onProgress?: (uploaded: number) => void },
): Promise<UploadQueueResult> {
  const queue = [...initialQueue];
  const notUploaded: string[] = [];
  const overLimit: string[] = [];
  let uploaded = 0;
  // First server-provided failure reason seen, kept only so the summary can explain why files failed.
  // It never stops the queue — a file that can't upload is set aside and the rest keep going.
  let errorSummary: string | null = null;

  // Send one file, waiting out rate-limit pushback rather than counting a throttled file as failed.
  const send = async (entry: PathedFile): Promise<Response> => {
    for (let attempt = 0; ; attempt += 1) {
      const res = await fetch(`${opts.apiBase}/files/upload?path=${encodeURIComponent(entry.path)}`, {
        method: "POST",
        body: entry.file,
      });
      if (res.status !== 429 || attempt === RATE_LIMIT_RETRIES) return res;

      const retryAfter = Number(res.headers.get("retry-after"));
      const seconds = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 1;
      await sleep(Math.min(seconds, RETRY_AFTER_CAP_SECONDS) * 1000);
    }
  };

  const worker = async () => {
    while (queue.length > 0) {
      const entry = queue.shift()!;
      let res: Response;
      try {
        res = await send(entry);
      } catch {
        // A network drop on one file (or a throttled file that ran out of retries) costs only that
        // file — record it and move on to the next.
        notUploaded.push(entry.path);
        errorSummary ??= "Some files could not be uploaded — check your connection and try them again.";
        continue;
      }
      if (res.status === 413) {
        notUploaded.push(entry.path);
        overLimit.push(entry.path);
        continue;
      }
      if (!res.ok) {
        notUploaded.push(entry.path);
        errorSummary ??= await failureReason(res);
        continue;
      }
      uploaded += 1;
      opts.onProgress?.(uploaded);
    }
  };

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));

  return { uploaded, notUploaded, overLimit, errorSummary };
}

/** Result of the most recently finished upload batch, shown in the results popup. */
export interface UploadSummary {
  uploaded: number;
  // Files attempted that failed (too big, rejected, network), so `uploaded + failed.length` is the
  // attempted batch. Ignore-rule exclusions go in `excluded`, not here.
  failed: string[];
  /** Files the ignore rule left out (node_modules, .git…). Intentional, not a failure. */
  excluded: number;
  /** One sentence per cause, e.g. `node_modules excluded (12 files)`. */
  notes: string[];
  /** A representative failure reason (507, 500, network…), for context only. */
  errorSummary: string | null;
}

// Shared upload logic for the file tree panel — used by both the Files/Folder buttons and the
// drag-and-drop zone. Every entry point funnels into one per-file uploader.
export function useFileUpload(apiBase: string, onUploaded: () => void) {
  const [status, setStatus] = useState<string | null>(null);
  const [summary, setSummary] = useState<UploadSummary | null>(null);
  // A ref, not state, so a second call in the same tick is refused before any re-render.
  const inFlight = useRef(false);

  const uploadEntries = async (entries: PathedFile[], applyIgnorePatterns: boolean) => {
    if (entries.length === 0) return;
    if (inFlight.current) return;
    inFlight.current = true;
    setSummary(null);
    // Set synchronously so the panel shows busy from the first click rather than appearing idle.
    setStatus("Uploading…");

    // Folder uploads silently skip generated dirs (node_modules, .venv…) and say so in the results. Never for
    // plain file picks or drops.
    const excluded = applyIgnorePatterns ? partitionByIgnore(entries).excluded : new Map<string, PathedFile[]>();
    const excludedPaths = Array.from(excluded.values())
      .flat()
      .map((entry) => entry.path);
    const excludedSet = new Set(excludedPaths);
    const candidates = entries.filter((entry) => !excludedSet.has(entry.path));

    // Oversized files are skipped up front instead of failing the batch. The server enforces the same limit;
    // this just avoids doomed requests and explains early.
    const clientOversized = candidates.filter((entry) => entry.file.size > MAX_UPLOAD_BYTES).map((entry) => entry.path);
    const queue = candidates.filter((entry) => entry.file.size <= MAX_UPLOAD_BYTES);

    // One line per triggered category.
    const notesFor = (overLimitCount: number): string[] => {
      const notes = Array.from(excluded.entries()).map(
        ([name, group]) => `${name} excluded (${group.length} file${group.length === 1 ? "" : "s"})`,
      );
      if (overLimitCount > 0) {
        notes.push(
          `${overLimitCount} file${overLimitCount === 1 ? "" : "s"} over the ${formatBytes(MAX_UPLOAD_BYTES)} limit`,
        );
      }
      return notes;
    };

    if (queue.length === 0) {
      // Nothing left to send. No onUploaded(): nothing changed. Only oversized files count as failures.
      setSummary({
        uploaded: 0,
        failed: [...clientOversized],
        excluded: excludedPaths.length,
        notes: notesFor(clientOversized.length),
        errorSummary: null,
      });
      setStatus(null);
      inFlight.current = false;
      return;
    }

    try {
      const result = await runUploadQueue(queue, {
        apiBase,
        onProgress: (uploaded) => {
          if (uploaded === queue.length || uploaded % PROGRESS_STEP === 0) {
            setStatus(`Uploading ${uploaded}/${entries.length}…`);
          }
        },
      });
      const overLimitCount = clientOversized.length + result.overLimit.length;
      setSummary({
        uploaded: result.uploaded,
        failed: [...clientOversized, ...result.notUploaded],
        excluded: excludedPaths.length,
        notes: notesFor(overLimitCount),
        errorSummary: result.errorSummary,
      });
      onUploaded();
    } finally {
      setStatus(null);
      inFlight.current = false;
    }
  };

  // Single files: the name is the whole path, so they land at the root of the target directory.
  const uploadFiles = (files: File[]) =>
    uploadEntries(
      files.map((file) => ({ file, path: file.name })),
      false,
    );

  // <input webkitdirectory> yields flat File[] with webkitRelativePath carrying the structure.
  const uploadFolder = (files: File[]) =>
    uploadEntries(
      files.map((file) => ({ file, path: file.webkitRelativePath || file.name })),
      true,
    );

  // Used by drag-and-drop, which already has PathedFile[] in hand (built while walking the dropped
  // entries) — applyIgnorePatterns is true only for a dropped folder, never a flat multi-file drop.
  const uploadPathedFiles = (entries: PathedFile[], applyIgnorePatterns: boolean) =>
    uploadEntries(entries, applyIgnorePatterns);

  return { status, summary, uploadFiles, uploadFolder, uploadPathedFiles };
}
