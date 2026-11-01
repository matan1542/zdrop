import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runQuery, type QueryResult } from "../src/engine.js";

export const tempDir = (name: string): string => fs.mkdtempSync(path.join(os.tmpdir(), `zdrop-${name}-`));

export const writeJson = (file: string, value: unknown) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
};

export const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "-c", "init.defaultBranch=main", ...args], { cwd, stdio: "pipe" });

/** Runs a query and returns the final (non-pending) result. */
export const query = async (line: string, cwd: string): Promise<QueryResult> => {
  const results: QueryResult[] = [];
  await runQuery(line, cwd, (result) => results.push(result));
  return results.at(-1)!;
};

export const names = (result: QueryResult) => result.items.map((item) => item.name);

/**
 * Writes a fake CLI (a /bin/sh script using only shell builtins) that appends its arguments to
 * `<dir>/<name>.log` on every run and prints `help` for `--help`, or `subhelp[sub]` for `<sub> --help`.
 */
export const fakeCli = (dir: string, name: string, help: string, subhelp: Record<string, string> = {}, extra = ""): string => {
  const file = path.join(dir, name);
  const quote = (text: string) => `'${text.replaceAll("'", `'\\''`)}'`;
  const cases = Object.entries(subhelp)
    .map(([sub, text]) => `  ${sub}) printf '%s\\n' ${quote(text)}; exit 0 ;;`)
    .join("\n");
  fs.writeFileSync(
    file,
    `#!/bin/sh
# usage: ${name} [--help]
echo "$*" >> ${quote(file + ".log")}
${extra}
case "$1" in
${cases}
  *) printf '%s\\n' ${quote(help)} ;;
esac
`,
    { mode: 0o755 },
  );
  return file;
};

export const invocations = (file: string): string[] => {
  try {
    return fs.readFileSync(file + ".log", "utf8").trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
};

export const waitFor = async (condition: () => boolean, timeoutMs = 5000) => {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};
