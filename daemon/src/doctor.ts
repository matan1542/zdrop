import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { learnConfig } from "./learn/config.js";
import { sandboxAvailable } from "./learn/sandbox.js";
import { LearnedStore } from "./learn/store.js";
import { zdropHome } from "./protocol.js";
import { repoRoot } from "./setup.js";
import { installedVersion, isHomebrew, latestRelease, newer } from "./update.js";

// `zdrop doctor`: checks the things that make zdrop misbehave without an error, each with a fix.

export type Check = { level: "ok" | "warn" | "fail"; title: string; detail: string };

export type DoctorEnv = {
  home: string;
  zshrc: string;
  root: string;
  /** status JSON of the running daemon, if any */
  status?: () => Promise<Record<string, unknown> | undefined>;
  fetcher?: typeof fetch;
  termProgram?: string;
};

const ok = (title: string, detail = ""): Check => ({ level: "ok", title, detail });
const warn = (title: string, detail: string): Check => ({ level: "warn", title, detail });
const fail = (title: string, detail: string): Check => ({ level: "fail", title, detail });

const pluginLine = /^[^#]*zdrop\.plugin\.zsh/;
// lines that can rebind keys or replace widgets when they run after zdrop
// (key bindings themselves don't matter: zdrop binds at the first prompt, after ~/.zshrc has run)
const laterLoaders = /(^|\s)(source|\.)\s+\S|^\s*plugins=|\b(zinit|antidote|antigen|zplug|zgenom|sheldon)\b|oh-my-zsh\.sh|zsh-autosuggestions|fzf-tab/;
const otherPopups = /kiro-cli\s+init|\bq\s+init\b|fig\s+init|amazon-q|inshellisense|\bis\s+init/;

/** The file a zdrop line sources, when it can be resolved without running the shell. */
const sourcedPath = (line: string, home: string): string | undefined => {
  const file = /(?:source|\.)\s+["']?([^"'\s]*zdrop\.plugin\.zsh)/.exec(line)?.[1]?.replace(/^(~|\$HOME|\$\{HOME\})(?=\/)/, home);
  return file != null && file.startsWith("/") && !file.includes("$") ? file : undefined;
};

export const checkZshrc = (zshrc: string, home = os.homedir()): Check[] => {
  let text: string;
  try {
    text = fs.readFileSync(zshrc, "utf8");
  } catch {
    return [fail("~/.zshrc", `${zshrc} not found: add  source <install>/zsh/zdrop.plugin.zsh  to it`)];
  }
  const lines = text.split("\n");
  const at = lines.map((line, i) => (pluginLine.test(line) ? i : -1)).filter((i) => i >= 0);
  const checks: Check[] = [];
  if (at.length === 0) return [fail("~/.zshrc loads zdrop", "no line sources zdrop.plugin.zsh: run  zdrop setup")];
  const file = sourcedPath(lines[at.at(-1)!], home);
  if (file != null && !fs.existsSync(file)) checks.push(fail("~/.zshrc loads zdrop", `line ${at.at(-1)! + 1} sources ${file}, which does not exist: run  zdrop setup`));
  if (at.length > 1) checks.push(fail("~/.zshrc loads zdrop once", `${at.length} lines source zdrop.plugin.zsh (lines ${at.map((i) => i + 1).join(", ")}): keep one`));
  else checks.push(ok("~/.zshrc loads zdrop once", `line ${at[0] + 1}`));
  const after = lines
    .map((line, i) => ({ line: line.trim(), i }))
    .filter(({ line, i }) => i > at.at(-1)! && line !== "" && !line.startsWith("#") && laterLoaders.test(line));
  checks.push(
    after.length === 0
      ? ok("zdrop loads last")
      : warn("zdrop loads last", `move the zdrop line below: ${after.slice(0, 3).map(({ line, i }) => `${i + 1}: ${line.slice(0, 50)}`).join("; ")}`),
  );
  const rival = lines.find((line) => !line.trim().startsWith("#") && otherPopups.test(line));
  if (rival) checks.push(warn("no other autocomplete popup", `two popups would compete: ${rival.trim().slice(0, 60)}`));
  return checks;
};

const stripJsonComments = (text: string) => text.replace(/("(?:[^"\\]|\\.)*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (_, s: string | undefined) => s ?? "").replace(/,(\s*[}\]])/g, "$1");

export const checkEditors = (home: string): Check[] => {
  const editors: [string, string][] = [
    ["VS Code", "Code"],
    ["Cursor", "Cursor"],
    ["Kiro", "Kiro"],
    ["Windsurf", "Windsurf"],
  ];
  const checks: Check[] = [];
  for (const [label, dir] of editors) {
    const file = path.join(home, "Library", "Application Support", dir, "User", "settings.json");
    if (!fs.existsSync(file)) continue;
    let enabled: unknown;
    try {
      enabled = (JSON.parse(stripJsonComments(fs.readFileSync(file, "utf8"))) as Record<string, unknown>)["terminal.integrated.suggest.enabled"];
    } catch {
      checks.push(warn(`${label} terminal suggestions`, `could not read ${file}`));
      continue;
    }
    checks.push(
      enabled === false
        ? ok(`${label} terminal suggestions off`)
        : warn(`${label} terminal suggestions off`, `set "terminal.integrated.suggest.enabled": false in ${file}`),
    );
  }
  return checks;
};

