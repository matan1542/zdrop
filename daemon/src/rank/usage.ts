import fs from "node:fs";
import readline from "node:readline";
import { aliasExpand } from "../../vendor/inshellisense/runtime/alias.js";

// What the user actually runs, for ranking. Every executed command line is reduced to "context →
// child" observations: the context is the command plus up to two following words (`git`,
// `git commit`, `kubectl get pods`), the child is the next word, flag or flag value. Scores decay with
// a 30-day half-life, so recent habits win. Everything is in memory and capped; it is rebuilt from
// $HISTFILE when the daemon starts and fed live by the shell's preexec hook.

const halfLifeSeconds = 30 * 86_400;
const maxContexts = 2_000;
const maxChildrenPerContext = 32;
const maxChildren = 15_000;
/** only the end of the history file is read: recent habits matter most, and parsing churns the heap */
const historyTailBytes = 1024 * 1024;
const contextWords = 3;
const sensitive = /pass(word)?|secret|token|api[-_]?key|auth|credential|private/i;

/** child → score; each use adds at most 1 (less for old uses), so `Math.floor` approximates the use count */
type Children = Map<string, number>;

export type UsageHit = { name: string; score: number; count: number };

const now = () => Date.now() / 1000;

/**
 * Splits a history line into simple commands (`a && b | c`) and words, the way the completion lexer
 * does (quotes removed, `--flag=value` split in two), but without its per-token objects: loading a
 * long history must not churn the daemon's heap.
 */
export const segments = (line: string): string[][] => {
  const out: string[][] = [];
  let words: string[] = [];
  let word = "";
  let inWord = false;
  let quote = "";
  const endWord = () => {
    if (!inWord) return;
    const eq = /^(--?[\w-]+)=(.*)$/.exec(word);
    if (eq) words.push(eq[1], eq[2]);
    else words.push(word);
    word = "";
    inWord = false;
  };
  const endSegment = () => {
    endWord();
    if (words.length > 0) {
      const alias = aliasExpand([{ token: words[0], tokenLength: words[0].length, complete: true, isOption: false }]);
      out.push(alias.length > 1 || alias[0].token !== words[0] ? [...alias.map((t) => t.token), ...words.slice(1)] : words);
    }
    words = [];
  };
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === quote) quote = "";
      else if (c === "\\" && quote === '"' && i + 1 < line.length) word += line[++i];
      else word += c;
    } else if (c === "'" || c === '"') {
      quote = c;
      inWord = true;
    } else if (c === "\\" && i + 1 < line.length) {
      word += line[++i];
      inWord = true;
    } else if (c === " " || c === "\t") {
      endWord();
    } else if (c === ";" || c === "|" || c === "&") {
      endSegment();
      if (line[i + 1] === c) i++;
    } else {
      word += c;
      inWord = true;
    }
  }
  endSegment();
  return out;
};

/** The context key for completing after `tokens` (all complete), and the option whose value comes next. */
export const contextOf = (tokens: string[]): { context: string; valueOf?: string } => {
  const words: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    // a word right after a flag is taken as that flag's value (`--env prod`, and `--env=prod`, which
    // the lexer splits in two), not as part of the command path
    if (tokens[i].startsWith("-") || (i > 0 && tokens[i - 1].startsWith("-"))) continue;
    if (words.length < contextWords) words.push(tokens[i]);
  }
  const last = tokens.at(-1);
  const valueOf = last != null && /^-/.test(last) && !last.includes("=") ? last : undefined;
  return { context: words.join(" "), valueOf };
};

export class UsageIndex {
  /** context ("" for first words) → child → score */
  private readonly contexts = new Map<string, Children>();
  private children = 0;
  private readonly loadedFiles = new Set<string>();

  /** Records one executed command line, run at `at` (epoch seconds). */
  record(line: string, at = now()) {
    const weight = Math.pow(2, -(Math.max(0, now() - at) / halfLifeSeconds));
    for (const words of segments(line)) {
      if (!/^[\w.+@/~-]+$/.test(words[0])) continue;
      this.bump("", words[0], weight);
      for (let i = 1; i < words.length; i++) {
        const { context, valueOf } = contextOf(words.slice(0, i));
        const word = words[i];
        if (word.length > 120) continue;
        if (valueOf != null) {
          if (!word.startsWith("-") && !sensitive.test(valueOf)) this.bump(`${context}\x1f${valueOf}`, word, weight);
          continue;
        }
        const eq = /^(--?[\w-]+)=(.+)$/.exec(word);
        if (eq) {
          this.bump(context, eq[1], weight);
          if (!sensitive.test(eq[1])) this.bump(`${context}\x1f${eq[1]}`, eq[2], weight);
          continue;
        }
        this.bump(context, word, weight);
      }
    }
    if (this.children > maxChildren * 1.1) this.prune();
  }

