import fs from "node:fs";
import path from "node:path";
import { zdropHome } from "./protocol.js";
import { repoRoot } from "./setup.js";

// At most once a week, a release install asks GitHub for the latest release. A newer one becomes a
// one-line notice the shell shows once in the description bar. Nothing is ever installed by itself.

export const repo = "matan1542/zdrop";
const weekMs = 7 * 86_400_000;
const stateFile = path.join(zdropHome, "update.json");

type State = { checkedAt: number; latest?: string };

/** The installed release, or undefined for a source checkout. */
export const installedVersion = (root = repoRoot): string | undefined => {
  try {
    return fs.readFileSync(path.join(root, "VERSION"), "utf8").trim() || undefined;
  } catch {
    return;
  }
};

export const isHomebrew = (root = repoRoot) => root.includes("/Cellar/zdrop/");

/** a > b for dotted versions */
export const newer = (a: string, b: string): boolean => {
  const pa = a.replace(/^v/, "").split(/[.-]/).map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.replace(/^v/, "").split(/[.-]/).map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0);
  }
  return false;
};

export const fetchLatest = async (fetcher: typeof fetch = fetch): Promise<string | undefined> => {
  const response = await fetcher(`https://api.github.com/repos/${repo}/releases/latest`, {
    headers: { accept: "application/vnd.github+json", "user-agent": "zdrop" },
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) return;
  const body = (await response.json()) as { tag_name?: string };
  return body.tag_name?.replace(/^v/, "");
};

const readState = (): State => {
  try {
    return JSON.parse(fs.readFileSync(stateFile, "utf8")) as State;
  } catch {
    return { checkedAt: 0 };
  }
};

/** Latest release, from the weekly cache or GitHub; undefined when unknown. */
export const latestRelease = async (fetcher: typeof fetch = fetch, now = Date.now()): Promise<string | undefined> => {
  const state = readState();
  if (now - state.checkedAt < weekMs) return state.latest;
  let latest: string | undefined;
  try {
    latest = await fetchLatest(fetcher);
  } catch {
    // offline: try again next week
  }
  try {
    fs.writeFileSync(stateFile, JSON.stringify({ checkedAt: now, latest: latest ?? state.latest }));
  } catch {
    // best effort
  }
  return latest ?? state.latest;
};

export const noticeFor = (installed: string, latest: string | undefined, homebrew: boolean): string =>
  latest != null && newer(latest, installed) ? `zdrop ${latest} available · ${homebrew ? "brew upgrade zdrop" : "zdrop update"}` : "";

/** The current notice (empty when up to date, a source checkout, or ZDROP_UPDATE_CHECK=0). */
export let updateNotice = "";

export const startUpdateCheck = (delayMs = 30_000) => {
  if (process.env.ZDROP_TEST_NOTICE) {
    updateNotice = process.env.ZDROP_TEST_NOTICE;
    return;
  }
  const installed = installedVersion();
  if (installed == null || process.env.ZDROP_UPDATE_CHECK === "0") return;
  setTimeout(() => {
    void latestRelease().then((latest) => {
      updateNotice = noticeFor(installed, latest, isHomebrew());
    });
  }, delayMs).unref();
};