const syncTerminals = new Set(["iTerm.app", "WezTerm", "ghostty", "vscode", "kitty", "Hyper", "rio", "Tabby"]);

export const checkTerminal = (termProgram: string | undefined): Check =>
  termProgram === "Apple_Terminal"
    ? warn("flicker-free drawing", "Terminal.app has no synchronized output; iTerm2, Ghostty, WezTerm or an IDE terminal draw the popup without flicker")
    : termProgram != null && syncTerminals.has(termProgram)
      ? ok("flicker-free drawing", termProgram)
      : ok("flicker-free drawing", `${termProgram ?? "unknown terminal"}: assumed`);

const zshVersion = (): string | undefined => {
  try {
    return /zsh (\d+\.\d+)/.exec(execFileSync("zsh", ["--version"], { encoding: "utf8", timeout: 3000 }))?.[1];
  } catch {
    return;
  }
};

const dirBytes = (dir: string): number => {
  let total = 0;
  const walk = (d: string) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else total += fs.statSync(p).size;
    }
  };
  try {
    walk(dir);
  } catch {
    // missing
  }
  return total;
};

const mb = (bytes: number) => `${(bytes / 1048576).toFixed(1)} MB`;

export const runDoctor = async (env: DoctorEnv): Promise<Check[]> => {
  const checks: Check[] = [];
  const version = installedVersion(env.root);
  const bundled = fs.existsSync(path.join(env.root, "runtime", "node"));
  checks.push(ok("installed", `${version ?? "source checkout"} at ${env.root}${bundled ? " (bundled Node.js " + process.version + ")" : ", Node.js " + process.version}`));

  const zsh = zshVersion();
  checks.push(zsh == null ? fail("zsh", "zsh not found") : newer("5.8", zsh) ? fail("zsh 5.8+", `zsh ${zsh} is too old`) : ok("zsh 5.8+", zsh));

  checks.push(...checkZshrc(env.zshrc), ...checkEditors(env.home), checkTerminal(env.termProgram));

  const loginItem = path.join(env.home, "Library", "LaunchAgents", "io.github.matan1542.zdrop.plist");
  checks.push(ok("starts at login", fs.existsSync(loginItem) ? loginItem : "off: zdrop setup turns it on"));

  const status = await env.status?.().catch(() => undefined);
  if (status == null) {
    checks.push(ok("daemon", "not running; it starts on the next keystroke"));
  } else {
    const memory = status.memory as { rssMB: number; rssLimitMB: number };
    const level = memory.rssMB > memory.rssLimitMB * 0.9 ? "warn" : "ok";
    checks.push({ level, title: "daemon", detail: `pid ${String(status.pid)}, ${memory.rssMB} MB of ${memory.rssLimitMB} MB, ${String(status.sessions)} shell(s)` });
  }
  try {
    const last = JSON.parse(fs.readFileSync(path.join(zdropHome, "last-exit.json"), "utf8")) as { reason: string; at: string; rssMB: number };
    const crashed = /crash/.test(last.reason);
    checks.push({ level: crashed ? "warn" : "ok", title: "last daemon exit", detail: `${last.reason} at ${last.at} (${last.rssMB} MB)` });
  } catch {
    // never exited yet
  }

  checks.push(sandboxAvailable() ? ok("sandbox for --help probes") : warn("sandbox for --help probes", "none available: only commands you type are probed"));
  const store = new LearnedStore();
  await store.loadIndex();
  const background = (status?.learn as { background?: { state: string } } | undefined)?.background?.state;
  checks.push(ok("learned commands", `${store.descriptions.size} learned${background ? `, background: ${background}` : ""}${learnConfig.enabled ? "" : " (ZDROP_LEARN=0)"}`));
  checks.push(ok("cache", `${mb(dirBytes(zdropHome))} in ${zdropHome}`));

  if (version != null && process.env.ZDROP_UPDATE_CHECK !== "0") {
    const latest = await latestRelease(env.fetcher).catch(() => undefined);
    if (latest == null) checks.push(ok("up to date", "could not reach GitHub"));
    else if (newer(latest, version)) checks.push(warn("up to date", `${latest} is available: ${isHomebrew(env.root) ? "brew upgrade zdrop" : "zdrop update"}`));
    else checks.push(ok("up to date", version));
  }
  return checks;
};

export const printDoctor = (checks: Check[]): number => {
  const mark = { ok: "\x1b[32m✓\x1b[0m", warn: "\x1b[33m!\x1b[0m", fail: "\x1b[31m✗\x1b[0m" };
  for (const check of checks) process.stdout.write(`${mark[check.level]} ${check.title}${check.detail ? `  \x1b[2m${check.detail}\x1b[0m` : ""}\n`);
  return checks.some((c) => c.level === "fail") ? 1 : 0;
};

export const defaultDoctorEnv = (): DoctorEnv => ({
  home: os.homedir(),
  zshrc: path.join(process.env.ZDOTDIR ?? os.homedir(), ".zshrc"),
  root: repoRoot,
  termProgram: process.env.TERM_PROGRAM,
});
