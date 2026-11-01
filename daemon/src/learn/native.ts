import { runProcess } from "../../vendor/inshellisense/runtime/utils.js";
import { learnConfig } from "./config.js";
import type { ProbeOptions } from "./prober.js";

// Many CLIs are built on a framework with its own completion protocol, the one their shell
// completion scripts call on every Tab: cobra's hidden `__complete` command (Go), click/typer's
// `_PROG_COMPLETE` environment variable (Python) and yargs' `--get-yargs-completions` (Node). It
// answers with live values (kube contexts, pods, branches, profiles) that `--help` can't list.
//
// Detection happens once, while learning, in the sandbox: the help text must carry the framework's
// signature and a probe must answer in the protocol's exact format. Only then is the protocol used at
// completion time, through the normal generator pipeline (real environment and cwd, process-group
// kill, output cap, shared child limit, cache, loading state), exactly as the tool's own completion
// script would run it.

export type Protocol = "cobra" | "click" | "yargs";

const signatures: [Protocol, RegExp][] = [
  ["cobra", /Use "[^"\n]+ \[command\] --help" for more information|^Available Commands:$/m],
  ["click", /Show this message and exit\./],
  ["yargs", /Show version number\s+\[boolean\]|\s\[boolean\]\s*$/m],
];

export const denied = (base: string) => (process.env.ZDROP_NATIVE_DENY ?? "").split(":").includes(base);

const clickVar = (base: string) => `_${base.replace(/[^A-Za-z0-9]/g, "_").toUpperCase()}_COMPLETE`;

/** Request for completing `words` (the program's arguments, the last one being the word under the cursor). */
const request = (protocol: Protocol, base: string, words: string[]): { args: string[]; env: Record<string, string> } => {
  switch (protocol) {
    case "cobra":
      return { args: ["__complete", ...words], env: {} };
    case "click":
      return { args: [], env: { [clickVar(base)]: "zsh_complete", COMP_WORDS: [base, ...words].join(" "), COMP_CWORD: String(words.length) } };
    case "yargs":
      return { args: ["--get-yargs-completions", base, ...words], env: {} };
  }
};

const unescapeColon = (s: string) => s.replace(/\\:/g, ":");

/** Parses a protocol's answer; undefined when the output is not in that protocol's format. */
export const parseNative = (protocol: Protocol, stdout: string): Fig.Suggestion[] | undefined => {
  const lines = stdout.replace(/\r/g, "").split("\n");
  while (lines.length > 0 && lines.at(-1) === "") lines.pop();
  switch (protocol) {
    case "cobra": {
      const directive = /^:(\d+)$/.exec(lines.at(-1) ?? "");
      if (directive == null) return;
      const flags = Number(directive[1]);
      // error, or "complete file extensions / directories": leave those to the spec's templates
      if (flags & (1 | 8 | 16)) return [];
      return lines.slice(0, -1).filter((l) => l.length > 0 && !l.startsWith("_")).map((line) => {
        const [name, description] = line.split("\t");
        const suggestion: Fig.Suggestion = { name, description: description || undefined };
        if (flags & 2) suggestion.insertValue = name;
        return suggestion;
      });
    }
    case "click": {
      if (lines.length % 3 !== 0) return;
      const out: Fig.Suggestion[] = [];
      for (let i = 0; i < lines.length; i += 3) {
        const [type, value, help] = lines.slice(i, i + 3);
        if (!["plain", "file", "dir"].includes(type)) return;
        if (type === "plain") out.push({ name: value, description: help && help !== "_" ? help : undefined });
      }
      return out;
    }
    case "yargs": {
      if (lines.some((l) => /error|unknown argument|not enough/i.test(l))) return;
      return lines
        .filter((l) => l.length > 0 && !l.startsWith("-"))
        .map((line) => {
          const match = /^((?:[^:\\]|\\.)*)(?::(.*))?$/.exec(line)!;
          return { name: unescapeColon(match[1]), description: match[2] || undefined };
        });
    }
  }
};

/** Signature in the help text, then a sandboxed probe answering in the exact format. */
export const detectProtocol = async (file: string, base: string, helpText: string, options: ProbeOptions): Promise<Protocol | undefined> => {
  if (denied(base)) return;
  for (const [protocol, signature] of signatures) {
    if (!signature.test(helpText)) continue;
    const { args, env } = request(protocol, base, [""]);
    const [command, ...wrapped] = options.sandbox.wrap([file, ...args]);
    const result = await runProcess(command, wrapped, {
      cwd: options.sandbox.home,
      env: { ...options.sandbox.env(options.shellPath), ...env },
      timeout: options.background ? learnConfig.backgroundTimeoutMs : learnConfig.interactiveTimeoutMs,
      signal: options.signal,
      outputBytes: learnConfig.outputBytes,
      priority: options.background ? 19 : undefined,
    });
    if (result.timedOut) return;
    const parsed = parseNative(protocol, result.stdout);
    if (parsed != null && (protocol !== "yargs" || parsed.length > 0)) return protocol;
  }
  return;
};

/** A Fig generator asking the program itself for the values at the cursor. */
export const nativeGenerator = (protocol: Protocol, file: string, base: string): Fig.Generator => ({
  custom: async (tokens, executeShellCommand, context) => {
    if (denied(base)) return [];
    const { args, env } = request(protocol, base, tokens.slice(1));
    const output = await executeShellCommand({ command: file, args, env, cwd: context.currentWorkingDirectory });
    return parseNative(protocol, output.stdout) ?? [];
  },
});
