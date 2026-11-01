import { execFileSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { evaluateSpecModule, SpecLoader, stockSpecDir } from "../src/specLoader.js";
import { limits } from "../src/limits.js";
import { repoRoot } from "../src/setup.js";

describe("evaluateSpecModule", () => {
  it("turns an esbuild export tail into a returned object", () => {
    const mod = evaluateSpecModule("var a={name:'x'},b=2;export{a as default,b};");
    expect(mod).toEqual({ default: { name: "x" }, b: 2 });
  });

  it("ignores files without an export tail", () => {
    expect(evaluateSpecModule("var a = 1;")).toBeUndefined();
  });
});

describe("SpecLoader", () => {
  it("keeps aws/gcloud/az out unless allowed", async () => {
    const loader = new SpecLoader([stockSpecDir()], { allowHeavy: false });
    expect(loader.names()).not.toContain("aws");
    expect(await loader.loadRoot("aws")).toBeUndefined();
  });

  it("stays within the byte budget and never evicts pinned specs", async () => {
    const budget = limits.specCacheBytes;
    limits.specCacheBytes = 4 * 1024 * 1024;
    try {
      const loader = new SpecLoader([stockSpecDir()]);
      await loader.loadRoot("git");
      for (const name of ["docker", "kubectl", "npm", "brew", "cargo", "terraform", "gh", "pnpm", "deno", "go"]) await loader.loadRoot(name);
      const stats = loader.stats();
      const unpinned = stats.loaded.filter((s) => !["git", "npm", "yarn", "cd", "npx", "node"].includes(s.name));
      expect(unpinned.reduce((sum, s) => sum + s.bytes, 0)).toBeLessThanOrEqual(limits.specCacheBytes);
      expect(stats.loaded.map((s) => s.name)).toContain("git");
    } finally {
      limits.specCacheBytes = budget;
    }
  });

  // run in a fresh process with --expose-gc so heap numbers are not polluted by the test runner
  it("returns heap to the baseline after specs are evicted", () => {
    const script = `
      import { SpecLoader, stockSpecDir } from ${JSON.stringify(path.join(repoRoot, "dist/src/specLoader.js"))};
      import { limits } from ${JSON.stringify(path.join(repoRoot, "dist/src/limits.js"))};
      const heap = () => { gc(); gc(); return process.memoryUsage().heapUsed; };
      const before = heap();
      limits.specCacheBytes = 1;
      const loader = new SpecLoader([stockSpecDir()]);
      for (const name of ["docker", "kubectl", "terraform", "gh", "brew", "cargo", "pre-commit", "ffmpeg"]) await loader.loadRoot(name);
      const after = heap();
      console.log(JSON.stringify({ deltaMB: (after - before) / 1048576 }));
    `;
    const out = execFileSync(process.execPath, ["--expose-gc", "--input-type=module", "-e", script], { cwd: repoRoot }).toString();
    const { deltaMB } = JSON.parse(out.trim().split("\n").at(-1)!);
    expect(deltaMB).toBeLessThan(2);
  });
});