  /** Streams a zsh/bash history file into the index (once per file). */
  async loadHistory(file: string | undefined): Promise<void> {
    if (!file || this.loadedFiles.has(file)) return;
    this.loadedFiles.add(file);
    let stream: fs.ReadStream;
    let start = 0;
    let size = 0;
    try {
      size = (await fs.promises.stat(file)).size;
      start = Math.max(0, size - historyTailBytes);
      stream = fs.createReadStream(file, { encoding: "utf8", start });
    } catch {
      return;
    }
    // without EXTENDED_HISTORY timestamps, spread lines over the last 90 days in file order
    const approxLines = Math.max(1, Math.round((size - start) / 40));
    let index = 0;
    let continued = "";
    let skipPartial = start > 0;
    const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
    for await (const raw of lines) {
      if (skipPartial) {
        skipPartial = false; // the first line of a tail read starts mid-line
        continue;
      }
      index++;
      if (raw.endsWith("\\")) {
        continued += raw.slice(0, -1) + " ";
        continue;
      }
      const full = continued + raw;
      continued = "";
      const stamped = /^: (\d+):\d+;(.*)$/.exec(full);
      const at = stamped ? Number(stamped[1]) : now() - 90 * 86_400 * (1 - Math.min(1, index / approxLines));
      try {
        this.record(stamped ? stamped[2] : full, at);
      } catch {
        // an unparsable line is skipped
      }
    }
    stream.destroy();
  }

  /** Score of `child` after the complete tokens `before` (first words: `before` empty). */
  score(before: string[], child: string): number {
    const { context, valueOf } = contextOf(before);
    const key = valueOf != null ? `${context}\x1f${valueOf}` : context;
    return this.contexts.get(key)?.get(child) ?? 0;
  }

  /** Values used after `before` before (flag values, or positional words), best first. */
  values(before: string[], prefix: string, limit: number): UsageHit[] {
    const { context, valueOf } = contextOf(before);
    const key = valueOf != null ? `${context}\x1f${valueOf}` : context;
    const children = this.contexts.get(key);
    if (children == null) return [];
    const hits: UsageHit[] = [];
    for (const [name, score] of children) {
      if (name.startsWith("-") || !name.startsWith(prefix) || name === prefix) continue;
      hits.push({ name, score, count: Math.max(1, Math.floor(score)) });
    }
    return hits.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  stats() {
    return { contexts: this.contexts.size, children: this.children, files: this.loadedFiles.size };
  }

  private bump(context: string, child: string, weight: number) {
    let children = this.contexts.get(context);
    if (children == null) {
      if (this.contexts.size >= maxContexts) this.evictContext();
      children = new Map();
      this.contexts.set(context, children);
    } else {
      // keep recently used contexts at the end (eviction takes from the front)
      this.contexts.delete(context);
      this.contexts.set(context, children);
    }
    const existing = children.get(child);
    if (existing != null) {
      children.set(child, existing + weight);
      return;
    }
    if (children.size >= maxChildrenPerContext) {
      let lowest: string | undefined;
      let lowestScore = Infinity;
      for (const [name, score] of children) if (score < lowestScore) [lowest, lowestScore] = [name, score];
      if (lowestScore > weight || lowest == null) return;
      children.delete(lowest);
      this.children--;
    }
    children.set(child, weight);
    this.children++;
  }

  private evictContext() {
    const oldest = this.contexts.keys().next().value;
    if (oldest == null) return;
    this.children -= this.contexts.get(oldest)?.size ?? 0;
    this.contexts.delete(oldest);
  }

  /** Drops the lowest-scoring tenth of all children. */
  private prune() {
    const all: number[] = [];
    for (const children of this.contexts.values()) for (const score of children.values()) all.push(score);
    all.sort((a, b) => a - b);
    const cutoff = all[Math.floor(all.length / 10)] ?? 0;
    for (const [context, children] of this.contexts) {
      for (const [name, score] of children) {
        if (score <= cutoff) {
          children.delete(name);
          this.children--;
        }
      }
      if (children.size === 0) this.contexts.delete(context);
    }
  }
}

export const usage = new UsageIndex();
