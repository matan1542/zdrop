import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { buildExecuteShellCommand } from "../vendor/inshellisense/runtime/utils.js";
import { getGeneratorSuggestions, getGeneratorCacheStats, clearGeneratorState } from "../vendor/inshellisense/runtime/generatorCache.js";
import { limits, liveChildren } from "../src/limits.js";

const run = (script: string, timeout = 5000, signal?: AbortSignal) =>
  buildExecuteShellCommand(timeout, signal)({ command: "sh", args: ["-c", script], cwd: process.cwd() });

// a unique sleep duration lets pgrep find exactly the processes a test started
const marker = () => `${Math.floor(Math.random() * 900) + 100}.${Math.floor(Math.random() * 900) + 100}`;
const running = (pattern: string): number => {
  try {
    return execFileSync("pgrep", ["-f", pattern]).toString().trim().split("\n").filter(Boolean).length;
  } catch {
    return 0;
  }
};
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("generator child processes", () => {
  it("kills a generator whose output passes the cap", async () => {
    const started = Date.now();
    const result = await run("yes zdrop | head -c 52428800");
    expect(result.stdout.length).toBeLessThanOrEqual(limits.childOutputBytes);
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it("kills the whole pipeline on abort, leaving no processes behind", async () => {
    const tag = marker();
    const controller = new AbortController();
    const pending = run(`sleep ${tag} | cat`, 30_000, controller.signal);
    await wait(300);
    expect(running(`sleep ${tag}`)).toBeGreaterThan(0);
    controller.abort();
    await expect(pending).rejects.toThrow();
    await wait(200);
    expect(running(`sleep ${tag}`)).toBe(0);
    expect(liveChildren.size).toBe(0);
  });

  it("settles on timeout even when a grandchild holds the pipe open", async () => {
    const tag = marker();
    const started = Date.now();
    await run(`(sleep ${tag} &) ; sleep ${tag}`, 300);
    expect(Date.now() - started).toBeLessThan(300 + limits.childKillGraceMs + 500);
    await wait(200);
    expect(running(`sleep ${tag}`)).toBe(0);
  });

  it("runs at most maxConcurrentChildren at once", async () => {
    let peak = 0;
    const sampler = setInterval(() => (peak = Math.max(peak, liveChildren.size)), 10);
    await Promise.all(Array.from({ length: 6 }, () => run("sleep 0.3")));
    clearInterval(sampler);
    expect(peak).toBeGreaterThan(0);
    expect(peak).toBeLessThanOrEqual(limits.maxConcurrentChildren);
  });
});

describe("generator cache", () => {
  it("caps suggestions per generator", async () => {
    clearGeneratorState();
    const generator: Fig.Generator = { custom: async () => Array.from({ length: 3000 }, (_, i) => ({ name: `s${i}` })) };
    const suggestions = await getGeneratorSuggestions(generator, ["x", ""], "", "/", false);
    expect(suggestions.length).toBe(limits.suggestionsPerGenerator);
  });

  it("keeps the total number of cached suggestions within budget", async () => {
    clearGeneratorState();
    const budget = limits.generatorCacheSuggestions;
    limits.generatorCacheSuggestions = 3000;
    try {
      const generator: Fig.Generator = { custom: async () => Array.from({ length: 1000 }, (_, i) => ({ name: `s${i}` })) };
      for (let dir = 0; dir < 10; dir++) await getGeneratorSuggestions(generator, ["x", ""], "", `/dir${dir}`, false);
      expect(getGeneratorCacheStats().suggestions).toBeLessThanOrEqual(3000);
    } finally {
      limits.generatorCacheSuggestions = budget;
    }
  });
});
