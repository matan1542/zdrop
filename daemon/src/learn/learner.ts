import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
//
// Besides PATH, commands resolve to a project's own tools: `node_modules/.bin` up from the cwd (what
// `npx x`, `yarn x`, `pnpm exec x` and `bunx x` run) and explicit paths like `./scripts/deploy.sh`.
// Those are cached per real path (`eslint@1a2b3c4d`), so the same name in two repos never mixes.

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

/** A command as typed, resolved to what would run. */
type Resolved = {
  /** as typed: `claude`, `eslint`, `./scripts/deploy.sh` */
  name: string;
  /** program name for gating and parsing help: `deploy.sh` */
  base: string;
  file: string;
  /** cache key: the name for PATH commands, `<base>@<hash of real path>` for project-local ones */
  key: string;
};

const maxWalkUp = 12;

const isExecutable = (file: string): boolean => {
  try {
    const stat = fs.statSync(file);
    return stat.isFile() && (stat.mode & 0o111) !== 0;
  } catch {
    return false;
  }
};

const localKey = (base: string, file: string): string => {
  let real = file;
  try {
    real = fs.realpathSync(file);
  } catch {
    // keep the path as given
  }
  return `${base}@${createHash("sha1").update(real).digest("hex").slice(0, 8)}`;
};

