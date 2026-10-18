// Gate before every model call, one bucket per provider+model since providers meter per model.
// Admission is serialized: concurrent callers trusting the same reported `remaining` would overdraw.
import { globalSingleton } from "../../infra/globalSingleton";
import type { RateLimitSnapshot } from "./rateLimitHeaders";
import { abortableDelay } from "./retryPolicy";

/** Identifies a bucket. Provider alone would merge models that meter separately. */
export interface PacerKey {
  provider: string;
  model: string;
}

/** An admitted call's hold on the bucket. Released exactly once, however the call ends. */
export interface PacerLease {
  /** How long `acquire` blocked. 0 when it admitted immediately. */
  waitedMs: number;
  /** Callers ahead of this one when it joined. 0 when it never queued. */
  queueDepth: number;
  /** Idempotent, like ProviderConcurrency's release — a call can both throw and be abandoned. */
  release(): void;
}

export interface PacerSnapshot extends PacerKey {
  limitRequests?: number;
  limitTokens?: number;
  remainingRequests?: number;
  remainingTokens?: number;
  /** Requests-per-window ceiling inferred from refusals, where the provider never reported one. */
  learnedRequests?: number;
  /** Calls this process has sent inside the window. */
  sendsInWindow: number;
  recoveryMs: number;
  inFlight: number;
  queued: number;
}

/** Told before a wait that is long enough to be worth showing a user. */
export type PacerNotice = (wait: { waitMs: number; queueDepth: number }) => void;

export interface AcquireOptions {
  signal?: AbortSignal;
  /** Called once, before sleeping, when the wait exceeds NOTICE_THRESHOLD_MS. */
  onPaced?: PacerNotice;
}

/** Below this a wait is not worth telling anyone about — it is shorter than the call it precedes. */
export const NOTICE_THRESHOLD_MS = 2_000;

// Waits are clamped into this range. The floor keeps a pathological reading from becoming a spin;
// the ceiling keeps a bad one from parking a run for an hour when the backstop would recover sooner.
const MIN_WAIT_MS = 50;
const MAX_WAIT_MS = 120_000;

// How the learned recovery moves. Growth is fast because a 429 proves we were wrong; decay is slow
// because a clean call only proves we were not *too* wrong, and a raised ceiling is rare.
const RECOVERY_GROWTH = 1.5;
const RECOVERY_DECAY = 0.95;
const MIN_RECOVERY_MS = 1_000;
const MAX_RECOVERY_MS = 90_000;
const INITIAL_RECOVERY_MS = 20_000;

// A reading older than this describes a window that has since turned over, so the pacer stops
// trusting `remaining` and falls back to what it counted itself.
const SNAPSHOT_TTL_MS = 60_000;

// Measured recoveries for a "per minute" limit ranged 16–52s, so a full minute is the conservative
// window: slightly slow, never high.
const LEDGER_WINDOW_MS = 60_000;

// Once a refusal has taught us a ceiling, edge back up after this many clean sends at it — so a
// ceiling raised on the provider's side is rediscovered instead of capping the run forever.
const CEILING_PROBE_AFTER = 12;

// What to assume a call will cost before anything has told us. Deliberately generous: overestimating
// costs a little throughput, underestimating costs a 429.
const COLD_TOKEN_ESTIMATE = 8_000;
const ESTIMATE_MARGIN = 1.2;

interface Waiter {
  resolve: () => void;
  reject: (err: unknown) => void;
}

/** One call this process sent, as the local ledger remembers it. */
interface Send {
  at: number;
  tokens: number;
}

