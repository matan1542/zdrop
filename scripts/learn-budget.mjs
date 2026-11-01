#!/usr/bin/env node
// Resource-budget check for background learning: runs a real daemon (production V8 flags, isolated
// ZDROP_HOME) that learns from the full PATH, simulates bursts of typing, and samples RSS / process
// state of the daemon, the learn-batch worker and its probe children every 250 ms.
//
//   node scripts/learn-budget.mjs [--batch 40] [--seconds 60]
// Exits non-zero if a budget is exceeded.

import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
};
const batch = arg("batch", "40");
const seconds = Number(arg("seconds", 60));
const budget = { daemonIdleMB: 65, daemonBusyMB: 90, workerMB: 64, backgroundProbes: 1 };

const home = fs.mkdtempSync(path.join(os.tmpdir(), "zdrop-budget-"));
const socketPath = path.join(home, "zdrop.sock");
const flags = ["--max-semi-space-size=1", "--optimize-for-size", "--max-old-space-size=96"];
const startDaemon = (extraEnv) =>
  spawn(process.execPath, [...flags, path.join(root, "dist/src/cli.js"), "serve"], {
    env: { ...process.env, ZDROP_HOME: home, ZDROP_LEARN_START_SECONDS: "1", ZDROP_LEARN_BATCH: batch, ...extraEnv },
    stdio: "ignore",
  });

