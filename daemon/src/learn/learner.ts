import { generationMode } from "../../vendor/inshellisense/runtime/generatorCache.js";
import log from "../../vendor/inshellisense/utils/log.js";
import { childSlots, Semaphore } from "../limits.js";
import { CommandIndex } from "./commandIndex.js";
import { learnConfig } from "./config.js";
import { currentEnv } from "./context.js";
import { toFigSpec, type HelpTree } from "./figSpec.js";
import { gate, type GateDecision } from "./gate.js";
import type { HelpCommand } from "./helpParser.js";
import { probeCommand, probeHelp } from "./prober.js";
import { createSandbox, type Sandbox } from "./sandbox.js";
import { fileKey, freshness, LearnedStore, newLearnedFile, type FileKey, type LearnedFile } from "./store.js";

// On-demand learning inside the daemon: when a command without a Fig spec is typed, read its
// `--help` (sandboxed) or man page, cache the result on disk, and hand the runtime a Fig spec. While
// the probe runs, the fast pass reports it as pending so the popup shows a loading state. Bulk
// learning of everything on PATH happens in a separate low-priority process (builder.ts / worker.ts).

const prefixMatches = (sorted: string[], prefix: string): string[] => {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (sorted[middle] < prefix) low = middle + 1;
    else high = middle;
  }
  const out: string[] = [];
  for (let i = low; i < sorted.length && sorted[i].startsWith(prefix) && out.length < 16; i++) out.push(sorted[i]);
  return out;
};

/** The listing of `path`'s last word in its parent node (keeps aliases and the parent's description). */
const listedEntry = (nodes: HelpTree, path: string): HelpCommand | undefined => {
  const parts = path.split("/");
  const parent = nodes[parts.slice(0, -1).join("/")];
  return parent?.subcommands.find((c) => c.names.includes(parts.at(-1)!));
};

export type LearnerOptions = {
  hasFigSpec: (name: string) => boolean;
  store?: LearnedStore;
  index?: CommandIndex;
};

export class Learner {
  readonly store: LearnedStore;
  readonly index: CommandIndex;
  private readonly hasFigSpec: (name: string) => boolean;
  private readonly lane = new Semaphore(learnConfig.interactiveConcurrency);
  private readonly inFlight = new Map<string, Promise<LearnedFile | undefined>>();
  /** bumped whenever a command's learned file changes, so cached specs know to reload */
  private readonly versions = new Map<string, number>();
  private readonly keys = new Map<string, { key: FileKey; checkedAt: number }>();
  private sandbox?: Sandbox;
  private probes = 0;

  constructor(options: LearnerOptions) {
    this.hasFigSpec = options.hasFigSpec;
    this.store = options.store ?? new LearnedStore();
    this.index = options.index ?? new CommandIndex(learnConfig.recheckMs);
  }

  /** Commands on the requesting shell's PATH (sorted). */
  names(): string[] {
    return this.index.names(currentEnv().path);
  }

  describe(name: string): string | undefined {
    return this.store.descriptions.get(name);
  }

  version(name: string): number {
    return this.versions.get(name) ?? 0;
  }

  /** Marks commands changed by someone else (the background worker) so cached specs reload. */
  changed(names: Iterable<string>) {
    for (const name of names) this.versions.set(name, this.version(name) + 1);
  }

  /** Spec for a command with no Fig spec, learning it first if needed. */
  async root(name: string): Promise<Fig.Spec | undefined> {
    if (!learnConfig.enabled || this.hasFigSpec(name)) return;
    const file = this.index.resolve(name, currentEnv().path);
    if (file == null) return;
    const key = await fileKey(file);
    if (key == null) return;
    this.keys.set(name, { key, checkedAt: Date.now() });

    const learned = await this.store.read(name);
    if (learned != null) {
      const state = freshness(learned, key);
      if (learned.status === "ok") {
        // stale-while-revalidate: answer now, re-learn behind it
        if (state === "stale") void this.learn(name, file, key, learned).catch(() => undefined);
        return toFigSpec(name, learned.nodes);
      }
      if (state === "wait") return;
    }

    const learning = this.learn(name, file, key, learned);
    if (this.deferToPending(learning, `${name} --help`)) return;
    const result = await learning;
    return result?.status === "ok" ? toFigSpec(name, result.nodes) : undefined;
  }

