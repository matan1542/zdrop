import fs from "node:fs";
import fsAsync from "node:fs/promises";
import { learnConfig } from "./config.js";
import { sandboxAvailable } from "./sandbox.js";

// Static triage before anything is executed. Running `x --help` is only safe if `x` actually parses
// its arguments, so commands that might act on any invocation are never run: destructive or
// privileged tools, GUI apps, system daemons, and scripts that show no sign of reading arguments.
// Those are learned from their man page instead (reading a man page never runs the program).

export type GateAction = "probe" | "man" | "skip";
export type GateDecision = { action: GateAction; reason: string };

const deniedNames = new Set([
  "shutdown", "reboot", "halt", "poweroff", "init", "telinit", "systemctl", "launchctl", "dd", "kill", "killall", "pkill", "sudo",
  "su", "doas", "login", "passwd", "chsh", "chfn", "open", "xdg-open", "osascript", "say", "afplay", "softwareupdate", "caffeinate",
  "screencapture", "shred", "srm", "wipe", "format", "diskutil", "fdisk", "parted", "newfs", "yes", "sleep", "watch", "top", "htop",
  "less", "more", "most", "vi", "vim", "nvim", "view", "ex", "nano", "pico", "emacs", "ed", "joe", "mg", "sh", "bash", "zsh", "dash",
  "ksh", "csh", "tcsh", "fish", "nu", "xonsh", "python", "python2", "python3", "ruby", "irb", "perl", "node", "bun", "deno", "lua",
  "php", "R", "julia", "ghci", "erl", "iex", "scala", "jshell", "sqlite3", "psql", "mysql", "redis-cli", "mongo", "mongosh", "telnet",
  "nc", "ncat", "socat", "ssh", "sftp", "ftp", "tmux", "screen", "script", "reset", "clear", "exit", "logout", "true", "false",
]);
const deniedPatterns = [/^rm/, /^mkfs/, /^kill/, /update$/, /updater$/, /^git-/, /^cargo-/, /^npm-/, /^python\d/, /^pip\d/, /-config$/];

const systemDirs = /^\/(sbin|usr\/sbin|System|usr\/libexec|Library\/Apple|var\/run\/com\.apple)(\/|$)/;
const guiFrameworks = /(AppKit|Cocoa|SwiftUI|UIKit|Carbon)\.framework|libgtk|libQt\d?(Gui|Widgets)|libX11\.so/;
const scriptInterpreter = /^#!\s*(?:\S*\/env\s+(?:-\S+\s+)*)?\S*?\b(sh|bash|zsh|dash|ksh|python[\d.]*|ruby|perl)\b/;
// reads its arguments itself, or forwards them to a program that does (`exec node cli.js "$@"`, console-script shims)
const parsesArguments = /--help|\busage\b|getopts?\b|argparse|optparse|click\.|typer|docopt|OptionParser|Getopt|case\s+"?\$(1|\{1\}|@)"?|"\$@"|\$\{@\}|sys\.argv|\bARGV\b|process\.argv|import main\b|\bmain\(\)/i;

// launchers of JVM or GUI applications: slow and memory-hungry to start, and `--help` is often not theirs
const launchesApp = /\bJAVA_HOME\b|\bjava\s+-|-jar\s|launch\.sh|\.app\/|\bopen\s+-a\b|osascript|xdg-open|electron|tkinter|idlelib|PyQt|PySide|gi\.repository/i;
const jvmTool = /\/(openjdk(@[\d.]+)?|[^/]+\.jdk|jdk-\d[^/]*|jre|JavaVirtualMachines)\//;

const headBytes = 64 * 1024;

const readHead = async (file: string): Promise<Buffer> => {
  const handle = await fsAsync.open(file, "r");
  try {
    const buffer = Buffer.alloc(headBytes);
    const { bytesRead } = await handle.read(buffer, 0, headBytes, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
};

const isMachO = (head: Buffer) => {
  if (head.length < 4) return false;
  const magic = head.readUInt32BE(0);
  return [0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xbebafeca].includes(magic);
};

const isElf = (head: Buffer) => head.length >= 4 && head.readUInt32BE(0) === 0x7f454c46;

export const isDenied = (name: string): boolean =>
  deniedNames.has(name) || deniedPatterns.some((p) => p.test(name)) || learnConfig.deny.includes(name);

/**
 * @param name command name as typed
 * @param file resolved executable (from the user's PATH)
 * @param interactive the user typed this command (may run where background learning would not)
 */
export const gate = async (name: string, file: string, interactive: boolean): Promise<GateDecision> => {
  if (!learnConfig.enabled) return { action: "skip", reason: "ZDROP_LEARN=0" };
  if (isDenied(name)) return { action: "man", reason: "on the deny list (never executed)" };

  let real: string;
  let stat: fs.Stats;
  try {
    real = await fsAsync.realpath(file);
    stat = await fsAsync.stat(real);
  } catch {
    return { action: "skip", reason: "not found" };
  }
  if (!stat.isFile()) return { action: "skip", reason: "not a regular file" };
  if ((stat.mode & 0o6000) !== 0) return { action: "man", reason: "setuid/setgid binary (never executed)" };
  if (systemDirs.test(file) || systemDirs.test(real)) return { action: "man", reason: "system directory (never executed)" };
  if (real.includes(".app/Contents/")) return { action: "man", reason: "inside an application bundle (never executed)" };
  // Apple's tool shims (java, git, xcode stubs) are one binary with dozens of hard links; running one can
  // open an "install" dialog instead of printing help
  if (stat.nlink > 8) return { action: "man", reason: "multi-call system stub (never executed)" };
  if (!interactive && /^\/(usr\/)?bin\//.test(real)) return { action: "man", reason: "system command: man page in the background, --help only when typed" };
  if (jvmTool.test(real)) return { action: "man", reason: "JVM tool, slow and memory-hungry to start (never executed)" };

  let head: Buffer;
  try {
    head = await readHead(real);
  } catch {
    return { action: "skip", reason: "unreadable" };
  }
  if (head.subarray(0, 2).toString() === "#!") {
    const text = head.toString("utf8");
    const firstLine = text.slice(0, text.indexOf("\n") + 1 || undefined);
    if (scriptInterpreter.test(firstLine) && !parsesArguments.test(text)) return { action: "man", reason: "script that never reads its arguments (never executed)" };
    if (launchesApp.test(text)) return { action: "man", reason: "launches a JVM or GUI application (never executed)" };
  } else if (isMachO(head) || isElf(head)) {
    // many CLIs link AppKit (clipboard, keychain); the sandbox already blocks windows and app launches,
    // so a GUI framework only rules out running a binary when there is no sandbox
    if (!sandboxAvailable() && guiFrameworks.test(head.toString("latin1"))) return { action: "man", reason: "links a GUI framework (never executed)" };
  } else {
    return { action: "skip", reason: "not a script or native executable" };
  }

  if (!sandboxAvailable() && !interactive) return { action: "man", reason: "no sandbox available; runs only when typed" };
  return { action: "probe", reason: sandboxAvailable() ? "sandboxed --help" : "unsandboxed --help (typed by the user)" };
};
