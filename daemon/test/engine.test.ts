import fs from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { ShellNames, shellNames } from "../vendor/inshellisense/runtime/alias.js";
import { editDistance } from "../src/rank/typo.js";
import { initRuntime } from "../src/setup.js";
import { git, names, query, tempDir, writeJson } from "./helpers.js";

beforeAll(() => {
  initRuntime();
});

describe("yarn", () => {
  const app = tempDir("app");
  writeJson(path.join(app, "package.json"), { name: "app", scripts: { build: "tsc", "build:watch": "tsc -w", test: "vitest" } });

  it("lists package.json scripts first after `yarn `", async () => {
    const result = await query("yarn ", app);
    expect(names(result).slice(0, 3)).toEqual(["build", "build:watch", "test"]);
    expect(result.items[0]).toMatchObject({ insert: "build ", description: "tsc", icon: "fig:yarn" });
  });

  it("filters scripts by the typed prefix and reports what to replace", async () => {
    const result = await query("yarn b", app);
    expect(names(result)).toContain("build");
    expect(names(result)).toContain("build:watch");
    expect(result.replaceLen).toBe(1);
    expect(result.items.find((item) => item.name === "build")?.matchIndices).toEqual([0]);
  });

  it("completes scripts of a workspace in a monorepo", async () => {
    const repo = tempDir("mono");
    writeJson(path.join(repo, "package.json"), { name: "root", private: true, workspaces: ["packages/*"] });
    writeJson(path.join(repo, "packages", "web", "package.json"), { name: "web", scripts: { dev: "vite" } });
    const result = await query("yarn run ", path.join(repo, "packages", "web"));
    expect(names(result)).toContain("dev");
  });
});

describe("cd", () => {
  it("suggests only folders", async () => {
    const dir = tempDir("cd");
    fs.mkdirSync(path.join(dir, "src"));
    fs.mkdirSync(path.join(dir, "docs"));
    fs.writeFileSync(path.join(dir, "README.md"), "");
    const result = await query("cd ", dir);
    const real = result.items;
    expect(real.every((item) => item.type === "folder")).toBe(true);
    expect(names(result)).toEqual(expect.arrayContaining(["src", "docs"]));
    expect(names(result)).not.toContain("README.md");
    expect(real.find((item) => item.name === "src")?.insert).toBe("src/");
  });

  it("lists the children of a completed directory", async () => {
    const dir = tempDir("cd2");
    fs.mkdirSync(path.join(dir, "src", "lib"), { recursive: true });
    const result = await query("cd src/", dir);
    expect(names(result)).toContain("lib");
  });
});

describe("git", () => {
  it("lists branches with the current one first", async () => {
    const repo = tempDir("git");
    git(repo, "init", "-q");
    git(repo, "commit", "-q", "--allow-empty", "-m", "init");
    git(repo, "branch", "feature/login");
    const result = await query("git checkout ", repo);
    expect(result.items[0]).toMatchObject({ name: "main", icon: "special" });
    expect(names(result)).toContain("feature/login");
  });

  it("shows subcommand argument labels", async () => {
    const result = await query("git chec", tempDir("git2"));
    expect(result.items.find((item) => item.name === "checkout")?.args).toMatch(/branch/);
  });
});

describe("no run-as-typed rows", () => {
  it("never adds an auto-execute row (Enter runs the line until you move into the list)", async () => {
    for (const line of ["git status", "git ", "yarn "]) {
      const result = await query(line, tempDir("exact"));
      expect(result.items.some((item) => item.type === "auto-execute")).toBe(false);
    }
  });
});

describe("aliases and functions", () => {
  const shell = (aliases: Record<string, string>, functions: string[] = []) => {
    const names = new ShellNames();
    names.setAliases(aliases);
    names.setFunctions(functions, ["echo", "if"]);
    return names;
  };

  it("completes through nested aliases and shows what an alias stands for", async () => {
    const names = shell({ g: "git", gco: "g checkout", ls: "ls -G" });
    const result = await shellNames.run(names, () => query("g ch", "/"));
    expect(result.items.map((i) => i.name)).toContain("checkout");
    const nested = await shellNames.run(names, () => query("gco -", "/"));
    expect(nested.items.length).toBeGreaterThan(0);
    // a self-referencing alias expands once instead of looping
    const self = await shellNames.run(names, () => query("ls -", "/"));
    expect(self.items.length).toBeGreaterThan(0);
    const first = await shellNames.run(names, () => query("gc", "/"));
    expect(first.items.find((i) => i.name === "gco")).toMatchObject({ description: "→ g checkout", icon: "shortcut" });
  });

  it("keeps each shell's names apart and suggests functions as commands", async () => {
    const a = shell({ zz: "git" }, ["zzdeploy"]);
    const b = shell({});
    const inA = await shellNames.run(a, () => query("zz", "/"));
    expect(inA.items.map((i) => i.name)).toEqual(expect.arrayContaining(["zz", "zzdeploy"]));
    expect(inA.items.find((i) => i.name === "zzdeploy")).toMatchObject({ icon: "function", description: "shell function" });
    const inB = await shellNames.run(b, () => query("zz", "/"));
    expect(inB.items.map((i) => i.name)).not.toContain("zzdeploy");
    expect(a.knows("echo") && a.knows("if") && a.knows("zz") && !b.knows("zz")).toBe(true);
  });
});

describe("typo fix", () => {
  it("offers the closest command for an unknown command word, as a whole-line replacement", async () => {
    const result = await query("gti status ", "/");
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ name: "git", insert: "git status ", type: "typo", icon: "typo" });
    expect(result.replaceLen).toBe("gti status ".length);
    const chained = await query("cd /tmp && FOO=1 yran build", "/");
    expect(chained.items[0]?.insert).toBe("cd /tmp && FOO=1 yarn build");
  });

  it("leaves known commands, paths, unfinished words and far-off words alone", async () => {
    for (const line of ["git status ", "./gti x", "gti", "qqqqqqzz x", "x"]) {
      const result = await query(line, "/");
      expect(result.items.filter((i) => i.type === "typo"), line).toEqual([]);
    }
    // a shell's own alias or function is a command
    const names = new ShellNames();
    names.setAliases({ gti: "git" });
    const aliased = await shellNames.run(names, () => query("gti status ", "/"));
    expect(aliased.items.filter((i) => i.type === "typo")).toEqual([]);
    // zsh's CORRECT option does it instead
    const correcting = new ShellNames();
    correcting.setFunctions([], [], true);
    const corrected = await shellNames.run(correcting, () => query("gti status ", "/"));
    expect(corrected.items.filter((i) => i.type === "typo")).toEqual([]);
  });

  it("counts a swap of neighbouring letters as one edit", () => {
    expect(editDistance("gti", "git", 1)).toBe(1);
    expect(editDistance("yran", "yarn", 1)).toBe(1);
    expect(editDistance("dokcer", "docker", 2)).toBe(1);
    expect(editDistance("abc", "xyz", 1)).toBe(2);
  });
});
