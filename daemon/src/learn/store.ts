import fs from "node:fs";
import fsAsync from "node:fs/promises";
import path from "node:path";
import { learnConfig } from "./config.js";
import { PARSER_VERSION, type HelpNode } from "./helpParser.js";
import type { HelpTree } from "./figSpec.js";

// One JSON file per learned command, written atomically (tmp + rename), plus an append-only
// `index.tsv` (name, status, description) so the daemon can describe every learned command at
// startup by reading one small file instead of hundreds of JSON files.

/** Identity of the executable a spec was learned from (fish's FileId, minus ctime). */
export type FileKey = { realpath: string; dev: number; ino: number; size: number; mtimeMs: number };

export type LearnStatus = "ok" | "miss" | "timeout";

export type LearnedFile = {
  format: 1;
  parser: number;
  name: string;
  key: FileKey;
  source: "help" | "man";
  status: LearnStatus;
  description: string;
  nodes: HelpTree;
  /** subcommand paths whose help could not be read, with when that was found out */
  missing: Record<string, number>;
  probedAt: number;
  failures: number;
};

export const fileKey = async (file: string): Promise<FileKey | undefined> => {
  try {
    const realpath = await fsAsync.realpath(file);
    const stat = await fsAsync.stat(realpath);
    return { realpath, dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: Math.round(stat.mtimeMs) };
  } catch {
    return;
  }
};

export const sameKey = (a: FileKey, b: FileKey) => a.realpath === b.realpath && a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs;

/** Whether `learned` still describes the binary identified by `key`, and whether a miss may be retried. */
export const freshness = (learned: LearnedFile, key: FileKey, now = Date.now()): "fresh" | "stale" | "retry" | "wait" => {
  const changed = !sameKey(learned.key, key) || learned.parser !== PARSER_VERSION;
  if (learned.status === "ok") return changed || now - learned.probedAt > learnConfig.refreshMs ? "stale" : "fresh";
  if (changed) return "retry";
  const backoff = learnConfig.missBackoffMs[Math.min(learned.failures - 1, learnConfig.missBackoffMs.length - 1)] ?? learnConfig.missBackoffMs[0];
  return now - learned.probedAt > backoff ? "retry" : "wait";
};

const fileName = (name: string) => encodeURIComponent(name).replace(/^\./, "%2E") + ".json";

export class LearnedStore {
  readonly dir: string;
  private readonly indexPath: string;
  /** name → description of every learned command (status ok) */
  readonly descriptions = new Map<string, string>();
  private indexLines = 0;
  private indexOffset = 0;

