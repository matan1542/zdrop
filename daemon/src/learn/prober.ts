import { runProcess } from "../../vendor/inshellisense/runtime/utils.js";
import log from "../../vendor/inshellisense/utils/log.js";
import { learnConfig } from "./config.js";
import { looksLikeHelp, parseHelp, type HelpNode } from "./helpParser.js";
import type { Sandbox } from "./sandbox.js";

export type ProbeOutcome =
  | { status: "ok"; source: "help" | "man"; node: HelpNode; ms: number }
  | { status: "miss" | "timeout" | "interrupted"; source: "help" | "man"; ms: number };

export type ProbeOptions = {
  sandbox: Sandbox;
  shellPath: string;
  background: boolean;
  signal?: AbortSignal;
  /** set by the background worker: true if the process was stopped (SIGSTOP) since `since` */
  wasPausedSince?: (since: number) => boolean;
};

const run = async (argv: string[], options: ProbeOptions, sandboxed: boolean) => {
  const [command, ...args] = sandboxed ? options.sandbox.wrap(argv) : argv;
  return runProcess(command, args, {
    cwd: options.sandbox.home,
    env: options.sandbox.env(options.shellPath),
    timeout: options.background ? learnConfig.backgroundTimeoutMs : learnConfig.interactiveTimeoutMs,
    signal: options.signal,
    outputBytes: learnConfig.outputBytes,
    priority: options.background ? 19 : undefined,
  });
};

/**
 * Runs `<file> [words…] --help` in the sandbox and parses it. Falls back to `-h` for the root and to
 * `<file> help <words…>` for subcommands. Help printed on stderr or with a failing exit code counts.
 */
export const probeHelp = async (file: string, programPath: string[], options: ProbeOptions): Promise<ProbeOutcome> => {
  const started = Date.now();
  const words = programPath.slice(1);
  const attempts = words.length === 0 ? [["--help"], ["-h"]] : [[...words, "--help"], ["help", ...words]];
  let timedOut = false;
  for (const attempt of attempts) {
    options.signal?.throwIfAborted();
    const result = await run([file, ...attempt], options, true);
    if (result.timedOut) {
      if (options.wasPausedSince?.(started)) return { status: "interrupted", source: "help", ms: Date.now() - started };
      timedOut = true;
      break;
    }
    const node = parseHelp(result.stdout + "\n" + result.stderr, programPath);
    if (looksLikeHelp(node)) return { status: "ok", source: "help", node, ms: Date.now() - started };
  }
  return { status: timedOut ? "timeout" : "miss", source: "help", ms: Date.now() - started };
};

/** Renders the man page (mandoc/groff run, never the program itself) and parses its options. */
export const probeMan = async (name: string, options: ProbeOptions): Promise<ProbeOutcome> => {
  const started = Date.now();
  const result = await run(["man", "-P", "cat", name], options, false);
  if (result.timedOut) return { status: options.wasPausedSince?.(started) ? "interrupted" : "timeout", source: "man", ms: Date.now() - started };
  const node = parseHelp(result.stdout, [name]);
  if (looksLikeHelp(node)) return { status: "ok", source: "man", node, ms: Date.now() - started };
  return { status: "miss", source: "man", ms: Date.now() - started };
};

/** `--help` first (unless the gate forbids running it), then the man page. */
export const probeCommand = async (name: string, file: string, action: "probe" | "man", options: ProbeOptions): Promise<ProbeOutcome> => {
  let outcome: ProbeOutcome | undefined;
  if (action === "probe") {
    outcome = await probeHelp(file, [name], options);
    if (outcome.status === "ok" || outcome.status === "interrupted") return logOutcome(name, outcome);
  }
  const man = await probeMan(name, options);
  if (man.status === "ok" || outcome == null) return logOutcome(name, man);
  return logOutcome(name, outcome.status === "timeout" ? outcome : man);
};

const logOutcome = (name: string, outcome: ProbeOutcome): ProbeOutcome => {
  log.debug({ msg: "learned", name, source: outcome.source, status: outcome.status, ms: outcome.ms });
  return outcome;
};