interface Bucket {
  limitRequests?: number;
  limitTokens?: number;
  remainingRequests?: number;
  remainingTokens?: number;
  resetRequestsAt?: number;
  resetTokensAt?: number;
  /** Most recent provider-confirmed request-window boundary that has already passed. */
  requestsWindowStartedAt?: number;
  /** Most recent provider-confirmed token-window boundary that has already passed. */
  tokensWindowStartedAt?: number;
  retryAt?: number;
  // What this process sent inside the window. Mistral sends no rate-limit headers on streams, so for it
  // this count is all the pacer has.
  sends: Send[];
  /** Ceilings inferred from refusals, for the providers that never state them on a stream. */
  learnedRequests?: number;
  learnedTokens?: number;
  /** When the provider last refused. The baseline for the learned recovery. */
  refusedAt?: number;
  /** Clean sends since the ceiling was last learned, counted towards probing it upwards again. */
  cleanSends: number;
  /** When the fields above were last written from a response. */
  observedAt: number;
  // When a call was last admitted. What the spacing fallback measures from — `observedAt` would
  // let a run with no fresh readings send its whole loop back to back.
  lastSentAt: number;
  /** Learned drain-to-recovery interval, for providers that report no reset. */
  recoveryMs: number;
  /** The provider's own price for the last call. Mistral reports this; it beats any usage figure. */
  lastCost?: number;
  /** The last call's reported token usage, used only where `lastCost` is unavailable. */
  lastUsage?: number;
  /** Admitted but not yet settled. Their spend is not in `remaining` yet. */
  inFlight: number;
  /** True while a caller holds admission rights; others queue behind it. */
  admitting: boolean;
  waiters: Waiter[];
}

function freshBucket(now: number): Bucket {
  // lastSentAt starts far enough back that a cold bucket's first call is never spaced against a
  // send that did not happen.
  return {
    observedAt: now,
    lastSentAt: now - SNAPSHOT_TTL_MS,
    recoveryMs: INITIAL_RECOVERY_MS,
    sends: [],
    cleanSends: 0,
    inFlight: 0,
    admitting: false,
    waiters: [],
  };
}

const keyOf = (key: PacerKey) => `${key.provider}:${key.model}`;

const clampWait = (ms: number) => Math.min(MAX_WAIT_MS, Math.max(MIN_WAIT_MS, Math.ceil(ms)));

/** Jitter so a bucket's waiters, released one at a time, still do not land in lockstep. */
const jitter = (ms: number, random: () => number) => ms * (0.85 + random() * 0.3);

export interface ProviderPacerOptions {
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
}

export class ProviderPacer {
  private readonly buckets = new Map<string, Bucket>();
  private readonly now: () => number;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly random: () => number;

  constructor(options: ProviderPacerOptions = {}) {
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? abortableDelay;
    this.random = options.random ?? Math.random;
  }

  private bucketFor(key: PacerKey): Bucket {
    const id = keyOf(key);
    let bucket = this.buckets.get(id);
    if (!bucket) {
      bucket = freshBucket(this.now());
      this.buckets.set(id, bucket);
    }
    return bucket;
  }

  // What the next call is likely to cost. An agent's context grows slowly and monotonically, so the
  // last real charge plus a margin beats counting tokens over the whole message array every turn.
  private estimate(bucket: Bucket): number {
    return Math.ceil((bucket.lastCost ?? bucket.lastUsage ?? COLD_TOKEN_ESTIMATE) * ESTIMATE_MARGIN);
  }

  // Waits, then reserves this call's share. The lease must be released however the call ends; rejects
  // with the signal's reason if cancelled while waiting.
  async acquire(key: PacerKey, options: AcquireOptions = {}): Promise<PacerLease> {
    const bucket = this.bucketFor(key);
    const startedAt = this.now();
    const queueDepth = bucket.waiters.length + (bucket.admitting ? 1 : 0);

    // One caller decides at a time, so a reopened window isn't consumed by every waiter at once.
    if (bucket.admitting) await this.queue(bucket, options.signal);
    else bucket.admitting = true;

    try {
      let notified = false;
      for (;;) {
        options.signal?.throwIfAborted();
        const waitMs = this.waitFor(bucket);
        if (waitMs === 0) break;
        if (!notified && waitMs >= NOTICE_THRESHOLD_MS) {
          notified = true;
          options.onPaced?.({ waitMs, queueDepth });
        }
        await this.sleep(clampWait(jitter(waitMs, this.random)), options.signal);
      }
      this.reserve(bucket);
    } finally {
      this.passSlot(bucket);
    }

    return { waitedMs: this.now() - startedAt, queueDepth, release: this.leaseRelease(bucket) };
  }

