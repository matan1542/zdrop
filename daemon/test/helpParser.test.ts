import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { looksLikeHelp, parseHelp, type HelpNode } from "../src/learn/helpParser.js";
import { toFigSpec } from "../src/learn/figSpec.js";

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "help");
const parse = (file: string, ...programPath: string[]) => parseHelp(fs.readFileSync(path.join(fixtures, file), "utf8"), programPath);

const sub = (node: HelpNode, name: string) => node.subcommands.find((c) => c.names.includes(name));
const opt = (options: HelpNode["options"], name: string) => options.find((o) => o.names.includes(name));

describe("help parser: captured help", () => {
  it("commander (claude)", () => {
    const node = parse("claude.txt", "claude");
    expect(node.description).toMatch(/^Claude Code - starts an interactive session/);
    expect(node.subcommands.map((c) => c.names[0])).toEqual(expect.arrayContaining(["mcp", "doctor", "plugin", "stop", "update"]));
    expect(sub(node, "plugin")?.names).toEqual(["plugin", "plugins"]);
    expect(sub(node, "stop")?.names).toEqual(["stop", "kill"]);
    expect(sub(node, "attach")?.args).toEqual([{ name: "id|name" }]);
    expect(sub(node, "doctor")?.description).toBe("Check the health of your Claude Code installation");
    expect(opt(node.options, "--continue")?.names).toEqual(["-c", "--continue"]);
    expect(opt(node.options, "--continue")?.arg).toBeUndefined();
    expect(opt(node.options, "--allowed-tools")?.names).toEqual(["--allowedTools", "--allowed-tools"]);
    expect(opt(node.options, "--add-dir")?.arg).toMatchObject({ name: "directories", variadic: true, template: "folders" });
    expect(opt(node.options, "--debug")?.arg).toMatchObject({ name: "filter", optional: true });
    expect(opt(node.options, "--effort")?.arg?.choices).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(opt(node.options, "--output-format")?.arg?.choices).toEqual(["text", "json", "stream-json"]);
    expect(opt(node.options, "--cloud")?.arg?.choices).toBeUndefined();
    expect(opt(node.options, "--agents")?.arg?.template).toBeUndefined();
    expect(opt(node.options, "--allowed-tools")?.description).toBe('Comma or space-separated list of tool names to allow (e.g. "Bash(git *) Edit")');
  });

  it("commander subcommand with an examples block inside a description (claude mcp)", () => {
    const node = parse("claude-mcp.txt", "claude", "mcp");
    expect(node.description).toBe("Configure and manage MCP servers");
    expect(node.subcommands.map((c) => c.names[0])).toEqual([
      "add", "add-from-claude-desktop", "add-json", "get", "help", "list", "login", "logout", "remove", "reset-project-choices", "serve",
    ]);
    expect(sub(node, "add")?.args).toEqual([{ name: "name" }, { name: "commandOrUrl" }, { name: "args", optional: true, variadic: true }]);
    expect(sub(node, "add")?.description).toBe("Add an MCP server to Claude Code");
  });

  it("clap long help (codex)", () => {
    const node = parse("codex.txt", "codex");
    expect(node.description).toBe("Codex CLI");
    expect(sub(node, "exec")?.names).toEqual(["exec", "e"]);
    expect(opt(node.options, "--sandbox")?.arg?.choices).toEqual(["read-only", "workspace-write", "danger-full-access"]);
    expect(opt(node.options, "--ask-for-approval")?.arg?.choices).toEqual(["untrusted", "on-request", "never"]);
    expect(opt(node.options, "--enable")?.names).toEqual(["--enable"]);
    expect(opt(node.options, "--image")?.arg).toMatchObject({ variadic: true, template: "filepaths" });
    expect(opt(node.options, "--cd")?.arg?.template).toBe("folders");
    expect(node.args).toEqual([{ name: "PROMPT", optional: true }]);
  });

  it("clap short help with option aliases (kiro-cli)", () => {
    const node = parse("kiro-cli.txt", "kiro-cli");
    expect(node.subcommands).toHaveLength(16);
    expect(opt(node.options, "--legacy-ui")?.names).toEqual(["--legacy-ui", "--classic"]);
    expect(opt(node.options, "--agent")?.arg?.name).toBe("AGENT");
    expect(opt(node.options, "--verbose")?.arg).toBeUndefined();
  });

  it("uppercase headings with trailing short flags (opencode)", () => {
    const node = parse("opencode.txt", "opencode");
    expect(node.description).toBe("OpenCode command line interface");
    expect(sub(node, "upgrade")?.names).toEqual(["upgrade", "update"]);
    expect(opt(node.options, "--continue")?.names).toEqual(["--continue", "-c"]);
    expect(opt(node.options, "--session")?.arg?.name).toBe("string");
    expect(opt(node.options, "--log-level")?.arg?.choices).toContain("debug");
    expect(node.args).toEqual([{ name: "directory", optional: true, template: "folders" }]);
  });

  it("flags nested under each command (graphify)", () => {
    const node = parse("graphify.txt", "graphify");
    expect(sub(node, "uninstall")?.options.map((o) => o.names[0])).toEqual(["--purge"]);
    expect(sub(node, "path")?.args.map((a) => a.name)).toEqual(["A", "B"]);
    expect(sub(node, "query")?.args.map((a) => a.name)).toEqual(["question"]);
    expect(sub(node, "cluster-only")?.options.map((o) => o.names[0])).toContain("--no-viz");
    expect(opt(node.options, "--purge")).toBeUndefined();
  });

  it("mdoc man pages (ls, tar)", () => {
    const ls = parse("man-ls.txt", "ls");
    expect(ls.description).toBe("list directory contents");
    expect(ls.subcommands).toEqual([]);
    expect(opt(ls.options, "-l")?.description).toMatch(/long format/);
    expect(opt(ls.options, "-D")?.arg?.name).toBe("format");
    expect(opt(ls.options, "--color")?.arg?.name).toBe("when");
    expect(ls.options.length).toBeGreaterThan(40);

    const tar = parse("man-tar.txt", "tar");
    expect(opt(tar.options, "--file")?.names).toEqual(["-f", "--file"]);
    expect(opt(tar.options, "--directory")?.names).toEqual(["-C", "--cd", "--directory"]);
  });
});

