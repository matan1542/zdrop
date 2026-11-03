import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { learnConfig } from "../src/learn/config.js";
import { readHistory } from "../src/learn/history.js";
import { sandboxAvailable } from "../src/learn/sandbox.js";
import { LearnedStore } from "../src/learn/store.js";
import { BatchExit, runBatch } from "../src/learn/worker.js";
import { fakeCli, invocations, tempDir } from "./helpers.js";

const bin = tempDir("worker-bin");
const help = (name: string) => `Usage: ${name} [options] [command]

Options:
  -q, --quiet   Less output
  -h, --help    Show help

Commands:
  run    Run it
  stop   Stop it`;

const clis = ["alpha", "beta", "gamma", "delta"].map((name) => fakeCli(bin, name, help(name), { run: help(`${name} run`) }));
const history = path.join(bin, "history");

beforeAll(() => {
  fs.writeFileSync(history, ": 1700000000:0;delta run --quiet\n: 1700000001:0;delta stop\ndelta run\ngamma\n");
  process.env.ZDROP_LEARN_PATH = bin;
  process.env.ZDROP_LEARN_HISTFILE = history;
  process.env.ZDROP_TEST_MACHINE = "ok";
  learnConfig.probeGapMs = 0;
});

afterEach(() => {
  process.env.ZDROP_TEST_MACHINE = "ok";
});

describe("background learning (learn-batch)", () => {
  it("does nothing when the machine is busy", async () => {
    process.env.ZDROP_TEST_MACHINE = "battery";
    expect(await runBatch()).toBe(BatchExit.MachineBusy);
    expect(clis.flatMap(invocations)).toEqual([]);
  });

  // background probes run only in a sandbox
  it.runIf(sandboxAvailable())("learns in batches, most-used commands first", async () => {
    learnConfig.batchSize = 2;
    expect(await runBatch()).toBe(BatchExit.More);
    // delta and gamma are in the history, so they go first
    expect(invocations(clis[3])).toEqual(["--help"]);
    expect(invocations(clis[2])).toEqual(["--help"]);
    expect(invocations(clis[0])).toEqual([]);
  });

  it.runIf(sandboxAvailable())("finishes the rest, then the history's favourite subcommand", async () => {
    learnConfig.batchSize = 100;
    expect(await runBatch()).toBe(BatchExit.Done);
    expect(clis.map((c) => invocations(c)[0])).toEqual(["--help", "--help", "--help", "--help"]);
    expect(invocations(clis[3])).toContain("run --help");
    const delta = await new LearnedStore().read("delta");
    expect(Object.keys(delta!.nodes)).toEqual(["", "run", "stop"]);
  });

  it.runIf(sandboxAvailable())("probes nothing on a restart when nothing changed", async () => {
    const before = clis.flatMap(invocations).length;
    expect(await runBatch()).toBe(BatchExit.Done);
    expect(clis.flatMap(invocations)).toHaveLength(before);
  });

  it.runIf(sandboxAvailable())("stops at the daily budget", async () => {
    fs.appendFileSync(clis[0], "# changed\n");
    fs.utimesSync(clis[0], new Date(), new Date(Date.now() + 5000));
    const store = new LearnedStore();
    fs.writeFileSync(path.join(store.dir, "budget.json"), JSON.stringify({ day: new Date().toISOString().slice(0, 10), probes: learnConfig.dailyBudget }));
    expect(await runBatch()).toBe(BatchExit.BudgetSpent);
    expect(invocations(clis[0])).toHaveLength(1);
  });

  it("ranks history by command and subcommand", async () => {
    const rank = await readHistory(history);
    expect(rank.commands.get("delta")).toBe(3);
    expect(rank.subcommands.get("delta run")).toBe(2);
  });
});
