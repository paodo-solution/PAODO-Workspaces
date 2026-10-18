// Shared pino logger: JSON to stdout only, which Docker captures and rotates (`docker logs paodo_ws-app-1`).
// Bare builtin specifiers, not `node:`: webpack bundles this via instrumentation.node.ts and rejects that scheme.
import { AsyncLocalStorage } from "async_hooks";
import pino from "pino";
import { runtimeMode } from "./runtimeMode";

const level = process.env.LOG_LEVEL ?? (runtimeMode.hotReload ? "debug" : "info");

// Async and capped, so stdout backpressure neither blocks the event loop nor grows memory (records past the
// cap are dropped). Fatal records drain synchronously; see logMethod and exitAfterLogs.
const destination = pino.destination({
  fd: 1,
  sync: false,
  // Keep even unusually large fatal records buffered until exitAfterLogs can drain them in one
  // synchronous boundary write. A short periodic flush still makes routine records visible fast.
  minLength: 512 * 1024,
  maxWrite: 1024 * 1024,
  periodicFlush: 100,
  maxLength: 8 * 1024 * 1024,
});

type LogContext = Record<string, unknown>;

// Scrubs credentials inside strings (echoed keys, authenticated URLs). Patterns need an auth label or a known
// token prefix, so hashes and ids survive.
const credentialPatterns: Array<[RegExp, string]> = [
  [
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
    "[Redacted Private Key]",
  ],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9+/=._:~-]+/gi, "$1 [Redacted]"],
  [/([a-z][a-z0-9+.-]*:\/\/[^:/\s]+:)[^@\s/]+@/gi, "$1[Redacted]@"],
  [/([?&](?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password)=)[^&#\s]+/gi, "$1[Redacted]"],
  [
    /\b(?:(?:sk-(?:proj-|ant-)?|sk_|github_pat_|gh[pousr]_|xox[baprs]-|AIza)[A-Za-z0-9._-]{8,}|(?:mcp|cli)_[A-Za-z0-9._-]{32,})\b/g,
    "[Redacted]",
  ],
  [
    /\b((?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
    "$1[Redacted]",
  ],
];

function sanitizeLogText(value: string): string {
  return credentialPatterns.reduce((text, [pattern, replacement]) => text.replace(pattern, replacement), value);
}

function sanitizeError(value: unknown): unknown {
  const serialized = pino.stdSerializers.err(value as Error);
  if (typeof serialized === "string") return sanitizeLogText(serialized);
  if (serialized === null || typeof serialized !== "object") return serialized;

  // ErrorLike has a custom prototype, so copy its fields here; Object.entries skips Pino's raw-error symbol,
  // which points back to the unsanitized Error.
  const copy: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(serialized)) copy[key] = sanitizeLogValue(item);
  return copy;
}

function sanitizeLogValue(value: unknown, seen = new WeakMap<object, unknown>()): unknown {
  if (typeof value === "string") return sanitizeLogText(value);
  // `err` gets an explicit serializer below. Leaving Error instances intact here prevents Pino's
  // built-in serializer from following its raw-error symbol back to the unsanitized original.
  if (value instanceof Error) return value;
  if (value === null || typeof value !== "object") return value;

  const existing = seen.get(value);
  if (existing) return existing;

  if (Array.isArray(value)) {
    const copy: unknown[] = [];
    seen.set(value, copy);
    for (const item of value) copy.push(sanitizeLogValue(item, seen));
    return copy;
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return value;

  const copy: Record<string, unknown> = {};
  seen.set(value, copy);
  for (const [key, item] of Object.entries(value)) copy[key] = sanitizeLogValue(item, seen);
  return copy;
}

const defaultOutcomes: Record<number, string> = {
  10: "diagnostic_recorded",
  20: "diagnostic_recorded",
  30: "event_recorded",
  40: "attention_required",
  50: "operation_failed",
  60: "process_exit",
};

/** Turn a human message into the fallback event for call sites that set none. */
function eventFromMessage(message: string | undefined, level: number): string {
  const event = (message ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 96)
    .replace(/_+$/g, "");
  if (!event) return `log_level_${level}`;
  return /^[a-z]/.test(event) ? event : `log_${event}`;
}

// Give every record an event and outcome; explicit fields win. Error and fatal call sites must set their
// own (errorLogContract.test.ts).
function applyLogContract(args: unknown[], level: number): unknown[] {
  const message = args.find((arg): arg is string => typeof arg === "string");
  const defaults = {
    event: eventFromMessage(message, level),
    outcome: defaultOutcomes[level] ?? "event_recorded",
  };
  const first = args[0];
  if (first !== null && typeof first === "object" && !Array.isArray(first) && !(first instanceof Error)) {
    return [{ ...defaults, ...(first as Record<string, unknown>) }, ...args.slice(1)];
  }
  return [defaults, ...args];
}

// On the global so the server and Next route bundles, which load this module separately, share request context.
const g = globalThis as typeof globalThis & { _paodoLogContext?: AsyncLocalStorage<LogContext> };
const logContext = (g._paodoLogContext ??= new AsyncLocalStorage<LogContext>());

const root = pino(
  {
    level,
    // Third-party API keys pass through this process (credential proxy), so a logged token is a real leak.
    redact: {
      paths: [
        "password",
        "token",
        "secret",
        "apiKey",
        "authorization",
        "headers.authorization",
        "req.headers.authorization",
        "*.password",
        "*.token",
        "*.secret",
        "*.apiKey",
        "*.authorization",
      ],
      censor: "[Redacted]",
    },
    serializers: {
      err(value: unknown) {
        return sanitizeError(value);
      },
    },
    hooks: {
      // Sanitizes bindings and message before serialization (Error fields are scrubbed by the `err` serializer).
      logMethod(args, method, level) {
        // Fatal alone may block: drain the buffer to make room, since the process is about to exit.
        if (level === 60) {
          try {
            destination.flushSync();
          } catch {
            // Best effort: a broken stdout must not prevent the exit.
          }
        }
        const sanitized = args.map((arg) => sanitizeLogValue(arg));
        method.apply(this, applyLogContract(sanitized, level) as Parameters<typeof method>);
      },
    },
    // Pino may mutate the object returned by mixin, so never hand it the stored object directly.
    mixin: () => ({ ...(logContext.getStore() ?? {}) }),
  },
  // No pino-pretty: Next would bundle its node:stream and break the dev server. Pipe through
  // `npx pino-pretty` instead.
  destination,
);

export function createLogger(context: string) {
  return root.child({ context });
}

// Security-event logger, tagged `audit: true` on the same stream (`jq 'select(.audit)'`). LOG_LEVEL
// applies too, so a level above `info` hides low-severity audit events.
export function createAuditLogger(context: string) {
  return root.child({ context, audit: true });
}

/** Run work with structured fields automatically attached to every log line it produces. */
export function runWithLogContext<T>(bindings: LogContext, fn: () => T): T {
  return logContext.run(bindings, fn);
}

/** Drain buffered records synchronously. Reserved for tests and intentional process shutdown. */
export function flushLogsSync(): void {
  destination.flushSync();
}

/** Flush the final log records and terminate even if stdout itself cannot be drained. */
export function exitAfterLogs(code: number): never {
  try {
    flushLogsSync();
  } finally {
    process.exit(code);
  }
}