const waitForSocket = async () => {
  for (let i = 0; i < 100; i++) {
    if (fs.existsSync(socketPath)) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("daemon did not start");
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ps = (args) => {
  try {
    return execFileSync("ps", args, { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
};
const rssMB = (pid) => Number(ps(["-o", "rss=", "-p", String(pid)]) || 0) / 1024;
const children = (pid) => {
  try {
    return execFileSync("pgrep", ["-P", String(pid)], { encoding: "utf8" }).trim().split("\n").filter(Boolean).map(Number);
  } catch {
    return [];
  }
};
const descendants = (pid) => children(pid).flatMap((c) => [c, ...descendants(c)]);

const connect = async () => {
  const socket = net.connect(socketPath);
  socket.setEncoding("utf8");
  await new Promise((resolve) => socket.once("connect", resolve));
  return socket;
};
const status = async () => {
  const socket = await connect();
  socket.write("S\n");
  const text = await new Promise((resolve) => socket.once("data", resolve));
  socket.destroy();
  return JSON.parse(text.split("\n")[0]);
};

const failures = [];
const expect = (ok, message) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${message}`);
  if (!ok) failures.push(message);
};

// 1. a busy machine never starts a worker
{
  const daemon = startDaemon({ ZDROP_TEST_MACHINE: "battery" });
  await waitForSocket();
  const shell = await connect();
  shell.write(`E\x1f${process.env.PATH}\x1f${process.env.HISTFILE ?? path.join(os.homedir(), ".zsh_history")}\n`);
  await sleep(2500);
  const s = await status();
  expect(s.learn.background.workerPid == null && s.learn.background.state === "deferred", `busy machine: no worker (${s.learn.background.state}: ${s.learn.background.deferredReason})`);
  shell.destroy();
  daemon.kill("SIGTERM");
  await sleep(500);
}

// 2. learning in the background while the user types now and then
const daemon = startDaemon({ ZDROP_TEST_MACHINE: "ok" });
await waitForSocket();
await sleep(500);
const daemonIdleBefore = rssMB(daemon.pid);
const shell = await connect();
shell.write(`E\x1f${process.env.PATH}\x1f${process.env.HISTFILE ?? path.join(os.homedir(), ".zsh_history")}\n`);

let workerPeak = 0;
let daemonPeak = 0;
let maxProbes = 0;
let probesWhileTyping = 0;
let stoppedSamples = 0;
let typingSamples = 0;
let typing = false;
let sawWorker = false;
const latencies = [];

const sampler = setInterval(async () => {
  daemonPeak = Math.max(daemonPeak, rssMB(daemon.pid));
  const kids = children(daemon.pid);
  for (const worker of kids) {
    const command = ps(["-o", "command=", "-p", String(worker)]);
    if (!command.includes("learn-batch")) continue;
    sawWorker = true;
    workerPeak = Math.max(workerPeak, rssMB(worker));
    const probes = descendants(worker).length;
    maxProbes = Math.max(maxProbes, probes > 0 ? 1 : 0, children(worker).length);
    if (typing) {
      typingSamples++;
      const state = ps(["-o", "stat=", "-p", String(worker)]);
      if (state.startsWith("T")) stoppedSamples++;
      // a probe already running when typing started is frozen with the worker (state T), not new work
      for (const p of descendants(worker)) if (!ps(["-o", "stat=", "-p", String(p)]).startsWith("T")) probesWhileTyping++;
    }
  }
}, 250);

const words = ["claude ", "codex ", "git checkout ", "yarn ", "cd ", "opencode ", "kubectl get "];
const typeBurst = async (ms) => {
  typing = true;
  const until = Date.now() + ms;
  let seq = 0;
  while (Date.now() < until) {
    const word = words[seq % words.length];
    for (let i = 1; i <= word.length && Date.now() < until; i++) {
      const t0 = performance.now();
      const mySeq = ++seq;
      shell.write(`Q\x1f${mySeq}\x1f${os.homedir()}\x1f${word.slice(0, i)}\n`);
      await new Promise((resolve) => {
        const onData = (d) => {
          if (d.includes(`R\x1f${mySeq}\x1f`)) {
            shell.off("data", onData);
            resolve();
          }
        };
        shell.on("data", onData);
        setTimeout(resolve, 1000);
      });
      latencies.push(performance.now() - t0);
      await sleep(60);
    }
  }
  typing = false;
};

const started = Date.now();
await sleep(3000); // the worker starts ~1s after the daemon
while (Date.now() - started < seconds * 1000) {
  await sleep(4000);
  await typeBurst(3000);
  const s = await status();
  if (s.learn.background.state === "done" || (s.learn.background.workerPid == null && s.learn.background.batches > 0 && s.learn.background.state !== "running")) break;
}
clearInterval(sampler);
const final = await status();
await sleep(1500);
const daemonIdleAfter = rssMB(daemon.pid);
const leftovers = descendants(daemon.pid).filter((p) => !ps(["-o", "command=", "-p", String(p)]).includes("learn-batch"));
shell.destroy();
daemon.kill("SIGTERM");

const sorted = [...latencies].sort((a, b) => a - b);
const p95 = sorted.length ? sorted[Math.floor(sorted.length * 0.95)] : 0;
console.log(
  JSON.stringify(
    {
      learned: final.learn.learned,
      background: final.learn.background,
      daemonRssMB: { idleBefore: +daemonIdleBefore.toFixed(1), peak: +daemonPeak.toFixed(1), idleAfter: +daemonIdleAfter.toFixed(1) },
      workerPeakRssMB: +workerPeak.toFixed(1),
      maxBackgroundProbes: maxProbes,
      typingSamples,
      workerStoppedWhileTyping: stoppedSamples,
      queryLatencyMs: { n: latencies.length, p95: +p95.toFixed(1) },
    },
    null,
    2,
  ),
);
expect(sawWorker, "the background worker ran");
expect(daemonIdleAfter <= budget.daemonIdleMB, `daemon idle RSS ${daemonIdleAfter.toFixed(1)} MB ≤ ${budget.daemonIdleMB} MB`);
expect(daemonPeak <= budget.daemonBusyMB, `daemon peak RSS ${daemonPeak.toFixed(1)} MB ≤ ${budget.daemonBusyMB} MB`);
expect(workerPeak <= budget.workerMB, `worker peak RSS ${workerPeak.toFixed(1)} MB ≤ ${budget.workerMB} MB`);
expect(maxProbes <= budget.backgroundProbes, `at most ${budget.backgroundProbes} background probe at a time (saw ${maxProbes})`);
expect(probesWhileTyping === 0, `no background probe runs while typing (${probesWhileTyping} running samples)`);
expect(typingSamples === 0 || stoppedSamples >= typingSamples * 0.8, `worker frozen while typing (${stoppedSamples}/${typingSamples} samples)`);
expect(p95 < 50, `query latency p95 ${p95.toFixed(1)} ms < 50 ms during background learning`);
expect(leftovers.length === 0, "no probe processes left behind");
fs.rmSync(home, { recursive: true, force: true });
process.exit(failures.length === 0 ? 0 : 1);
