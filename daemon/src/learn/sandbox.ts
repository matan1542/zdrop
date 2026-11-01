import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { learnConfig } from "./config.js";

// OS-level isolation for `--help` probes, after Homebrew's `brew test` sandbox and Codex's Seatbelt
// policy: no network, writes only inside a throwaway HOME, no GUI or LaunchServices (so nothing can
// open a window or another app), no reading of credential stores, a clean environment and a CPU limit.

const sandboxExec = "/usr/bin/sandbox-exec"; // absolute: a fake sandbox-exec earlier on PATH can't intercept
const bwrap = ["/usr/bin/bwrap", "/bin/bwrap", "/usr/local/bin/bwrap"].find((p) => fs.existsSync(p));

export const sandboxAvailable = (): boolean => (process.platform === "darwin" ? fs.existsSync(sandboxExec) : bwrap != null);

const sbString = (value: string) => JSON.stringify(value);

const darwinProfile = (home: string): string => {
  const user = os.homedir();
  const secrets = [".ssh", ".aws", ".gnupg", ".config/gh", ".netrc", ".npmrc", ".docker", ".kube", ".azure", ".config/gcloud", "Library/Keychains"]
    .map((p) => `(subpath ${sbString(path.join(user, p))})`)
    .join(" ");
  return `(version 1)
(allow default)
(deny network*)
(deny file-write*)
(allow file-write* (subpath ${sbString(home)}) (subpath "/private/var/folders") (literal "/dev/null") (literal "/dev/zero") (literal "/dev/dtracehelper") (regex #"^/dev/tty"))
(deny file-read* ${secrets})
(deny mach-lookup
  (global-name "com.apple.windowserver.active")
  (global-name "com.apple.coreservices.launchservicesd")
  (global-name "com.apple.CoreServices.coreservicesd")
  (global-name "com.apple.lsd.mapdb")
  (global-name "com.apple.pasteboard.1")
  (global-name "com.apple.dock.server"))
(deny process-exec (literal "/usr/bin/open") (literal "/usr/bin/osascript") (literal "/usr/bin/say"))
`;
};

export type Sandbox = {
  /** throwaway HOME (and cwd) of every probe from this process */
  home: string;
  /** argv prefix that runs a command inside the sandbox */
  wrap: (argv: string[]) => string[];
  env: (shellPath: string) => Record<string, string>;
  dispose: () => void;
};

const processAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Probe homes are per process (`probe-home/<pid>`); those of dead processes are removed. */
const sweepStaleHomes = () => {
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(learnConfig.probeHomeRoot);
  } catch {
    return;
  }
  for (const entry of entries) {
    const pid = Number(entry);
    if (Number.isInteger(pid) && pid !== process.pid && !processAlive(pid)) fs.rmSync(path.join(learnConfig.probeHomeRoot, entry), { recursive: true, force: true });
  }
};

export const createSandbox = (): Sandbox => {
  sweepStaleHomes();
  const home = path.join(learnConfig.probeHomeRoot, String(process.pid));
  fs.rmSync(home, { recursive: true, force: true });
  fs.mkdirSync(path.join(home, "tmp"), { recursive: true, mode: 0o700 });
  const realHome = fs.realpathSync(home);

  let wrap: (argv: string[]) => string[] = (argv) => argv;
  if (process.platform === "darwin" && sandboxAvailable()) {
    const profile = path.join(realHome, "probe.sb");
    fs.writeFileSync(profile, darwinProfile(realHome));
    wrap = (argv) => [sandboxExec, "-f", profile, ...argv];
  } else if (bwrap != null) {
    wrap = (argv) => [
      bwrap,
      "--ro-bind", "/", "/",
      "--dev", "/dev",
      "--proc", "/proc",
      "--tmpfs", "/tmp",
      "--tmpfs", os.homedir(),
      "--bind", realHome, realHome,
      "--unshare-net", "--unshare-pid", "--new-session", "--die-with-parent",
      "--chdir", realHome,
      "--", ...argv,
    ];
  }
  // a CPU-time rlimit, then exec: the shell is replaced, so the process group is just the probe
  const withLimits = (argv: string[]) => ["/bin/sh", "-c", `ulimit -t ${learnConfig.cpuSeconds} 2>/dev/null; exec "$@"`, "sh", ...argv];

  return {
    home: realHome,
    wrap: (argv) => withLimits(wrap(argv)),
    // an allow-list: nothing from the daemon's or the user's environment (tokens, keys) is passed on
    env: (shellPath) => ({
      PATH: shellPath,
      HOME: realHome,
      TMPDIR: path.join(realHome, "tmp"),
      XDG_CONFIG_HOME: path.join(realHome, ".config"),
      XDG_DATA_HOME: path.join(realHome, ".local", "share"),
      XDG_CACHE_HOME: path.join(realHome, ".cache"),
      XDG_STATE_HOME: path.join(realHome, ".local", "state"),
      USER: os.userInfo().username,
      LANG: "C",
      LC_ALL: "C",
      TERM: "dumb",
      NO_COLOR: "1",
      CI: "1",
      COLUMNS: "200",
      LINES: "50",
      PAGER: "cat",
      GIT_PAGER: "cat",
      MANPAGER: "cat",
      MANWIDTH: "100",
      BROWSER: "false",
      EDITOR: "false",
      VISUAL: "false",
      GIT_TERMINAL_PROMPT: "0",
      HOMEBREW_NO_AUTO_UPDATE: "1",
      DEBIAN_FRONTEND: "noninteractive",
      NO_UPDATE_NOTIFIER: "1",
      ZDROP_PROBE: "1",
    }),
    dispose: () => fs.rmSync(home, { recursive: true, force: true }),
  };
};
