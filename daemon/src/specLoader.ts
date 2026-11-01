import fs from "node:fs";
import fsAsync from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import type { SpecProvider } from "../vendor/inshellisense/runtime/runtime.js";
import log from "../vendor/inshellisense/utils/log.js";
import { limits } from "./limits.js";
import type { Learner } from "./learn/learner.js";

// Compiled Fig specs are self-contained esbuild bundles that end in `export{a as default,...}`.
// Rewriting that tail to `return {...}` lets us evaluate them with `new Function`, so a spec is an
// ordinary object that the garbage collector can reclaim once the LRU drops it. `import()` would pin
// every spec in the ESM registry for the life of the process.
const exportTail = /export\s*\{([^}]*)\}\s*;?\s*$/;

export const evaluateSpecModule = (source: string): Record<string, unknown> | undefined => {
  const match = exportTail.exec(source);
  if (match == null) return;
  const exportsObject = match[1]
    .split(",")
    .map((binding) => binding.trim())
    .filter((binding) => binding.length > 0)
    .map((binding) => {
      const [local, exported] = binding.split(/\s+as\s+/);
      return `${JSON.stringify(exported ?? local)}: ${local}`;
    })
    .join(", ");
  const body = `"use strict";\n${source.slice(0, match.index)}\nreturn { ${exportsObject} };`;
  return new Function(body)() as Record<string, unknown>;
};

/** Specs too big to load unless explicitly allowed (aws + gcloud + az are 82% of the package). */
const heavySpecs = new Set(["aws", "gcloud", "az"]);
/** Specs used all the time; never evicted. */
const pinnedSpecs = new Set(["cd", "git", "npm", "yarn", "npx", "node"]);

/** `learned` entries came from `--help` / man pages and carry the learner's version at load time. */
type Entry = { spec: Fig.Spec; bytes: number; learned?: number };

export type SpecSource = { dir: string; names: string[]; versioned: Set<string> };

export const stockSpecDir = (): string => path.dirname(createRequire(import.meta.url).resolve("@withfig/autocomplete"));

const readIndex = (dir: string): SpecSource | undefined => {
  const indexPath = path.join(dir, "index.js");
  if (!fs.existsSync(indexPath)) return;
  const mod = evaluateSpecModule(fs.readFileSync(indexPath, "utf8"));
  const all = (mod?.default as string[] | undefined) ?? [];
  const versioned = new Set((mod?.diffVersionedCompletions as string[] | undefined) ?? []);
  return { dir, names: all, versioned };
};

export class SpecLoader implements SpecProvider {
  private readonly sources: SpecSource[];
  private readonly sortedNames: string[];
  /** Map iteration order is the LRU order: oldest first. */
  private readonly entries = new Map<string, Entry>();
  private readonly loading = new Map<string, Promise<Fig.Spec | undefined>>();
  private totalBytes = 0;
  private readonly allowHeavy: boolean;
  private readonly figNames: Set<string>;
  private learner?: Learner;
  private merged?: { from: string[]; names: string[] };

  /** @param dirs spec build directories, highest priority first (local specs before stock ones) */
  constructor(dirs: string[], options: { allowHeavy?: boolean } = {}) {
    this.allowHeavy = options.allowHeavy ?? process.env.ZDROP_HEAVY_SPECS === "1";
    this.sources = dirs.map(readIndex).filter((s): s is SpecSource => s != null);
    const names = new Set<string>();
    for (const source of this.sources) {
      for (const name of source.names) {
        if (name.includes("/") || name.startsWith("@") || name === "-") continue;
        if (!this.allowHeavy && heavySpecs.has(name)) continue;
        names.add(name);
      }
    }
    this.sortedNames = [...names].sort();
    this.figNames = names;
  }

  /** Commands without a Fig spec are learned from `--help` / man pages by `learner`. */
  setLearner(learner: Learner) {
    this.learner = learner;
  }

  hasSpec(name: string): boolean {
    return this.figNames.has(name);
  }

  /** Every completable command name: Fig specs plus everything on the requesting shell's PATH. */
  names(): string[] {
    const onPath = this.learner?.names();
    if (onPath == null) return this.sortedNames;
    if (this.merged?.from !== onPath) {
      const names: string[] = [];
      let i = 0;
      let j = 0;
      while (i < this.sortedNames.length || j < onPath.length) {
        const a = this.sortedNames[i];
        const b = onPath[j];
        if (b === undefined || (a !== undefined && a < b)) names.push(this.sortedNames[i++]);
        else if (a === undefined || b < a) names.push(onPath[j++]);
        else {
          names.push(a);
          i++;
          j++;
        }
      }
      this.merged = { from: onPath, names };
    }
    return this.merged.names;
  }

  describe(name: string): string | undefined {
    return this.learner?.describe(name);
  }