// the man page this machine renders (BSD mdoc on macOS, GNU groff on Linux), when man is installed
const localMan = (name: string): string | undefined => {
  const result = spawnSync("man", ["-P", "cat", name], { encoding: "utf8", env: { ...process.env, MANWIDTH: "100", MANPAGER: "cat" }, timeout: 10_000 });
  return result.status === 0 && result.stdout.length > 500 ? result.stdout : undefined;
};

describe("help parser: this machine's man pages", () => {
  const ls = localMan("ls");
  it.runIf(ls != null)("parses ls(1) as rendered here", () => {
    const node = parseHelp(ls!, ["ls"]);
    expect(looksLikeHelp(node)).toBe(true);
    expect(node.options.length).toBeGreaterThan(20);
    expect(opt(node.options, "-l")?.description).toMatch(/long/i);
    expect(opt(node.options, "-a") ?? opt(node.options, "--all")).toBeDefined();
  });
});

describe("help parser: library formats", () => {
  it("cobra", () => {
    const node = parse("cobra.txt", "kubectl");
    expect(node.description).toBe("kubectl controls the Kubernetes cluster manager");
    expect(node.subcommands.map((c) => c.names[0])).toEqual(["apply", "get", "logs", "completion"]);
    expect(opt(node.options, "--namespace")?.arg?.name).toBe("string");
    expect(opt(node.options, "--request-timeout")?.arg?.name).toBe("duration");
    expect(opt(node.options, "--v")?.arg?.name).toBe("Level");
    expect(opt(node.options, "--cache-dir")?.description).toBe("Default cache directory");
  });

  it("yargs", () => {
    const node = parse("yargs.txt", "mycli");
    expect(sub(node, "serve")?.names).toEqual(["serve", "s"]);
    expect(sub(node, "serve")?.args).toEqual([{ name: "port", optional: true }]);
    expect(sub(node, "lint")?.args[0]).toMatchObject({ name: "files", variadic: true });
    expect(opt(node.options, "--config")?.arg).toBeDefined();
    expect(opt(node.options, "--version")?.arg).toBeUndefined();
    expect(opt(node.options, "--mode")?.arg?.choices).toEqual(["development", "production"]);
  });

  it("click", () => {
    const node = parse("click.txt", "tool");
    expect(node.description).toBe("A tool that does things");
    expect(opt(node.options, "--debug")?.names).toEqual(["--debug", "--no-debug"]);
    expect(opt(node.options, "--format")?.arg?.choices).toEqual(["json", "yaml", "text", "csv"]);
    expect(opt(node.options, "--output")?.arg?.template).toBe("filepaths");
    expect(node.subcommands.map((c) => c.names[0])).toEqual(["init", "publish"]);
  });

  it("argparse", () => {
    const node = parse("argparse.txt", "pkgtool");
    expect(node.description).toBe("Manage packages");
    expect(node.subcommands.map((c) => [c.names[0], c.description])).toEqual([
      ["install", "Install a package"],
      ["remove", "Remove a package"],
      ["list", "List installed packages"],
    ]);
    expect(opt(node.options, "--color")?.arg?.choices).toEqual(["auto", "always", "never"]);
    expect(opt(node.options, "--root")?.arg).toMatchObject({ name: "DIR", template: "folders" });
  });

  it("reStructuredText rendered as a man page (aws help)", () => {
    const text = `AWS()\n\nNAME\n       aws -\n\nGLOBAL OPTIONS\n       --debug (boolean)\n\n       Turn on debug logging.\n\n       --endpoint-url (string)\n\n       Override the URL.\n\nAVAILABLE SERVICES\n       o accessanalyzer\n\n       o s3\n`;
    const node = parseHelp(text, ["aws"]);
    expect(node.subcommands.map((c) => c.names[0])).toEqual(["accessanalyzer", "s3"]);
    expect(opt(node.options, "--debug")?.arg).toBeUndefined();
    expect(opt(node.options, "--endpoint-url")?.arg?.name).toBe("string");
  });

  it("rejects output that is not help", () => {
    expect(looksLikeHelp(parse("notahelp.txt", "x"))).toBe(false);
    expect(looksLikeHelp(parseHelp("", ["x"]))).toBe(false);
    expect(looksLikeHelp(parse("kiro-cli.txt", "kiro-cli"))).toBe(true);
  });

  it("strips ANSI colors and overstrike", () => {
    const node = parseHelp("\x1b[1mUsage:\x1b[0m x\n\n\x1b[33mOptions:\x1b[0m\n  -a, --all   show all\n  -q          q\bqu\buiet\n", ["x"]);
    expect(node.options.map((o) => o.names)).toEqual([["-a", "--all"], ["-q"]]);
    expect(node.options[1].description).toBe("quiet");
  });
});

describe("learned spec", () => {
  it("embeds learned subcommands and lazy-loads the rest", () => {
    const root = parse("claude.txt", "claude");
    const mcp = parse("claude-mcp.txt", "claude", "mcp");
    const spec = toFigSpec("claude", { "": root, mcp });
    const subs = spec.subcommands as Fig.Subcommand[];
    const mcpSpec = subs.find((s) => s.name === "mcp")!;
    expect(mcpSpec.loadSpec).toBeUndefined();
    expect((mcpSpec.subcommands as Fig.Subcommand[]).find((s) => s.name === "add")?.loadSpec).toBe("claude/mcp/add");
    expect(subs.find((s) => s.name === "doctor")?.loadSpec).toBe("claude/doctor");
    expect(subs.find((s) => Array.isArray(s.name) && s.name.includes("plugins"))).toBeDefined();
    const effort = (spec.options as Fig.Option[]).find((o) => o.name === "--effort");
    expect((effort?.args as Fig.Arg).suggestions).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });
});