  /** Spec for a learned command's subcommand, e.g. "claude/mcp" (reached through `loadSpec`). */
  async node(specPath: string): Promise<Fig.Spec | undefined> {
    const [name, ...words] = specPath.split("/");
    const sub = words.join("/");
    if (!learnConfig.enabled || sub.length === 0) return;
    const learned = await this.store.read(name);
    if (learned == null || learned.status !== "ok") return;
    if (learned.nodes[sub] != null) return toFigSpec(name, learned.nodes, sub, listedEntry(learned.nodes, sub));
    const missedAt = learned.missing[sub];
    if (learned.source === "man" || (missedAt != null && Date.now() - missedAt < learnConfig.missBackoffMs[0])) return;
    const file = this.index.resolve(name, currentEnv().path);
    if (file == null) return;

    const learning = this.learnSubcommand(name, file, words);
    if (this.deferToPending(learning, `${name} ${words.join(" ")} --help`)) return;
    const updated = await learning;
    return updated?.nodes[sub] != null ? toFigSpec(name, updated.nodes, sub, listedEntry(updated.nodes, sub)) : undefined;
  }

  /** Re-checks the binary behind a cached spec (at most every recheckMs); a change bumps its version. */
  async check(name: string): Promise<void> {
    const known = this.keys.get(name);
    if (known == null || Date.now() - known.checkedAt < learnConfig.recheckMs) return;
    known.checkedAt = Date.now();
    const file = this.index.resolve(name, currentEnv().path);
    const key = file ? await fileKey(file) : undefined;
    if (key == null || JSON.stringify(key) !== JSON.stringify(known.key)) {
      this.keys.delete(name);
      this.changed([name]);
    }
  }

  /**
   * Called after the user paused typing. Warms the spec they are most likely to need next: the only
   * (or exactly matching) unlearned command for a partial first word, or the only matching
   * subcommand for a partial later word.
   */
  prefetch(lbuffer: string): void {
    if (!learnConfig.enabled) return;
    const line = lbuffer.replace(/^\s+/, "");
    const words = line.split(/\s+/);
    const complete = /\s$/.test(line);
    if (complete) words.pop();
    if (words.length === 0 || words[0].length < 2) return;

    if (words.length === 1 && !complete) {
      const candidates = prefixMatches(this.names(), words[0]).filter((n) => !this.hasFigSpec(n) && !this.store.descriptions.has(n));
      const target = candidates.includes(words[0]) ? words[0] : candidates.length === 1 ? candidates[0] : undefined;
      if (target) void this.root(target).catch(() => undefined);
      return;
    }
    void this.prefetchSubcommand(words, complete).catch(() => undefined);
  }

  /** Gate decision, learned state and freshness of one command (for `zdrop why`). */
  async why(name: string) {
    const file = this.index.resolve(name, currentEnv().path);
    if (this.hasFigSpec(name)) return { name, source: "fig spec" };
    if (file == null) return { name, onPath: false };
    const key = await fileKey(file);
    const decision: GateDecision = await gate(name, file, true);
    const learned = await this.store.read(name);
    return {
      name,
      file,
      realpath: key?.realpath,
      gate: decision,
      learned: learned && {
        status: learned.status,
        source: learned.source,
        freshness: key ? freshness(learned, key) : "unknown",
        probedAt: new Date(learned.probedAt).toISOString(),
        subcommandsLearned: Object.keys(learned.nodes).filter((k) => k !== "").length,
        options: learned.nodes[""]?.options.length ?? 0,
        subcommands: learned.nodes[""]?.subcommands.length ?? 0,
      },
    };
  }

  /** Learns `name` (and optionally a subcommand path) now, ignoring caches. */
  async learnNow(name: string, words: string[] = []): Promise<LearnedFile | undefined> {
    const file = this.index.resolve(name, currentEnv().path);
    if (file == null) return;
    const key = await fileKey(file);
    if (key == null) return;
    const learned = await this.learn(name, file, key, undefined);
    if (learned?.status !== "ok" || words.length === 0) return learned;
    return this.learnSubcommand(name, file, words);
  }

  stats() {
    return { ...this.store.stats(), probes: this.probes, inFlight: this.inFlight.size, index: this.index.stats() };
  }

