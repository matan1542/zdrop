// Resource budget for the daemon. Every number here exists to keep memory and process count bounded
// no matter how long the daemon runs or how many shells talk to it.

const envInt = (name: string, fallback: number): number => {
  const value = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

export const limits = {
  /** Estimated retained heap for all loaded specs (source bytes × specHeapFactor). */
  specCacheBytes: envInt("ZDROP_SPEC_CACHE_MB", 24) * 1024 * 1024,
  specHeapFactor: 3,
  /** Total suggestions held across all generator cache entries. */
  generatorCacheSuggestions: envInt("ZDROP_GENERATOR_CACHE_SUGGESTIONS", 50_000),
  /** Suggestions kept from a single generator run. */
  suggestionsPerGenerator: 2_000,
  /** Lifetime of cache entries for generators that declare no `cache` policy. */
  implicitCacheTtlMs: 30_000,
  /** Generator child processes running at once, across all shells. */
  maxConcurrentChildren: 4,
  /** stdout + stderr kept from a generator before it is killed. */
  childOutputBytes: 1024 * 1024,
  /** Grace period after kill before the promise is force-resolved. */
  childKillGraceMs: 500,
  /** RSS above which the daemon exits so it can be restarted fresh. */
  rssLimitBytes: envInt("ZDROP_RSS_LIMIT_MB", 120) * 1024 * 1024,
  rssCheckIntervalMs: envInt("ZDROP_RSS_CHECK_SECONDS", 60) * 1000,
  /** Exit when no shell has been connected for this long (0: never, as when started at login). */
  idleExitMs: envInt("ZDROP_IDLE_MINUTES", 30) * 60_000,
};

type Waiter = () => void;

/** Counting semaphore so generators from every shell share one child-process budget. */
export class Semaphore {
  private active = 0;
  private readonly waiters: Waiter[] = [];

  constructor(private readonly capacity: number) {}

  async acquire(signal?: AbortSignal): Promise<() => void> {
    signal?.throwIfAborted();
    if (this.active < this.capacity) {
      this.active++;
      return this.releaser();
    }
    await new Promise<void>((resolve, reject) => {
      const waiter = () => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      };
      const onAbort = () => {
        const index = this.waiters.indexOf(waiter);
        if (index !== -1) this.waiters.splice(index, 1);
        reject(signal?.reason ?? new DOMException("The operation was aborted", "AbortError"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.waiters.push(waiter);
    });
    // the releasing holder handed its slot straight to us, so `active` is already counted
    return this.releaser();
  }

  get inUse(): number {
    return this.active;
  }

  get queued(): number {
    return this.waiters.length;
  }

  private releaser(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiters.shift();
      if (next) next();
      else this.active--;
    };
  }
}

export const childSlots = new Semaphore(limits.maxConcurrentChildren);

/** Process-group ids of running generator children, so they can be reported and reaped on exit. */
export const liveChildren = new Set<number>();

export const killProcessGroup = (pid: number, signal: NodeJS.Signals = "SIGKILL"): void => {
  try {
    process.kill(-pid, signal);
  } catch {
    // group already gone
  }
};

export const killAllChildren = (): void => {
  for (const pid of liveChildren) killProcessGroup(pid);
  liveChildren.clear();
};