  constructor(dir = learnConfig.storeDir) {
    this.dir = dir;
    this.indexPath = path.join(dir, "index.tsv");
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  async read(name: string): Promise<LearnedFile | undefined> {
    const file = path.join(this.dir, fileName(name));
    let text: string;
    try {
      text = await fsAsync.readFile(file, "utf8");
    } catch {
      return;
    }
    try {
      const parsed = JSON.parse(text) as LearnedFile;
      if (parsed.format !== 1 || parsed.name !== name || parsed.key == null || parsed.nodes == null) throw new Error("bad shape");
      return parsed;
    } catch {
      // a corrupt file heals itself: forget it and learn again
      await fsAsync.rm(file, { force: true });
      return;
    }
  }

  async write(learned: LearnedFile): Promise<void> {
    let text = JSON.stringify(learned);
    if (text.length > learnConfig.fileBytes || Object.keys(learned.nodes).length > learnConfig.nodesPerCommand) {
      // keep the root and as many subcommands as fit
      const nodes: HelpTree = { "": learned.nodes[""] };
      for (const [key, node] of Object.entries(learned.nodes)) {
        if (key === "") continue;
        nodes[key] = node;
        if (Object.keys(nodes).length >= learnConfig.nodesPerCommand || JSON.stringify(nodes).length > learnConfig.fileBytes * 0.9) {
          delete nodes[key];
          break;
        }
      }
      text = JSON.stringify({ ...learned, nodes });
    }
    const file = path.join(this.dir, fileName(learned.name));
    const tmp = `${file}.${process.pid}.tmp`;
    await fsAsync.writeFile(tmp, text, { mode: 0o600 });
    await fsAsync.rename(tmp, file);
    const description = learned.status === "ok" ? learned.description : "";
    await fsAsync.appendFile(this.indexPath, `${learned.name}\t${learned.status}\t${description.replace(/[\t\n]/g, " ")}\n`);
    this.applyIndexLine(learned.name, learned.status, description);
  }

  async remove(name: string): Promise<boolean> {
    const file = path.join(this.dir, fileName(name));
    const existed = fs.existsSync(file);
    await fsAsync.rm(file, { force: true });
    this.descriptions.delete(name);
    await fsAsync.appendFile(this.indexPath, `${name}\tremoved\t\n`);
    return existed;
  }

  async clear(): Promise<void> {
    for (const entry of await fsAsync.readdir(this.dir)) await fsAsync.rm(path.join(this.dir, entry), { force: true });
    this.descriptions.clear();
    this.indexLines = 0;
    this.indexOffset = 0;
  }

  /** Reads index lines appended since the last call (by this process or the background worker). */
  async loadIndex(): Promise<number> {
    let handle: fsAsync.FileHandle;
    try {
      handle = await fsAsync.open(this.indexPath, "r");
    } catch {
      return 0;
    }
    try {
      const { size } = await handle.stat();
      if (size < this.indexOffset) this.indexOffset = 0;
      if (size === this.indexOffset) return 0;
      const buffer = Buffer.alloc(size - this.indexOffset);
      await handle.read(buffer, 0, buffer.length, this.indexOffset);
      const text = buffer.toString("utf8");
      const end = text.lastIndexOf("\n") + 1;
      this.indexOffset += Buffer.byteLength(text.slice(0, end));
      let count = 0;
      for (const line of text.slice(0, end).split("\n")) {
        const [name, status, description] = line.split("\t");
        if (!name) continue;
        this.applyIndexLine(name, status, description ?? "");
        count++;
      }
      return count;
    } finally {
      await handle.close();
    }
  }

  /**
   * Rewrites the index to one line per command and removes the oldest files while the store is over
   * its byte budget. Only call when no background worker is running (it appends to the index).
   */
  async compact(): Promise<{ files: number; bytes: number; removed: number }> {
    const entries: { name: string; file: string; bytes: number; mtimeMs: number }[] = [];
    for (const entry of await fsAsync.readdir(this.dir)) {
      if (!entry.endsWith(".json")) {
        if (entry.endsWith(".tmp")) await fsAsync.rm(path.join(this.dir, entry), { force: true });
        continue;
      }
      const file = path.join(this.dir, entry);
      const stat = await fsAsync.stat(file).catch(() => undefined);
      if (stat) entries.push({ name: decodeURIComponent(entry.slice(0, -5)), file, bytes: stat.size, mtimeMs: stat.mtimeMs });
    }
    let bytes = entries.reduce((sum, e) => sum + e.bytes, 0);
    let removed = 0;
    entries.sort((a, b) => a.mtimeMs - b.mtimeMs);
    while (bytes > learnConfig.storeBytes && entries.length > 0) {
      const oldest = entries.shift()!;
      await fsAsync.rm(oldest.file, { force: true });
      this.descriptions.delete(oldest.name);
      bytes -= oldest.bytes;
      removed++;
    }
    if (this.indexLines > entries.length * 2 + 64 || removed > 0) {
      const live = new Set(entries.map((e) => e.name));
      const lines = [...this.descriptions].filter(([name]) => live.has(name)).map(([name, d]) => `${name}\tok\t${d}\n`);
      const tmp = `${this.indexPath}.${process.pid}.tmp`;
      await fsAsync.writeFile(tmp, lines.join(""), { mode: 0o600 });
      await fsAsync.rename(tmp, this.indexPath);
      this.indexLines = lines.length;
      this.indexOffset = Buffer.byteLength(lines.join(""));
    }
    return { files: entries.length, bytes, removed };
  }

  stats() {
    return { learned: this.descriptions.size };
  }

  private applyIndexLine(name: string, status: string, description: string) {
    this.indexLines++;
    if (status === "ok") this.descriptions.set(name, description);
    else this.descriptions.delete(name);
  }
}

export const newLearnedFile = (name: string, key: FileKey, source: "help" | "man", node: HelpNode | undefined, status: LearnStatus, previous?: LearnedFile): LearnedFile => ({
  format: 1,
  parser: PARSER_VERSION,
  name,
  key,
  source,
  status,
  description: node?.description ?? "",
  nodes: node ? { "": node } : {},
  missing: {},
  probedAt: Date.now(),
  failures: status === "ok" ? 0 : (previous?.status === "ok" ? 0 : (previous?.failures ?? 0)) + 1,
});
