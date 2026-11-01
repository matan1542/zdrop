import path from "node:path";
import { zdropHome } from "../protocol.js";

const envInt = (name: string, fallback: number): number => {
  const value = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
};

/** Budgets and switches for learning commands from `--help` / man pages. */
export const learnConfig = {
  enabled: process.env.ZDROP_LEARN !== "0",
  background: process.env.ZDROP_LEARN !== "0" && process.env.ZDROP_LEARN_BACKGROUND !== "0",
  deny: (process.env.ZDROP_LEARN_DENY ?? "").split(":").filter((n) => n.length > 0),

  storeDir: path.join(zdropHome, "learned"),
  probeHomeRoot: path.join(zdropHome, "probe-home"),
  storeBytes: envInt("ZDROP_LEARN_STORE_MB", 32) * 1024 * 1024,
  fileBytes: 256 * 1024,
  nodesPerCommand: 300,

  interactiveTimeoutMs: 3_000,
  backgroundTimeoutMs: 5_000,
  cpuSeconds: 5,
  outputBytes: 256 * 1024,
  interactiveConcurrency: 2,

  /** misses are retried after these delays (by consecutive failures) unless the binary changes */
  missBackoffMs: [1, 7, 30].map((days) => days * 86_400_000),
  /** a learned spec is re-probed after this long even if the binary did not change */
  refreshMs: 30 * 86_400_000,
  /** how often a cached spec re-checks its binary's identity */
  recheckMs: 15_000,

  prefetchDebounceMs: 300,

  batchSize: envInt("ZDROP_LEARN_BATCH", 100),
  dailyBudget: envInt("ZDROP_LEARN_DAILY", 500),
  workerHeapMb: 32,
  startDelayMs: envInt("ZDROP_LEARN_START_SECONDS", 10) * 1000,
  idleBeforeBatchMs: 30_000,
  resumeAfterMs: 2_000,
  probeGapMs: 200,
  maxLoadPerCore: 0.7,
  minMemoryAvailablePercent: 20,
};
