// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import path from "node:path";
import { spawn } from "node:child_process";
import fsAsync from "node:fs/promises";
import os, { homedir } from "node:os";

import { CommandToken } from "./parser.js";
import { getPathSeparator, Shell } from "../utils/shell.js";
import log from "../utils/log.js";
import { childSlots, killProcessGroup, limits, liveChildren } from "../../../src/limits.js";

type QuoteChar = `"` | `'` | "`";

const isQuoted = (value: string | undefined, quoteChar: QuoteChar): boolean => (value?.startsWith(quoteChar) && value?.endsWith(quoteChar)) ?? false;

const quoteString = (value: string, quoteChar: QuoteChar): string => {
  if (isQuoted(value, quoteChar)) return value;
  const escapedValue = value.replaceAll(`\\${quoteChar}`, quoteChar).replaceAll(quoteChar, `\\${quoteChar}`);
  return `${quoteChar}${escapedValue}${quoteChar}`;
};

const needsQuoted = (value: string, quoteChar: QuoteChar): boolean => isQuoted(value, quoteChar) || value.includes(" ");

const getShellQuoteChar = (shell: Shell): QuoteChar => {
  switch (shell) {
    case Shell.Zsh:
    case Shell.Bash:
    case Shell.Fish:
      return `"`;
    case Shell.Xonsh:
      return `'`;
    case Shell.Nushell:
      return "`";
    case Shell.Pwsh:
    case Shell.Powershell:
      return `'`;
    case Shell.Cmd:
      return `"`;
  }
};

export const getShellWhitespaceEscapeChar = (shell: Shell): string => {
  switch (shell) {
    case Shell.Zsh:
    case Shell.Bash:
    case Shell.Fish:
    case Shell.Xonsh:
    case Shell.Nushell:
      return "\\";
    case Shell.Pwsh:
    case Shell.Powershell:
      return "`";
    case Shell.Cmd:
      return "^";
  }
};

export const escapePath = (value: string | undefined, shell: Shell): string | undefined =>
  value != null && needsQuoted(value, getShellQuoteChar(shell)) ? quoteString(value, getShellQuoteChar(shell)) : value;

// zdrop: generators run in their own process group so abort/timeout kills pipelines (`a | b`) too,
// output is capped, and the promise settles on `exit` plus a hard deadline instead of `close`
// (a surviving grandchild holding the pipe open would otherwise keep it pending forever).
// All generators share one concurrency budget across every connected shell.
export const buildExecuteShellCommand =
  (timeout: number, signal?: AbortSignal): Fig.ExecuteCommandFunction =>
  async ({ command, env, args, cwd }: Fig.ExecuteCommandInput): Promise<Fig.ExecuteCommandOutput> => {
    signal?.throwIfAborted();
    const release = await childSlots.acquire(signal);
    try {
      return await runProcess(command, args, { cwd, env: { ...process.env, ...env, ISTERM: "1", ZDROP: "1" }, timeout, signal });
    } finally {
      release();
    }
  };

export type RunOptions = {
  cwd?: string;
  /** the complete environment of the child (nothing is inherited) */
  env: Record<string, string | undefined>;
  timeout: number;
  signal?: AbortSignal;
  /** stdout + stderr bytes kept before the child is killed (default limits.childOutputBytes) */
  outputBytes?: number;
  /** nice value applied right after spawn (inherited by the child's own children) */
  priority?: number;
};

export type RunResult = Fig.ExecuteCommandOutput & { timedOut: boolean; truncated: boolean };

