#!/usr/bin/env node
// Soak test: N simulated shells type commands character by character against a real daemon
// (started with the production V8 flags in an isolated ZDROP_HOME), while RSS is sampled.
// Reports latency to the first reply, RSS over time, and child processes left behind.
//
//   node scripts/soak.mjs [--shells 5] [--keystrokes 50000] [--cwd <dir>] [--rss-limit-mb 120]

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
const shells = Number(arg("shells", 5));
const keystrokes = Number(arg("keystrokes", 50_000));
const cwd = arg("cwd", process.cwd());
const rssLimitMb = arg("rss-limit-mb", "120");

const corpus = [
  "git checkout ", "git commit -m ", "git log --oneline ", "git rebase -i ", "git push origin ",
  "yarn ", "yarn build", "yarn add -D ", "yarn workspace ", "npm run ", "npx ",
  "cd ", "cd src/", "ls -la ", "cat package.json", "docker run --rm -it ", "docker compose up ",
  "kubectl get pods -n ", "brew install ", "gh pr checkout ", "cargo build --release",
  "terraform plan -var ", "pnpm --filter ", "ssh ", "kill -9 ", "make ", "node --inspect ",
];

const home = fs.mkdtempSync(path.join(os.tmpdir(), "zdrop-soak-"));
const env = { ...process.env, ZDROP_HOME: home, ZDROP_RSS_LIMIT_MB: rssLimitMb };
const socketPath = path.join(home, "zdrop.sock");
const flags = ["--max-semi-space-size=1", "--optimize-for-size", "--max-old-space-size=96"];
let daemon = spawn(process.execPath, [...flags, path.join(root, "dist/src/cli.js"), "serve"], { env, stdio: "ignore" });
let restarts = 0;

const waitForSocket = async () => {
  for (let i = 0; i < 100; i++) {
    if (fs.existsSync(socketPath)) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("daemon did not start");
};
await waitForSocket();

const rssOf = (pid) => {
  try {
    return Number(execFileSync("ps", ["-o", "rss=", "-p", String(pid)]).toString().trim()) / 1024;
  } catch {
    return 0;
  }
};
const childrenOf = (pid) => {
  try {
    return execFileSync("pgrep", ["-P", String(pid)]).toString().trim().split("\n").filter(Boolean).length;
  } catch {
    return 0;
  }
};

const samples = [];
const latencies = [];
let sent = 0;
const started = Date.now();
const sampler = setInterval(() => samples.push({ t: (Date.now() - started) / 1000, rssMB: rssOf(daemon.pid), children: childrenOf(daemon.pid) }), 2000);

// the daemon exits on its own when over the RSS limit; restart it like the plugin would
daemon.on("exit", function onExit() {
  if (sent >= keystrokes) return;
  restarts++;
  daemon = spawn(process.execPath, [...flags, path.join(root, "dist/src/cli.js"), "serve"], { env, stdio: "ignore" });
  daemon.on("exit", onExit);
});

const shell = async (id) => {
  let socket;
  let seq = 0;
  const pending = new Map();
  const connect = async () => {
    await waitForSocket();
    socket = net.connect(socketPath);
    socket.setEncoding("utf8");
    let buffered = "";
    socket.on("data", (chunk) => {
      buffered += chunk;
      let nl;
      while ((nl = buffered.indexOf("\n")) !== -1) {
        const line = buffered.slice(0, nl);
        buffered = buffered.slice(nl + 1);
        if (line[0] !== "R") continue;
        const replySeq = Number(line.split("\x1f")[1]);
        const resolve = pending.get(replySeq);
        if (resolve) {
          pending.delete(replySeq);
          resolve();
        }
      }
    });
    socket.on("error", () => {});
    await new Promise((resolve) => socket.once("connect", resolve));
  };
  await connect();
  while (sent < keystrokes) {
    const command = corpus[Math.floor(Math.random() * corpus.length)];
    for (let i = 1; i <= command.length && sent < keystrokes; i++) {
      sent++;
      const mySeq = ++seq;
      const t0 = performance.now();
      const reply = new Promise((resolve) => {
        pending.set(mySeq, resolve);
        setTimeout(resolve, 2000); // a reply superseded by the next keystroke may never come
      });
      if (socket.destroyed) await connect();
      socket.write(`Q\x1f${mySeq}\x1f${cwd}\x1f${command.slice(0, i)}\n`);
      await reply;
      latencies.push(performance.now() - t0);
      await new Promise((r) => setTimeout(r, Math.random() * 15)); // typing cadence
    }
    socket.write("N\n");
  }
  socket.end();
};

await Promise.all(Array.from({ length: shells }, (_, i) => shell(i)));
clearInterval(sampler);
samples.push({ t: (Date.now() - started) / 1000, rssMB: rssOf(daemon.pid), children: childrenOf(daemon.pid) });

const sorted = [...latencies].sort((a, b) => a - b);
const pct = (p) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))].toFixed(1);
const status = await new Promise((resolve) => {
  const s = net.connect(socketPath);
  s.setEncoding("utf8");
  s.once("connect", () => s.write("S\n"));
  s.once("data", (d) => {
    s.destroy();
    resolve(JSON.parse(d.split("\n")[0]));
  });
  s.once("error", () => resolve(null));
});
await new Promise((r) => setTimeout(r, 1000));
const leftover = childrenOf(daemon.pid);
daemon.kill("SIGTERM");

console.log(
  JSON.stringify(
    {
      keystrokes: sent,
      shells,
      seconds: (Date.now() - started) / 1000,
      latencyMs: { p50: pct(50), p95: pct(95), p99: pct(99), max: sorted.at(-1).toFixed(1) },
      rssMB: { first: samples[0]?.rssMB, peak: Math.max(...samples.map((s) => s.rssMB)), last: samples.at(-1)?.rssMB },
      rssTimeline: samples.filter((_, i) => i % Math.max(1, Math.floor(samples.length / 12)) === 0).map((s) => `${s.t.toFixed(0)}s:${s.rssMB.toFixed(0)}MB`),
      maxChildrenSeen: Math.max(...samples.map((s) => s.children)),
      childrenLeftAfterIdle: leftover,
      restarts,
      daemonStatus: status && { specs: status.specs.loaded.length, specMB: (status.specs.totalBytes / 1048576).toFixed(1), generatorCache: status.generatorCache },
    },
    null,
    2,
  ),
);
fs.rmSync(home, { recursive: true, force: true });
