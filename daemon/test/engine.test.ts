import fs from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
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
    expect(names(result).slice(0, 4)).toEqual(["Immediately execute", "build", "build:watch", "test"]);
    expect(result.items[1]).toMatchObject({ insert: "build ", description: "tsc", icon: "fig:yarn" });
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
    const real = result.items.filter((item) => item.type !== "auto-execute");
    expect(real.every((item) => item.type === "folder")).toBe(true);
    expect(names(result)).toEqual(expect.arrayContaining(["src", "docs"]));
    expect(names(result)).not.toContain("README.md");
    expect(real.find((item) => item.name === "src")?.insert).toBe("src/");
  });

  it("offers to enter a completed directory", async () => {
    const dir = tempDir("cd2");
    fs.mkdirSync(path.join(dir, "src", "lib"), { recursive: true });
    const result = await query("cd src/", dir);
    expect(result.items[0]).toMatchObject({ type: "auto-execute", description: "Enter the current directory" });
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
    expect(result.items[0].type).toBe("auto-execute");
    expect(result.items[1]).toMatchObject({ name: "main", icon: "special" });
    expect(names(result)).toContain("feature/login");
  });

  it("shows subcommand argument labels", async () => {
    const result = await query("git chec", tempDir("git2"));
    expect(result.items.find((item) => item.name === "checkout")?.args).toMatch(/branch/);
  });
});

describe("auto-execute", () => {
  it("leads with a run-as-typed row when the token matches exactly", async () => {
    const result = await query("git status", tempDir("exact"));
    expect(result.items[0]).toMatchObject({ type: "auto-execute", name: "status" });
  });
});
