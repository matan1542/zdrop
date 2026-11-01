import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import { learnConfig } from "./config.js";

// Background learning only runs when it can't be felt: on AC power, with spare CPU and spare memory.
// ZDROP_TEST_MACHINE=ok|battery|load|memory forces a verdict for tests.

export type MachineVerdict = { ok: true } | { ok: false; reason: string };

const run = (command: string, args: string[]): Promise<string> =>
  new Promise((resolve) => {
    execFile(command, args, { timeout: 2000, env: { PATH: "/usr/sbin:/usr/bin:/bin:/sbin" } }, (error, stdout) => resolve(error ? "" : stdout));
  });

const onBattery = async (): Promise<boolean> => {
  if (process.platform === "darwin") return (await run("/usr/bin/pmset", ["-g", "batt"])).includes("'Battery Power'");
  try {
    const supplies = fs.readdirSync("/sys/class/power_supply");
    const ac = supplies.filter((s) => /^(AC|ADP|ACAD)/i.test(s));
    if (ac.length === 0) return false;
    return ac.every((s) => fs.readFileSync(`/sys/class/power_supply/${s}/online`, "utf8").trim() === "0");
  } catch {
    return false;
  }
};

/** Percentage of memory available (macOS: kernel memory-pressure level; Linux: MemAvailable). */
const memoryAvailablePercent = async (): Promise<number> => {
  if (process.platform === "darwin") {
    const level = Number.parseInt(await run("/usr/sbin/sysctl", ["-n", "kern.memorystatus_level"]), 10);
    return Number.isFinite(level) ? level : 100;
  }
  try {
    const available = /MemAvailable:\s+(\d+)/.exec(fs.readFileSync("/proc/meminfo", "utf8"));
    return available ? (Number(available[1]) * 1024 * 100) / os.totalmem() : 100;
  } catch {
    return 100;
  }
};

export const checkMachine = async (): Promise<MachineVerdict> => {
  const forced = process.env.ZDROP_TEST_MACHINE;
  if (forced === "ok") return { ok: true };
  if (forced) return { ok: false, reason: `forced: ${forced}` };
  const load = os.loadavg()[0] / Math.max(1, os.availableParallelism());
  if (load > learnConfig.maxLoadPerCore) return { ok: false, reason: `load ${load.toFixed(2)} per core` };
  if (await onBattery()) return { ok: false, reason: "on battery" };
  const memory = await memoryAvailablePercent();
  if (memory < learnConfig.minMemoryAvailablePercent) return { ok: false, reason: `memory ${memory.toFixed(0)}% available` };
  return { ok: true };
};
