import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import log from "../../vendor/inshellisense/utils/log.js";
import { killAllChildren, liveChildren } from "../limits.js";
import { SpecLoader } from "../specLoader.js";
import { specDirs } from "../setup.js";
import { CommandIndex } from "./commandIndex.js";
import { learnConfig } from "./config.js";
import { gate } from "./gate.js";
import { readHistory } from "./history.js";
import { checkMachine } from "./machine.js";
import { probeCommand, probeHelp, type ProbeOptions } from "./prober.js";
import { createSandbox } from "./sandbox.js";
import { fileKey, freshness, LearnedStore, newLearnedFile, sameKey } from "./store.js";

// `zdrop learn-batch`: the background builder. Runs as its own short-lived process (small V8 heap,
// nice 19) so nothing it parses ever lives in the daemon, learns at most `batchSize` commands one at a
// time, and exits, which hands all of its memory back to the OS. While the user types, the daemon
// sends SIGUSR2: the worker freezes its running probe (probes are their own process groups) and then
// itself; SIGCONT after a quiet period resumes both. SIGTERM kills the probe before exiting.

export const BatchExit = { Done: 0, More: 2, MachineBusy: 3, BudgetSpent: 4 } as const;
export type BatchExit = (typeof BatchExit)[keyof typeof BatchExit];

type Budget = { day: string; probes: number };

const today = () => new Date().toISOString().slice(0, 10);

const readBudget = (file: string): Budget => {
  try {
    const budget = JSON.parse(fs.readFileSync(file, "utf8")) as Budget;
    return budget.day === today() ? budget : { day: today(), probes: 0 };
  } catch {
    return { day: today(), probes: 0 };
  }
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** User and tool directories are learned before system ones. */
const dirRank = (dir: string): number => {
  const home = os.homedir();
  if (dir.startsWith(home)) return 0;
  if (/^\/(opt\/homebrew|usr\/local|opt|nix|snap)\//.test(dir + "/")) return 1;
  return 2;
};

export const runBatch = async (): Promise<BatchExit> => {
  const shellPath = process.env.ZDROP_LEARN_PATH || process.env.PATH || "/usr/bin:/bin";
  const store = new LearnedStore();
  const figNames = new Set(new SpecLoader(specDirs()).names());
  const index = new CommandIndex(0);
  const rank = await readHistory(process.env.ZDROP_LEARN_HISTFILE);
  const budgetFile = path.join(store.dir, "budget.json");
  const budget = readBudget(budgetFile);

  let lastResume = 0;
  const signalProbes = (signal: NodeJS.Signals) => {
    for (const pid of liveChildren) {
      try {
        process.kill(-pid, signal);
      } catch {
        // finished meanwhile
      }
    }
  };
  process.on("SIGUSR2", () => {
    signalProbes("SIGSTOP");
    process.kill(process.pid, "SIGSTOP");
  });
  process.on("SIGCONT", () => {
    lastResume = Date.now();
    signalProbes("SIGCONT");
  });
  process.on("SIGTERM", () => {
    killAllChildren();
    process.exit(143);
  });
  const sandbox = createSandbox();
  const options = (): ProbeOptions => ({ sandbox, shellPath, background: true, wasPausedSince: (since) => lastResume >= since });

  const names = index.names(shellPath).filter((name) => !figNames.has(name));
  const dirOf = (name: string) => path.dirname(index.resolve(name, shellPath) ?? "/");
  const ordered = names
    .map((name) => ({ name, used: rank.commands.get(name) ?? 0, dir: dirRank(dirOf(name)) }))
    .sort((a, b) => b.used - a.used || a.dir - b.dir || (a.name < b.name ? -1 : 1))
    .map((c) => c.name);

  let learned = 0;
  const spend = async (): Promise<BatchExit | undefined> => {
    learned++;
    budget.probes++;
    fs.writeFileSync(budgetFile, JSON.stringify(budget));
    if (learned >= learnConfig.batchSize) return BatchExit.More;
    if (budget.probes >= learnConfig.dailyBudget) return BatchExit.BudgetSpent;
    if (learned % 10 === 0) {
      const machine = await checkMachine();
      if (!machine.ok) return BatchExit.MachineBusy;
    }
    await sleep(learnConfig.probeGapMs);
    return;
  };

  try {
    if (budget.probes >= learnConfig.dailyBudget) return BatchExit.BudgetSpent;
    const machine = await checkMachine();
    if (!machine.ok) {
      log.debug({ msg: "background learning deferred", reason: machine.reason });
      return BatchExit.MachineBusy;
    }

    for (const name of ordered) {
      const file = index.resolve(name, shellPath);
      if (file == null) continue;
      const key = await fileKey(file);
      if (key == null) continue;
      const previous = await store.read(name);
      if (previous != null) {
        const state = freshness(previous, key);
        if (state === "fresh" || state === "wait") continue;
        // a command that hung once is only retried when typed, unless it changed
        if (previous.status === "timeout" && sameKey(previous.key, key)) continue;
      }
      const decision = await gate(name, file, false);
      if (decision.action === "skip") continue;
      const outcome = await probeCommand(name, file, decision.action, options());
      if (outcome.status === "interrupted") continue;
      await store.write(newLearnedFile(name, key, outcome.source, outcome.status === "ok" ? outcome.node : undefined, outcome.status, previous));
      const exit = await spend();
      if (exit != null) return exit;
    }

    // the subcommands used most in history (`claude mcp`, `yarn workspace`)
    const pairs = [...rank.subcommands].sort((a, b) => b[1] - a[1]).slice(0, 50);
    for (const [pair] of pairs) {
      const [name, sub] = pair.split(" ");
      if (figNames.has(name)) continue;
      const root = await store.read(name);
      if (root == null || root.status !== "ok" || root.source !== "help") continue;
      const child = root.nodes[""]?.subcommands.find((c) => c.names.includes(sub));
      if (child == null || root.nodes[child.names[0]] != null || root.missing[child.names[0]] != null) continue;
      const file = index.resolve(name, shellPath);
      if (file == null) continue;
      const outcome = await probeHelp(file, [name, child.names[0]], options());
      if (outcome.status === "interrupted") continue;
      const current = (await store.read(name)) ?? root;
      if (outcome.status === "ok") current.nodes[child.names[0]] = outcome.node;
      else current.missing[child.names[0]] = Date.now();
      await store.write(current);
      const exit = await spend();
      if (exit != null) return exit;
    }
    return BatchExit.Done;
  } finally {
    sandbox.dispose();
  }
};