  dispose() {
    this.sandbox?.dispose();
  }

  // -------------------------------------------------------------------------------------------

  /** In the fast pass, record `learning` as pending (loading state) instead of waiting for it. */
  private deferToPending(learning: Promise<unknown>, label: string): boolean {
    const context = generationMode.getStore();
    if (!context?.fast) return false;
    context.pending.push(learning.catch(() => undefined));
    context.labels?.push(label);
    return true;
  }

  private getSandbox(): Sandbox {
    this.sandbox ??= createSandbox();
    return this.sandbox;
  }

  private async withSlot<T>(task: () => Promise<T>): Promise<T> {
    const releaseLane = await this.lane.acquire();
    const releaseChild = await childSlots.acquire();
    try {
      this.probes++;
      return await task();
    } finally {
      releaseChild();
      releaseLane();
    }
  }

  private learn(name: string, file: string, key: FileKey, previous: LearnedFile | undefined): Promise<LearnedFile | undefined> {
    const existing = this.inFlight.get(name);
    if (existing) return existing;
    const shellPath = currentEnv().path;
    const learning = (async () => {
      const decision = await gate(name, file, true);
      if (decision.action === "skip") {
        if (!learnConfig.enabled) return;
        const skipped = newLearnedFile(name, key, "help", undefined, "miss", previous);
        await this.store.write(skipped);
        return skipped;
      }
      const outcome = await this.withSlot(() => probeCommand(name, file, decision.action as "probe" | "man", { sandbox: this.getSandbox(), shellPath, background: false }));
      if (outcome.status === "interrupted") return;
      const learned = newLearnedFile(name, key, outcome.source, outcome.status === "ok" ? outcome.node : undefined, outcome.status, previous);
      await this.store.write(learned);
      this.changed([name]);
      return learned;
    })()
      .catch((e) => {
        log.debug({ msg: "learning failed", name, e: (e as Error).message });
        return undefined;
      })
      .finally(() => this.inFlight.delete(name));
    this.inFlight.set(name, learning);
    return learning;
  }

  private learnSubcommand(name: string, file: string, words: string[]): Promise<LearnedFile | undefined> {
    const sub = words.join("/");
    const flightKey = `${name}/${sub}`;
    const existing = this.inFlight.get(flightKey);
    if (existing) return existing;
    const shellPath = currentEnv().path;
    const learning = (async () => {
      const outcome = await this.withSlot(() => probeHelp(file, [name, ...words], { sandbox: this.getSandbox(), shellPath, background: false }));
      if (outcome.status === "interrupted") return;
      // re-read: the root may have been rewritten while the probe ran
      const learned = await this.store.read(name);
      if (learned == null || learned.status !== "ok") return;
      if (outcome.status === "ok") learned.nodes[sub] = outcome.node;
      else learned.missing[sub] = Date.now();
      await this.store.write(learned);
      this.changed([name]);
      return learned;
    })()
      .catch((e) => {
        log.debug({ msg: "learning subcommand failed", name, sub, e: (e as Error).message });
        return undefined;
      })
      .finally(() => this.inFlight.delete(flightKey));
    this.inFlight.set(flightKey, learning);
    return learning;
  }

  private async prefetchSubcommand(words: string[], complete: boolean): Promise<void> {
    const [name, ...rest] = words;
    if (this.hasFigSpec(name)) return;
    const learned = await this.store.read(name);
    if (learned == null || learned.status !== "ok" || learned.source !== "help") return;
    let path = "";
    const partial = complete ? undefined : rest.pop();
    for (const word of rest) {
      if (word.startsWith("-")) continue;
      const child = learned.nodes[path]?.subcommands.find((c) => c.names.includes(word));
      if (child == null) return;
      path = path ? `${path}/${child.names[0]}` : child.names[0];
    }
    const children = learned.nodes[path]?.subcommands ?? [];
    const matches = partial == null ? [] : children.filter((c) => c.names.some((n) => n.startsWith(partial)));
    const target = matches.length === 1 ? matches[0] : children.find((c) => partial != null && c.names.includes(partial));
    if (target == null) return;
    const targetPath = path ? `${path}/${target.names[0]}` : target.names[0];
    if (learned.nodes[targetPath] == null) await this.node(`${name}/${targetPath}`);
  }
}