  // The reservation `reserve` took, given back once. Without this a call that fails in a way the
  // pacer never hears about would hold a slot of the bucket for the life of the process.
  private leaseRelease(bucket: Bucket): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      bucket.inFlight = Math.max(0, bucket.inFlight - 1);
    };
  }

  private queue(bucket: Bucket, signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (signal?.aborted) return reject(signal.reason);
      const waiter: Waiter = { resolve, reject };
      bucket.waiters.push(waiter);
      // An abandoned waiter must leave the queue, or the bucket stalls behind a run nobody is
      // waiting on any more.
      signal?.addEventListener(
        "abort",
        () => {
          const at = bucket.waiters.indexOf(waiter);
          if (at !== -1) bucket.waiters.splice(at, 1);
          reject(signal.reason);
        },
        { once: true },
      );
    });
  }

  // Hands the slot straight to the next waiter with `admitting` kept true, so a new arrival can't jump
  // the queue.
  private passSlot(bucket: Bucket): void {
    const next = bucket.waiters.shift();
    if (next) next.resolve();
    else bucket.admitting = false;
  }

  /** Spend this call's share up front, so a concurrent caller cannot spend it too. */
  private reserve(bucket: Bucket): void {
    const now = this.now();
    bucket.inFlight += 1;
    bucket.lastSentAt = now;
    bucket.sends.push({ at: now, tokens: this.estimate(bucket) });
    bucket.cleanSends += 1;
    if (bucket.remainingRequests !== undefined) {
      bucket.remainingRequests = Math.max(0, bucket.remainingRequests - 1);
    }
    if (bucket.remainingTokens !== undefined) {
      bucket.remainingTokens = Math.max(0, bucket.remainingTokens - this.estimate(bucket));
    }
  }

  /** Forget sends that have aged out of the window; what remains is what still counts against us. */
  private prune(bucket: Bucket, now: number): void {
    const cutoff = now - LEDGER_WINDOW_MS;
    let drop = 0;
    while (drop < bucket.sends.length && bucket.sends[drop].at <= cutoff) drop += 1;
    if (drop > 0) bucket.sends.splice(0, drop);
  }

  // Rolls each provider window once its reset passes, clearing the old `remaining` so nothing from the
  // closed window resurfaces.
  private rollProviderWindows(bucket: Bucket, now: number): void {
    if (bucket.resetRequestsAt !== undefined && now >= bucket.resetRequestsAt) {
      bucket.requestsWindowStartedAt = Math.max(bucket.requestsWindowStartedAt ?? 0, bucket.resetRequestsAt);
      bucket.resetRequestsAt = undefined;
      bucket.remainingRequests = undefined;
    }
    if (bucket.resetTokensAt !== undefined && now >= bucket.resetTokensAt) {
      bucket.tokensWindowStartedAt = Math.max(bucket.tokensWindowStartedAt ?? 0, bucket.resetTokensAt);
      bucket.resetTokensAt = undefined;
      bucket.remainingTokens = undefined;
    }
  }

  // Ms until this call may go. The ledger is primary and a fresh `remaining` only adds pessimism, so a
  // stale zero can't throttle forever while unseen traffic still counts.
  private waitFor(bucket: Bucket): number {
    const now = this.now();
    const estimate = this.estimate(bucket);
    this.prune(bucket, now);
    this.rollProviderWindows(bucket, now);

    const requestCeiling = bucket.limitRequests ?? bucket.learnedRequests;
    const tokenCeiling = bucket.limitTokens ?? bucket.learnedTokens;
    const requestSends = sendsForAxis(bucket.sends, bucket.requestsWindowStartedAt);
    const tokenSends = sendsForAxis(bucket.sends, bucket.tokensWindowStartedAt);
    // Retry-After applies to the response as a whole, even when that response reported no ceilings.
    if (bucket.retryAt !== undefined && bucket.retryAt > now) return bucket.retryAt - now;
    // Nothing has stated a ceiling and nothing has refused us. Send, and learn from what comes back.
    if (requestCeiling === undefined && tokenCeiling === undefined) return 0;

    // A reading expires by age or once its own reset passes, so a rolled-over limit can't park the run.
    const fresh = (reset: number | undefined) =>
      (reset === undefined || now < reset) && now - bucket.observedAt < SNAPSHOT_TTL_MS;
    const worse = (
      counted: number,
      ceiling: number | undefined,
      remaining: number | undefined,
      reset: number | undefined,
    ) =>
      fresh(reset) && ceiling !== undefined && remaining !== undefined
        ? Math.max(counted, ceiling - remaining)
        : counted;

    const requestsUsed = worse(requestSends.length, requestCeiling, bucket.remainingRequests, bucket.resetRequestsAt);
    const tokensUsed = worse(sumTokens(tokenSends), tokenCeiling, bucket.remainingTokens, bucket.resetTokensAt);

    // A context can outgrow the whole allowance (49k against a 25k ceiling). No wait makes it fit, so it
    // goes on an empty window rather than stalling the run until its deadline.
    const unfittable = tokenCeiling !== undefined && estimate > tokenCeiling;
    const overRequests = requestCeiling !== undefined && requestsUsed >= requestCeiling;
    const overTokens =
      tokenCeiling !== undefined && (unfittable ? tokensUsed > 0 : tokensUsed + estimate > tokenCeiling);
    if (!overRequests && !overTokens) return 0;

    const pressureAt = Math.max(bucket.refusedAt ?? 0, bucket.observedAt);
    const axisWait = (
      reset: number | undefined,
      sends: readonly Send[],
      fits: (sends: readonly Send[]) => boolean,
    ): number => {
      if (reset !== undefined && reset > now) return reset - now;

      // Where our own sends account for the pressure, the ledger knows exactly when a slot frees.
      for (let i = 1; i <= sends.length; i++) {
        if (fits(sends.slice(i))) return Math.max(0, sends[i - 1].at + LEDGER_WINDOW_MS - now);
      }

      // Pressure with no send of ours behind it came from traffic outside this process. Measure the
      // recovery from the evidence rather than from now, or each pass would restart it forever.
      return Math.max(0, pressureAt + bucket.recoveryMs - now);
    };

    const waits: number[] = [];
    if (overRequests && requestCeiling !== undefined) {
      waits.push(axisWait(bucket.resetRequestsAt, requestSends, (sends) => sends.length < requestCeiling));
    }
    if (overTokens && tokenCeiling !== undefined) {
      waits.push(
        axisWait(bucket.resetTokensAt, tokenSends, (sends) =>
          unfittable ? sumTokens(sends) === 0 : sumTokens(sends) + estimate <= tokenCeiling,
        ),
      );
    }
    // Both axes must have room before admission, hence the later of their independent deadlines.
    return Math.max(...waits);
  }

  // Folds a response's headers in. With other calls in flight the reading is stale, so it may only lower
  // the projection; alone, it is adopted outright, which lets the bucket recover.
  settle(key: PacerKey, snapshot: RateLimitSnapshot | null): void {
    if (!snapshot) return;
    const bucket = this.bucketFor(key);
    const now = this.now();
    this.rollProviderWindows(bucket, now);

    if (snapshot.limitRequests !== undefined) bucket.limitRequests = snapshot.limitRequests;
    if (snapshot.limitTokens !== undefined) bucket.limitTokens = snapshot.limitTokens;
    if (snapshot.queryCost !== undefined) bucket.lastCost = snapshot.queryCost;
    if (snapshot.resetRequestsAt !== undefined) bucket.resetRequestsAt = snapshot.resetRequestsAt;
    if (snapshot.resetTokensAt !== undefined) bucket.resetTokensAt = snapshot.resetTokensAt;
    if (snapshot.retryAt !== undefined) bucket.retryAt = snapshot.retryAt;

    // Above one because this call's own reservation is still held; anything more is company.
    const contended = bucket.inFlight > 1;
    const fold = (projected: number | undefined, reported: number | undefined) =>
      contended ? pessimistic(projected, reported) : (reported ?? projected);

    bucket.remainingRequests = fold(bucket.remainingRequests, snapshot.remainingRequests);
    bucket.remainingTokens = fold(bucket.remainingTokens, snapshot.remainingTokens);
    bucket.observedAt = now;
  }

  /** The token usage a call reported, for providers that do not price it in a header. */
  observeUsage(key: PacerKey, tokens: number): void {
    if (tokens > 0) this.bucketFor(key).lastUsage = tokens;
  }

  /** Waits out a backoff on the pacer's clock, so tests can drive retries without real time. */
  wait(ms: number, signal?: AbortSignal): Promise<void> {
    return this.sleep(ms, signal);
  }

  // Records a refusal and returns the wait. For providers that never state a ceiling (streaming
  // Mistral), what the ledger counted becomes the learned ceiling.
  penalize(key: PacerKey, retryAt?: number): number {
    const bucket = this.bucketFor(key);
    const now = this.now();
    this.prune(bucket, now);
    this.rollProviderWindows(bucket, now);
    const requestSends = sendsForAxis(bucket.sends, bucket.requestsWindowStartedAt);
    const tokenSends = sendsForAxis(bucket.sends, bucket.tokensWindowStartedAt);

    // Prefer a Retry-After that pacedFetch already folded in over our guess; no jitter, since waking earlier only
    // earns another refusal.
    if (retryAt !== undefined) bucket.retryAt = retryAt;
    const responseWideRetry = bucket.retryAt !== undefined && bucket.retryAt > now ? bucket.retryAt : undefined;
    const requestExhausted =
      bucket.remainingRequests !== undefined
        ? bucket.remainingRequests <= 0
        : bucket.limitRequests !== undefined && requestSends.length >= bucket.limitRequests;
    const estimate = this.estimate(bucket);
    const tokenExhausted =
      bucket.remainingTokens !== undefined
        ? bucket.remainingTokens < estimate
        : bucket.limitTokens !== undefined && sumTokens(tokenSends) + estimate > bucket.limitTokens;
    const quotaDeadlines = [
      requestExhausted ? bucket.resetRequestsAt : undefined,
      tokenExhausted ? bucket.resetTokensAt : undefined,
    ].filter((deadline): deadline is number => deadline !== undefined && deadline > now);
    const providerResetAt = responseWideRetry ?? (quotaDeadlines.length ? Math.max(...quotaDeadlines) : undefined);

    // Needs two sends: refused after one, the cause was unseen traffic, and learning from it would pin
    // the ceiling at one call per window.
    if (bucket.limitRequests === undefined && requestSends.length > 1) {
      const tooMany = requestSends.length;
      bucket.learnedRequests = Math.max(1, Math.min(bucket.learnedRequests ?? tooMany, tooMany) - 1);
      bucket.cleanSends = 0;
    }

    // Deliberately does not write `remaining`. A fabricated zero would outlive the window it
    // described and keep throttling a bucket the ledger already knows has room.
    bucket.refusedAt = now;
    bucket.recoveryMs = Math.min(MAX_RECOVERY_MS, bucket.recoveryMs * RECOVERY_GROWTH);
    return providerResetAt !== undefined
      ? clampWait(providerResetAt - now)
      : clampWait(jitter(bucket.recoveryMs, this.random));
  }

  // Eases the backoff and, after enough clean sends, probes one more per window, so a ceiling raised by
  // the provider is rediscovered.
  reward(key: PacerKey): void {
    const bucket = this.bucketFor(key);
    bucket.recoveryMs = Math.max(MIN_RECOVERY_MS, bucket.recoveryMs * RECOVERY_DECAY);
    if (bucket.learnedRequests !== undefined && bucket.cleanSends >= CEILING_PROBE_AFTER) {
      bucket.learnedRequests += 1;
      bucket.cleanSends = 0;
    }
  }

  snapshot(key: PacerKey): PacerSnapshot {
    const bucket = this.bucketFor(key);
    this.prune(bucket, this.now());
    return {
      ...key,
      sendsInWindow: bucket.sends.length,
      ...(bucket.learnedRequests === undefined ? {} : { learnedRequests: bucket.learnedRequests }),
      ...(bucket.limitRequests === undefined ? {} : { limitRequests: bucket.limitRequests }),
      ...(bucket.limitTokens === undefined ? {} : { limitTokens: bucket.limitTokens }),
      ...(bucket.remainingRequests === undefined ? {} : { remainingRequests: bucket.remainingRequests }),
      ...(bucket.remainingTokens === undefined ? {} : { remainingTokens: bucket.remainingTokens }),
      recoveryMs: bucket.recoveryMs,
      inFlight: bucket.inFlight,
      queued: bucket.waiters.length,
    };
  }
}

const sumTokens = (sends: readonly Send[]) => sends.reduce((total, send) => total + send.tokens, 0);

// Sends before the provider's last reset no longer count on that axis. Per axis, since request and
// token allowances reset independently.
function sendsForAxis(sends: readonly Send[], windowStartedAt: number | undefined): readonly Send[] {
  if (windowStartedAt === undefined) return sends;
  return sends.filter((send) => send.at >= windowStartedAt);
}

/** The lower of what we projected and what the provider reported; either may be the only one known. */
function pessimistic(projected: number | undefined, reported: number | undefined): number | undefined {
  if (reported === undefined) return projected;
  if (projected === undefined) return reported;
  return Math.min(projected, reported);
}

export const providerPacer = globalSingleton("agentProviderPacer", () => new ProviderPacer());
