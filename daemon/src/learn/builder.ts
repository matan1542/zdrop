import { spawn, type ChildProcess } from "node:child_process";
import os from "node:os";
import { fileURLToPath } from "node:url";
import log from "../../vendor/inshellisense/utils/log.js";
import { learnConfig } from "./config.js";
import type { ShellEnv } from "./context.js";
import { checkMachine } from "./machine.js";
import { BatchExit } from "./worker.js";

// Supervises the background worker (worker.ts) from the daemon: starts a batch only when the user is
// idle and the machine has headroom, freezes it (SIGUSR2: the worker stops its probe, then itself) the
// moment a keystroke arrives, resumes it (SIGCONT) after a quiet period, and schedules the next batch.
// The daemon never parses help text itself here.

const cliPath = fileURLToPath(new URL("../cli.js", import.meta.url));
const minute = 60_000;

export type BuilderState = "waiting" | "running" | "paused" | "deferred" | "done" | "off";

export class BackgroundBuilder {
  private env?: ShellEnv;
  private worker?: ChildProcess;
  private paused = false;
  private resumeTimer?: NodeJS.Timeout;
  private nextTimer?: NodeJS.Timeout;
  private lastQuery = 0;
  private state: BuilderState = learnConfig.background ? "waiting" : "off";
  private batches = 0;
  private lastExit?: number | string;
  private deferredReason?: string;

  /** @param onBatchDone called after each batch so the daemon can pick up what was learned */
  constructor(private readonly onBatchDone: () => void) {}

  start() {
    if (!learnConfig.background) return;
    this.schedule(learnConfig.startDelayMs);
  }

  /** The most recent shell environment (PATH, HISTFILE) to learn from. */
  setEnv(env: ShellEnv) {
    const changed = this.env?.path !== env.path;
    this.env = env;
    if (changed && this.state === "done") {
      this.state = "waiting";
      this.schedule(learnConfig.idleBeforeBatchMs);
    }
  }

  /** A keystroke arrived: freeze the worker now, resume it after a quiet period. */
  onQuery() {
    this.lastQuery = Date.now();
    const pid = this.worker?.pid;
    if (pid == null) return;
    if (!this.paused) {
      try {
        process.kill(pid, "SIGUSR2");
      } catch {
        // exited
      }
      this.paused = true;
      this.state = "paused";
    }
    clearTimeout(this.resumeTimer);
    this.resumeTimer = setTimeout(() => {
      if (this.worker?.pid == null) return;
      this.signal(this.worker.pid, "SIGCONT");
      this.paused = false;
      this.state = "running";
    }, learnConfig.resumeAfterMs);
    this.resumeTimer.unref();
  }

  stop() {
    clearTimeout(this.nextTimer);
    clearTimeout(this.resumeTimer);
    const pid = this.worker?.pid;
    if (pid != null) {
      // resume it so it can handle SIGTERM: it kills its probe, which lives in its own process group
      this.signal(pid, "SIGCONT");
      this.signal(pid, "SIGTERM");
    }
    this.worker = undefined;
  }

  stats() {
    return {
      state: this.state,
      batches: this.batches,
      workerPid: this.worker?.pid,
      lastExit: this.lastExit,
      deferredReason: this.state === "deferred" ? this.deferredReason : undefined,
    };
  }

  private signal(pid: number, signal: NodeJS.Signals) {
    try {
      process.kill(-pid, signal);
    } catch {
      // already gone
    }
  }

  private schedule(ms: number) {
    clearTimeout(this.nextTimer);
    this.nextTimer = setTimeout(() => void this.maybeRun(), ms);
    this.nextTimer.unref();
  }

  private async maybeRun() {
    if (this.worker != null || !learnConfig.background) return;
    if (this.env == null) return this.schedule(minute);
    const idleFor = Date.now() - this.lastQuery;
    if (this.batches > 0 && idleFor < learnConfig.idleBeforeBatchMs) return this.schedule(learnConfig.idleBeforeBatchMs - idleFor);
    const machine = await checkMachine();
    if (!machine.ok) {
      this.state = "deferred";
      this.deferredReason = machine.reason;
      return this.schedule(5 * minute);
    }
    this.spawnWorker(this.env);
  }

  private spawnWorker(env: ShellEnv) {
    const worker = spawn(
      process.execPath,
      // lite mode (no optimizing JIT): the worker waits on child processes, and it saves ~10 MB
      ["--max-semi-space-size=1", "--optimize-for-size", "--lite-mode", `--max-old-space-size=${learnConfig.workerHeapMb}`, cliPath, "learn-batch"],
      {
        detached: true,
        stdio: "ignore",
        env: { ...process.env, ZDROP_LEARN_PATH: env.path, ZDROP_LEARN_HISTFILE: env.histfile ?? "" },
      },
    );
    this.worker = worker;
    this.paused = false;
    this.state = "running";
    this.batches++;
    if (worker.pid != null) {
      try {
        os.setPriority(worker.pid, 19);
      } catch {
        // exited already
      }
    }
    worker.once("exit", (code, signal) => {
      if (this.worker !== worker) return;
      this.worker = undefined;
      clearTimeout(this.resumeTimer);
      this.lastExit = code ?? signal ?? undefined;
      log.debug({ msg: "learn batch finished", code, signal });
      this.onBatchDone();
      switch (code) {
        case BatchExit.Done:
          this.state = "done";
          this.schedule(6 * 60 * minute); // pick up newly installed tools later
          break;
        case BatchExit.More:
          this.state = "waiting";
          this.schedule(learnConfig.idleBeforeBatchMs);
          break;
        case BatchExit.MachineBusy:
          this.state = "deferred";
          this.deferredReason = "machine busy";
          this.schedule(5 * minute);
          break;
        case BatchExit.BudgetSpent:
          this.state = "deferred";
          this.deferredReason = "daily budget spent";
          this.schedule(60 * minute);
          break;
        default:
          this.state = "deferred";
          this.deferredReason = `worker exited (${code ?? signal})`;
          this.schedule(10 * minute);
      }
    });
    worker.once("error", () => undefined);
  }
}