  // shared by every request that needs this spec, so one request's abort must not cancel the read
  async loadRoot(name: string): Promise<Fig.Spec | undefined> {
    // learned specs are cached by what the name resolves to (a project's own `eslint` differs per repo)
    const isFig = this.figNames.has(name);
    const cacheKey = isFig ? name : this.learner?.keyFor(name);
    if (cacheKey == null) return;
    const cached = this.entries.get(cacheKey);
    if (cached != null && (cached.learned == null || cached.learned === this.learner?.version(cacheKey))) {
      this.entries.delete(cacheKey);
      this.entries.set(cacheKey, cached);
      if (cached.learned != null) void this.learner?.check(name);
      return cached.spec;
    }
    if (cached != null) this.drop(cacheKey);
    if (!this.allowHeavy && heavySpecs.has(name)) return;
    if (!isFig) return this.loadLearned(name, cacheKey);

    const inFlight = this.loading.get(name);
    if (inFlight != null) return inFlight;
    const load = this.read(name)
      .then((loaded) => {
        if (loaded == null) return;
        this.entries.set(name, { spec: loaded.spec, bytes: loaded.bytes });
        this.totalBytes += loaded.bytes;
        this.evict(name);
        return loaded.spec;
      })
      .finally(() => this.loading.delete(name));
    this.loading.set(name, load);
    return load;
  }

  // Specs reached through `loadSpec: "aws/ec2"` are merged into their root spec by the runtime, so their
  // memory lives and dies with the root entry; we only add their size to it.
  async loadPath(specPath: string, signal?: AbortSignal): Promise<Fig.Spec | undefined> {
    const root = specPath.split("/")[0];
    if (!this.allowHeavy && heavySpecs.has(root)) return;
    const isFig = this.figNames.has(root);
    const loaded = isFig ? await this.read(specPath, signal) : await this.learnedPath(specPath);
    if (loaded == null) return;
    const rootKey = isFig ? root : this.learner?.keyFor(decodeURIComponent(root));
    const rootEntry = rootKey == null ? undefined : this.entries.get(rootKey);
    if (rootEntry != null) {
      rootEntry.bytes += loaded.bytes;
      this.totalBytes += loaded.bytes;
      this.evict(rootKey!);
    }
    return loaded.spec;
  }

  stats() {
    return {
      totalBytes: this.totalBytes,
      budgetBytes: limits.specCacheBytes,
      loaded: [...this.entries].map(([name, entry]) => ({ name, bytes: entry.bytes })),
    };
  }

  private async read(specPath: string, signal?: AbortSignal): Promise<{ spec: Fig.Spec; bytes: number } | undefined> {
    for (const source of this.sources) {
      const file = source.versioned.has(specPath) ? undefined : path.join(source.dir, `${specPath}.js`);
      if (file == null || !file.startsWith(source.dir + path.sep)) continue;
      let text: string;
      try {
        text = await fsAsync.readFile(file, "utf8");
      } catch {
        continue;
      }
      signal?.throwIfAborted();
      try {
        const spec = evaluateSpecModule(text)?.default as Fig.Spec | undefined;
        if (spec == null) return;
        return { spec, bytes: text.length * limits.specHeapFactor };
      } catch (e) {
        log.debug({ msg: "failed to evaluate spec", specPath, e: (e as Error).message });
        return;
      }
    }
  }

  private async loadLearned(name: string, cacheKey: string): Promise<Fig.Spec | undefined> {
    if (this.learner == null) return;
    const spec = await this.learner.root(name);
    if (spec == null) return;
    const version = this.learner.version(cacheKey);
    const bytes = JSON.stringify(spec).length * limits.specHeapFactor;
    if (this.entries.has(cacheKey)) this.drop(cacheKey);
    this.entries.set(cacheKey, { spec, bytes, learned: version });
    this.totalBytes += bytes;
    this.evict(cacheKey);
    return spec;
  }

  private async learnedPath(specPath: string): Promise<{ spec: Fig.Spec; bytes: number } | undefined> {
    const spec = await this.learner?.node(specPath);
    return spec == null ? undefined : { spec, bytes: JSON.stringify(spec).length * limits.specHeapFactor };
  }

  private drop(name: string) {
    const entry = this.entries.get(name);
    if (entry == null) return;
    this.entries.delete(name);
    this.totalBytes -= entry.bytes;
  }

  private evict(keep: string) {
    for (const [name, entry] of this.entries) {
      if (this.totalBytes <= limits.specCacheBytes) break;
      if (name === keep || pinnedSpecs.has(name)) continue;
      this.entries.delete(name);
      this.totalBytes -= entry.bytes;
      log.debug({ msg: "evicted spec", name, bytes: entry.bytes });
    }
  }
}