// zdrop: shared by generators and by `--help` probes (src/learn/prober.ts).
export const runProcess = (command: string, args: string[], options: RunOptions): Promise<RunResult> =>
  new Promise((resolve, reject) => {
    const { cwd, env, timeout, signal } = options;
    const outputLimit = options.outputBytes ?? limits.childOutputBytes;
    const child = spawn(command, args, {
      cwd,
      env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const pid = child.pid;
    if (pid != null) liveChildren.add(pid);
    if (pid != null && options.priority != null) {
      try {
        os.setPriority(pid, options.priority);
      } catch {
        // already exited
      }
    }
    let timedOut = false;
    let truncated = false;

    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    let settled = false;
    let exitCode: number | null = null;
    let deadline: NodeJS.Timeout | undefined;

    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      clearTimeout(deadline);
      signal?.removeEventListener("abort", onAbort);
      if (pid != null) {
        killProcessGroup(pid);
        liveChildren.delete(pid);
      }
      child.stdout?.destroy();
      child.stderr?.destroy();
      if (error != null) reject(error);
      else resolve({ status: exitCode ?? 0, stdout, stderr, timedOut, truncated });
    };

    const kill = (reason: string) => {
      log.debug({ msg: "killing generator", reason, command, args });
      if (pid != null) killProcessGroup(pid);
      deadline ??= setTimeout(() => finish(), limits.childKillGraceMs);
    };

    const onData = (target: "stdout" | "stderr") => (data: Buffer) => {
      outputBytes += data.length;
      if (outputBytes > outputLimit) {
        truncated = true;
        kill("output limit");
        return;
      }
      if (target === "stdout") stdout += data;
      else stderr += data;
    };

    const onAbort = () => {
      kill("aborted");
      finish(signal?.reason ?? new DOMException("The operation was aborted", "AbortError"));
    };

    const killTimer = setTimeout(() => {
      timedOut = true;
      kill("timeout");
    }, timeout);
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout?.on("data", onData("stdout"));
    child.stderr?.on("data", onData("stderr"));
    child.on("error", (err) => {
      log.debug({ msg: "shell command failed", command, args, e: err.message });
      finish();
    });
    child.on("exit", (code) => {
      exitCode = code;
      // give the pipes a moment to drain, but never wait on grandchildren holding them open
      deadline ??= setTimeout(() => finish(), 50);
    });
    child.on("close", () => finish());
  });

const isHomedir = (path: string) => path.startsWith("~");

export const resolveCwd = async (
  cmdToken: CommandToken | undefined,
  cwd: string,
  shell: Shell,
  signal?: AbortSignal,
): Promise<{ cwd: string; pathy: boolean; complete: boolean }> => {
  if (cmdToken == null || cmdToken.complete) return { cwd, pathy: false, complete: false };
  const { token: rawToken, isQuoted } = cmdToken;
  const sep = getPathSeparator(shell);
  const escapedToken = !isQuoted ? rawToken.replaceAll(" ", "\\ ") : rawToken;
  if (escapedToken === "~") return { cwd: homedir(), pathy: true, complete: false };
  if (escapedToken === `~${sep}`) return { cwd: homedir(), pathy: true, complete: true };
  if (!escapedToken.includes(sep)) return { cwd, pathy: false, complete: false };
  const tokenComplete = escapedToken.endsWith(sep);
  const trimmedToken = escapedToken.endsWith(sep) ? escapedToken : path.dirname(escapedToken);
  const token = trimmedToken;
  const resolvedCwd = path.isAbsolute(token) ? token : isHomedir(token) ? token.replace("~", homedir()) : path.join(cwd, token);
  try {
    signal?.throwIfAborted();
    await fsAsync.access(resolvedCwd, fsAsync.constants.R_OK);
    return { cwd: resolvedCwd, pathy: true, complete: tokenComplete };
  } catch {
    // fallback to the parent folder if possible
    const baselessCwd = resolvedCwd.substring(0, resolvedCwd.length - path.basename(resolvedCwd).length);
    try {
      signal?.throwIfAborted();
      await fsAsync.access(baselessCwd, fsAsync.constants.R_OK);
      return { cwd: baselessCwd, pathy: true, complete: tokenComplete };
    } catch {
      /*empty*/
    }
    return { cwd, pathy: false, complete: false };
  }
};