/** `node_modules/.bin/<name>` in the cwd or any parent, nearest first. */
const findLocalBin = (name: string, cwd: string): string | undefined => {
  let dir = cwd;
  for (let i = 0; i < maxWalkUp; i++) {
    const candidate = path.join(dir, "node_modules", ".bin", name);
    if (isExecutable(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return;
    dir = parent;
  }
  return;
};

/** loadSpec paths carry the command first; a path command (`./x.sh`) is encoded so `/` still splits */
const specPathOf = (name: string, sub: string) => `${encodeURIComponent(name)}/${sub}`;

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
  /** bumped whenever a command's learned file changes, so cached specs know to reload (by cache key) */
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

  /** The cache key `name` resolves to from the requesting shell (undefined: not a runnable command). */
  keyFor(name: string): string | undefined {
    return this.resolve(name)?.key;
  }

  version(key: string): number {
    return this.versions.get(key) ?? 0;
  }

  /** Marks commands changed by someone else (the background worker) so cached specs reload. */
  changed(keys: Iterable<string>) {
    for (const key of keys) this.versions.set(key, this.version(key) + 1);
  }

  /** Spec for a command with no Fig spec, learning it first if needed. */
  async root(name: string): Promise<Fig.Spec | undefined> {
    if (!learnConfig.enabled || this.hasFigSpec(name)) return;
    const cmd = this.resolve(name);
    if (cmd == null) return;
    const key = await fileKey(cmd.file);
    if (key == null) return;
    this.keys.set(cmd.key, { key, checkedAt: Date.now() });

    const learned = await this.store.read(cmd.key);
    if (learned != null) {
      const state = freshness(learned, key);
      if (learned.status === "ok") {
        // stale-while-revalidate: answer now, re-learn behind it
        if (state === "stale") void this.learn(cmd, key, learned).catch(() => undefined);
        return this.spec(cmd, learned);
      }
      if (state === "wait") return;
    }

    const learning = this.learn(cmd, key, learned);
    if (this.deferToPending(learning, `${cmd.base} --help`)) return;
    const result = await learning;
    return result?.status === "ok" ? this.spec(cmd, result) : undefined;
  }

  /** Spec for a learned command's subcommand, e.g. "claude/mcp" (reached through `loadSpec`). */
  async node(specPath: string): Promise<Fig.Spec | undefined> {
    const [encoded, ...words] = specPath.split("/");
    const sub = words.join("/");
    if (!learnConfig.enabled || sub.length === 0) return;
    const cmd = this.resolve(decodeURIComponent(encoded));
    if (cmd == null) return;
    const learned = await this.store.read(cmd.key);
    if (learned == null || learned.status !== "ok") return;
    if (learned.nodes[sub] != null) return this.spec(cmd, learned, sub);
    const missedAt = learned.missing[sub];
    if (learned.source === "man" || (missedAt != null && Date.now() - missedAt < learnConfig.missBackoffMs[0])) return;

    const learning = this.learnSubcommand(cmd, words);
    if (this.deferToPending(learning, `${cmd.base} ${words.join(" ")} --help`)) return;
    const updated = await learning;
    return updated?.nodes[sub] != null ? this.spec(cmd, updated, sub) : undefined;
  }

  /** Re-checks the binary behind a cached spec (at most every recheckMs); a change bumps its version. */
  async check(name: string): Promise<void> {
    const cmd = this.resolve(name);
    if (cmd == null) return;
    const known = this.keys.get(cmd.key);
    if (known == null || Date.now() - known.checkedAt < learnConfig.recheckMs) return;
    known.checkedAt = Date.now();
    const key = await fileKey(cmd.file);
    if (key == null || JSON.stringify(key) !== JSON.stringify(known.key)) {
      this.keys.delete(cmd.key);
      this.changed([cmd.key]);
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
    if (this.hasFigSpec(name)) return { name, source: "fig spec" };
    const cmd = this.resolve(name);
    if (cmd == null) return { name, found: false };
    const key = await fileKey(cmd.file);
    const decision: GateDecision = await gate(cmd.base, cmd.file, true);
    const learned = await this.store.read(cmd.key);
    return {
      name,
      file: cmd.file,
      realpath: key?.realpath,
      cacheKey: cmd.key,
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
    const cmd = this.resolve(name);
    if (cmd == null) return;
    const key = await fileKey(cmd.file);
    if (key == null) return;
    const learned = await this.learn(cmd, key, undefined);
    if (learned?.status !== "ok" || words.length === 0) return learned;
    return this.learnSubcommand(cmd, words);
  }

  stats() {
    return { ...this.store.stats(), probes: this.probes, inFlight: this.inFlight.size, index: this.index.stats() };
  }

  dispose() {
    this.sandbox?.dispose();
  }

  // -------------------------------------------------------------------------------------------

  /** PATH first (what zsh runs), then the project's node_modules/.bin; explicit paths against the cwd. */
  private resolve(name: string): Resolved | undefined {
    const env = currentEnv();
    const cwd = env.cwd ?? process.cwd();
    if (name.includes("/")) {
      const file = path.resolve(cwd, name.replace(/^~(?=\/)/, os.homedir()));
      if (!isExecutable(file)) return;
      const base = path.basename(file);
      return { name, base, file, key: localKey(base, file) };
    }
    const onPath = this.index.resolve(name, env.path);
    if (onPath != null) return { name, base: name, file: onPath, key: name };
    const local = findLocalBin(name, cwd);
    return local == null ? undefined : { name, base: name, file: local, key: localKey(name, local) };
  }

  private spec(cmd: Resolved, learned: LearnedFile, sub = ""): Fig.Subcommand {
    const nodes = learned.nodes;
    const native = learned.protocol ? { protocol: learned.protocol, file: cmd.file, base: cmd.base } : undefined;
    const spec = toFigSpec(encodeURIComponent(cmd.name), nodes, sub, sub ? listedEntry(nodes, sub) : undefined, native);
    if (!sub) spec.name = cmd.name;
    return spec;
  }

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

  private learn(cmd: Resolved, key: FileKey, previous: LearnedFile | undefined): Promise<LearnedFile | undefined> {
    const existing = this.inFlight.get(cmd.key);
    if (existing) return existing;
    const shellPath = currentEnv().path;
    const learning = (async () => {
      const decision = await gate(cmd.base, cmd.file, true);
      if (decision.action === "skip") {
        if (!learnConfig.enabled) return;
        const skipped = newLearnedFile(cmd.key, key, "help", undefined, "miss", previous);
        await this.store.write(skipped);
        return skipped;
      }
      const action = decision.action as "probe" | "man";
      const outcome = await this.withSlot(() => probeCommand(cmd.base, cmd.file, action, { sandbox: this.getSandbox(), shellPath, background: false }));
      if (outcome.status === "interrupted") return;
      const learned = newLearnedFile(
        cmd.key,
        key,
        outcome.source,
        outcome.status === "ok" ? outcome.node : undefined,
        outcome.status,
        previous,
        outcome.status === "ok" ? outcome.protocol : undefined,
      );
      await this.store.write(learned);
      this.changed([cmd.key]);
      return learned;
    })()
      .catch((e) => {
        log.debug({ msg: "learning failed", name: cmd.name, e: (e as Error).message });
        return undefined;
      })
      .finally(() => this.inFlight.delete(cmd.key));
    this.inFlight.set(cmd.key, learning);
    return learning;
  }

  private learnSubcommand(cmd: Resolved, words: string[]): Promise<LearnedFile | undefined> {
    const sub = words.join("/");
    const flightKey = `${cmd.key}/${sub}`;
    const existing = this.inFlight.get(flightKey);
    if (existing) return existing;
    const shellPath = currentEnv().path;
    const learning = (async () => {
      const outcome = await this.withSlot(() => probeHelp(cmd.file, [cmd.base, ...words], { sandbox: this.getSandbox(), shellPath, background: false }));
      if (outcome.status === "interrupted") return;
      // re-read: the root may have been rewritten while the probe ran
      const learned = await this.store.read(cmd.key);
      if (learned == null || learned.status !== "ok") return;
      if (outcome.status === "ok") learned.nodes[sub] = outcome.node;
      else learned.missing[sub] = Date.now();
      await this.store.write(learned);
      this.changed([cmd.key]);
      return learned;
    })()
      .catch((e) => {
        log.debug({ msg: "learning subcommand failed", name: cmd.name, sub, e: (e as Error).message });
        return undefined;
      })
      .finally(() => this.inFlight.delete(flightKey));
    this.inFlight.set(flightKey, learning);
    return learning;
  }

  private async prefetchSubcommand(words: string[], complete: boolean): Promise<void> {
    const [name, ...rest] = words;
    if (this.hasFigSpec(name)) return;
    const cmd = this.resolve(name);
    if (cmd == null) return;
    const learned = await this.store.read(cmd.key);
    if (learned == null || learned.status !== "ok" || learned.source !== "help") return;
    let at = "";
    const partial = complete ? undefined : rest.pop();
    for (const word of rest) {
      if (word.startsWith("-")) continue;
      const child = learned.nodes[at]?.subcommands.find((c) => c.names.includes(word));
      if (child == null) return;
      at = at ? `${at}/${child.names[0]}` : child.names[0];
    }
    const children = learned.nodes[at]?.subcommands ?? [];
    const matches = partial == null ? [] : children.filter((c) => c.names.some((n) => n.startsWith(partial)));
    const target = matches.length === 1 ? matches[0] : children.find((c) => partial != null && c.names.includes(partial));
    if (target == null) return;
    const targetPath = at ? `${at}/${target.names[0]}` : target.names[0];
    if (learned.nodes[targetPath] == null) await this.node(specPathOf(name, targetPath));
  }
}
