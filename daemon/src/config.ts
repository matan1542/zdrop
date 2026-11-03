import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ~/.config/zdrop/config: `key = value` lines, `#` comments. Each key stands for a ZDROP_* variable,
// which still wins when set. The zsh plugin reads the shell keys itself (zsh/zdrop.plugin.zsh, same
// table); the daemon applies the daemon keys to its environment when this module loads, before
// anything reads them, and restarts when the file changes (server.ts).

export type ConfigKey = {
  key: string;
  env: string;
  side: "shell" | "daemon";
  /** allowed values, "int", "hex" or "list" (colon-separated names) */
  values: string[] | "int" | "hex" | "list";
  default: string;
  doc: string;
};

const onOff = ["on", "off"];

export const configKeys: ConfigKey[] = [
  { key: "theme", env: "ZDROP_THEME", side: "shell", values: ["dark", "light"], default: "dark", doc: "popup colours" },
  { key: "accent", env: "ZDROP_ACCENT", side: "shell", values: "hex", default: "1E5AC7", doc: "highlighted row colour (#rrggbb)" },
  { key: "width", env: "ZDROP_WIDTH", side: "shell", values: "int", default: "44", doc: "popup width in cells" },
  { key: "rows", env: "ZDROP_MAX_ROWS", side: "shell", values: "int", default: "7", doc: "visible rows" },
  { key: "icons", env: "ZDROP_ICONS", side: "shell", values: ["unicode", "nerd", "none"], default: "unicode", doc: "row icons (nerd needs a Nerd Font)" },
  { key: "docs", env: "ZDROP_DOCS", side: "shell", values: ["side", "below", "off"], default: "side", doc: "where the description goes (⌃K cycles)" },
  { key: "docs_width", env: "ZDROP_DOCS_WIDTH", side: "shell", values: "int", default: "36", doc: "docs panel width in cells" },
  { key: "enter", env: "ZDROP_ENTER", side: "shell", values: ["smart", "fill", "run"], default: "smart", doc: "Enter: fill while typing a word / always fill / always run" },
  { key: "ghost", env: "ZDROP_GHOST", side: "shell", values: onOff, default: "on", doc: "preview the suggestion after the cursor" },
  { key: "wrap", env: "ZDROP_WRAP", side: "shell", values: onOff, default: "off", doc: "↓ on the last row wraps to the top" },
  { key: "history", env: "ZDROP_HISTORY", side: "daemon", values: onOff, default: "on", doc: "rank by what you run, offer values you typed before" },
  { key: "frecency", env: "ZDROP_FRECENCY", side: "daemon", values: onOff, default: "on", doc: "cd offers the folders you visit most" },
  { key: "typos", env: "ZDROP_TYPOS", side: "daemon", values: onOff, default: "on", doc: "offer a fix for a mistyped command" },
  { key: "learn", env: "ZDROP_LEARN", side: "daemon", values: onOff, default: "on", doc: "learn commands from --help and man pages" },
  { key: "learn_background", env: "ZDROP_LEARN_BACKGROUND", side: "daemon", values: onOff, default: "on", doc: "also learn in the background (on AC power, when idle)" },
  { key: "learn_deny", env: "ZDROP_LEARN_DENY", side: "daemon", values: "list", default: "", doc: "never run --help for these (name:name)" },
  { key: "heavy_specs", env: "ZDROP_HEAVY_SPECS", side: "daemon", values: onOff, default: "off", doc: "full aws/gcloud/az specs (zdrop extras install)" },
  { key: "update_check", env: "ZDROP_UPDATE_CHECK", side: "daemon", values: onOff, default: "on", doc: "check GitHub weekly for a newer release" },
];

export const configPath = (): string => path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "zdrop", "config");

/** on/off as the 1/0 the ZDROP_* variables use */
const envValue = (key: ConfigKey, value: string): string => (key.values === onOff ? (value === "on" ? "1" : "0") : value.replace(/^#/, ""));

const valid = (key: ConfigKey, value: string): boolean => {
  if (key.values === "int") return /^\d+$/.test(value) && Number(value) > 0;
  if (key.values === "hex") return /^#?[0-9a-fA-F]{6}$/.test(value);
  if (key.values === "list") return /^[\w.+@-]*(:[\w.+@-]+)*$/.test(value);
  return key.values.includes(value);
};

export type ParsedConfig = { values: Map<string, string>; problems: string[] };

export const parseConfig = (text: string): ParsedConfig => {
  const values = new Map<string, string>();
  const problems: string[] = [];
  text.split("\n").forEach((raw, i) => {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) return;
    const eq = line.indexOf("=");
    const name = (eq === -1 ? line : line.slice(0, eq)).trim();
    const value = eq === -1 ? "" : line.slice(eq + 1).trim().replace(/^(["'])(.*)\1$/, "$2");
    const key = configKeys.find((k) => k.key === name);
    if (key == null) problems.push(`line ${i + 1}: unknown key "${name}"`);
    else if (eq === -1 || !valid(key, value)) problems.push(`line ${i + 1}: ${name} = ${value || "?"}: expected ${Array.isArray(key.values) ? key.values.join(" | ") : key.values}`);
    else values.set(name, value);
  });
  return { values, problems };
};

export const readConfig = (file = configPath()): ParsedConfig & { exists: boolean } => {
  try {
    return { ...parseConfig(fs.readFileSync(file, "utf8")), exists: true };
  } catch {
    return { values: new Map(), problems: [], exists: false };
  }
};

export type Effective = { key: ConfigKey; value: string; source: "env" | "file" | "default" };

/** Every key's value, and where it comes from. */
export const effectiveConfig = (parsed = readConfig(), env = process.env): Effective[] =>
  configKeys.map((key) => {
    const fromEnv = env[key.env];
    if (fromEnv != null && fromEnv !== "") {
      const value = key.values === onOff ? (fromEnv === "0" ? "off" : "on") : fromEnv;
      return { key, value, source: "env" };
    }
    const fromFile = parsed.values.get(key.key);
    return fromFile != null ? { key, value: fromFile, source: "file" } : { key, value: key.default, source: "default" };
  });

/** The file's daemon keys as ZDROP_* variables, where the environment doesn't set them. */
export const applyConfig = (parsed = readConfig(), env = process.env) => {
  for (const key of configKeys) {
    const value = parsed.values.get(key.key);
    if (key.side === "daemon" && value != null && (env[key.env] == null || env[key.env] === "")) env[key.env] = envValue(key, value);
  }
};

export const template = (): string =>
  [
    "# zdrop settings. Uncomment a line to change it; a ZDROP_* environment variable still wins.",
    "# Shell keys apply to new terminal tabs; the daemon restarts by itself to pick up its keys.",
    "",
    ...configKeys.map((k) => `# ${k.doc}${Array.isArray(k.values) ? ` (${k.values.join(" | ")})` : ""}\n# ${k.key} = ${k.key === "accent" ? "#" : ""}${k.default}\n`),
  ].join("\n");

/** a switch from the config file or environment (on unless "0") */
export const enabled = (env: string): boolean => process.env[env] !== "0";

applyConfig();
