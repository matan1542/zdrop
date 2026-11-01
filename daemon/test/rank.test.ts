import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { DirFrecency, dirs } from "../src/rank/dirs.js";
import { UsageIndex, usage } from "../src/rank/usage.js";
import { initRuntime } from "../src/setup.js";
import { names, query, tempDir } from "./helpers.js";

const now = () => Date.now() / 1000;

beforeAll(() => {
  initRuntime();
});

describe("usage index", () => {
  it("scores children by context, recent use counting more", () => {
    const index = new UsageIndex();
    index.record("git commit -m 'one'", now() - 200 * 86_400);
    index.record("git commit -m 'two'", now() - 200 * 86_400);
    index.record("git checkout main");
    expect(index.score(["git"], "checkout")).toBeGreaterThan(index.score(["git"], "commit"));
    expect(index.score([], "git")).toBeGreaterThan(0);
    expect(index.score(["git", "commit"], "-m")).toBeGreaterThan(0);
  });

  it("remembers flag values and positional words, but not secrets", () => {
    const index = new UsageIndex();
    index.record("kubectl get pods -n prod");
    index.record("kubectl get pods -n prod");
    index.record("kubectl get pods -n staging");
    index.record("deploy --token=abc123 --env=prod");
    index.record("login --password hunter2");
    expect(index.values(["kubectl", "get", "pods", "-n"], "", 5).map((h) => [h.name, h.count])).toEqual([
      ["prod", 2],
      ["staging", 1],
    ]);
    expect(index.values(["kubectl", "get", "pods", "-n"], "st", 5).map((h) => h.name)).toEqual(["staging"]);
    expect(index.values(["deploy", "--env"], "", 5).map((h) => h.name)).toEqual(["prod"]);
    expect(index.values(["deploy", "--token"], "", 5)).toEqual([]);
    expect(index.values(["login", "--password"], "", 5)).toEqual([]);
  });

  it("splits chained commands and stays within its caps", () => {
    const index = new UsageIndex();
    index.record("yarn build && git push | cat");
    expect(index.score([], "yarn")).toBeGreaterThan(0);
    expect(index.score([], "git")).toBeGreaterThan(0);
    for (let i = 0; i < 40_000; i++) index.record(`tool${i % 5000} sub${i} --flag v${i}`);
    expect(index.stats().children).toBeLessThanOrEqual(16_500);
    expect(index.stats().contexts).toBeLessThanOrEqual(2_000);
  });

  it("reads zsh extended history, including continued lines", async () => {
    const file = path.join(tempDir("hist"), "history");
    fs.writeFileSync(file, `: ${Math.round(now())}:0;npm run build\n: ${Math.round(now())}:0;echo a \\\nb\nnpm test\n`);
    const index = new UsageIndex();
    await index.loadHistory(file);
    expect(index.score(["npm"], "run")).toBeGreaterThan(0);
    expect(index.score(["npm"], "test")).toBeGreaterThan(0);
    expect(index.score([], "b")).toBe(0);
  });
});

describe("ranking suggestions", () => {
  it("puts what you use first among prefix matches", async () => {
    const cwd = tempDir("rank");
    expect(names(await query("git ch", cwd)).slice(0, 2)).toEqual(["checkout", "cherry-pick"]);
    for (let i = 0; i < 3; i++) usage.record("git cherry-pick abc123");
    expect(names(await query("git ch", cwd))[0]).toBe("cherry-pick");
  });

  it("offers values typed before where the spec has none", async () => {
    usage.record('git commit -m "fix the typo"');
    const result = await query("git commit -m ", tempDir("rank2"));
    const item = result.items.find((i) => i.type === "history");
    expect(item).toMatchObject({ name: "fix the typo", insert: "'fix the typo' ", icon: "history", description: "used 1×" });
  });

  it("ranks first words by use", async () => {
    for (let i = 0; i < 5; i++) usage.record("lsof -i :3000");
    expect(names(await query("ls", tempDir("rank3")))[0]).toBe("lsof");
  });
});

describe("directory frecency", () => {
  it("ranks by visits and recency, ages, and forgets missing directories", () => {
    const base = tempDir("frec");
    const [a, b, gone] = ["alpha", "beta", "gone"].map((d) => path.join(base, d));
    for (const d of [a, b, gone]) fs.mkdirSync(d);
    const file = path.join(base, "dirs.tsv");
    const frecency = new DirFrecency(file);
    frecency.visit(a, Date.now() - 30 * 86_400_000);
    frecency.visit(a, Date.now() - 30 * 86_400_000);
    frecency.visit(b);
    frecency.visit(gone);
    fs.rmdirSync(gone);
    expect(frecency.top(5).map((h) => path.basename(h.dir))).toEqual(["beta", "alpha"]);
    expect(frecency.top(5, "alp").map((h) => path.basename(h.dir))).toEqual(["alpha"]);
    frecency.flush();
    expect(new DirFrecency(file).top(5).map((h) => path.basename(h.dir))).toEqual(["beta", "alpha"]);
  });

  it("cd offers frecent directories: top ones first, matching ones after the children", async () => {
    const base = tempDir("cdfrec");
    const project = path.join(base, "work", "zdrop-project");
    fs.mkdirSync(project, { recursive: true });
    const here = tempDir("cdhere");
    fs.mkdirSync(path.join(here, "src"));
    dirs.visit(project);
    dirs.visit(project);

    const empty = await query("cd ", here);
    expect(empty.items[0]).toMatchObject({ icon: "frecent", type: "folder" });
    expect(empty.items[0].name).toBe("…/work/zdrop-project/");
    expect(empty.items[0].description).toBe(project + "/");
    expect(names(empty)).toContain("src");

    const typed = await query("cd zdrp", here);
    expect(typed.items.find((i) => i.icon === "frecent")?.insert).toBe(project.replace(/([\s'"\\$`!&|;<>()*?[\]{}#])/g, "\\$1") + "/");
    expect(os.homedir()).toBeTruthy();
  });
});
