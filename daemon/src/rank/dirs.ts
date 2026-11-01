import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import fuzzysort from "fuzzysort";
import { zdropHome } from "../protocol.js";

// Frequently and recently visited directories, with zoxide's algorithm: each visit adds 1 to a
// directory's rank; once all ranks sum past 10,000 they are aged (×0.9) and those below 1 forgotten.
// The score weights rank by how recent the last visit was. Persisted to one small TSV file.

const maxAge = 10_000;
const maxDirs = 1_000;
const saveDelayMs = 5_000;

type Dir = { rank: number; last: number };

export type DirHit = { dir: string; score: number };

const home = os.homedir();
export const tildify = (dir: string): string => (dir === home ? "~" : dir.startsWith(home + "/") ? "~" + dir.slice(home.length) : dir);

export class DirFrecency {
  private readonly dirs = new Map<string, Dir>();
  private saveTimer?: NodeJS.Timeout;
  private loaded = false;

  constructor(private readonly file = path.join(zdropHome, "dirs.tsv")) {}

  visit(dir: string, at = Date.now()) {
    this.load();
    if (!path.isAbsolute(dir) || dir === "/" || dir === home) return;
    const entry = this.dirs.get(dir);
    if (entry) {
      entry.rank += 1;
      entry.last = at;
    } else {
      this.dirs.set(dir, { rank: 1, last: at });
    }
    let total = 0;
    for (const d of this.dirs.values()) total += d.rank;
    if (total > maxAge || this.dirs.size > maxDirs) this.age();
    this.scheduleSave();
  }

  /** Best directories, optionally fuzzy-matching `term` against their paths; missing ones are dropped. */
  top(limit: number, term = "", exclude: (dir: string) => boolean = () => false): DirHit[] {
    this.load();
    const now = Date.now();
    const scored: DirHit[] = [];
    for (const [dir, entry] of this.dirs) {
      if (exclude(dir)) continue;
      scored.push({ dir, score: entry.rank * recency(now - entry.last) });
    }
    scored.sort((a, b) => b.score - a.score);
    // match the directory's own name, not letters scattered along its parents
    const named = scored.map((hit) => ({ ...hit, name: path.basename(hit.dir) }));
    const candidates = term
      ? fuzzysort.go(term, named, { key: "name", limit: limit * 3 }).map((r) => ({ dir: r.obj.dir, score: r.obj.score * (1 + r.score) }))
      : scored.slice(0, limit * 3);
    const hits: DirHit[] = [];
    for (const hit of candidates) {
      if (hits.length >= limit) break;
      if (!fs.existsSync(hit.dir)) {
        this.dirs.delete(hit.dir);
        this.scheduleSave();
        continue;
      }
      hits.push(hit);
    }
    return hits;
  }

  stats() {
    return { dirs: this.dirs.size };
  }

  flush() {
    clearTimeout(this.saveTimer);
    this.save();
  }

  private age() {
    for (const [dir, d] of this.dirs) {
      d.rank *= 0.9;
      if (d.rank < 1) this.dirs.delete(dir);
    }
    if (this.dirs.size > maxDirs) {
      const keep = [...this.dirs].sort((a, b) => b[1].rank - a[1].rank).slice(0, maxDirs);
      this.dirs.clear();
      for (const [dir, d] of keep) this.dirs.set(dir, d);
    }
  }

  private load() {
    if (this.loaded) return;
    this.loaded = true;
    let text = "";
    try {
      text = fs.readFileSync(this.file, "utf8");
    } catch {
      return;
    }
    for (const line of text.split("\n")) {
      const [dir, rank, last] = line.split("\t");
      if (dir && Number(rank) > 0) this.dirs.set(dir, { rank: Number(rank), last: Number(last) || 0 });
    }
  }

  private scheduleSave() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      this.save();
    }, saveDelayMs);
    this.saveTimer.unref();
  }

  private save() {
    const lines = [...this.dirs].map(([dir, d]) => `${dir}\t${d.rank.toFixed(3)}\t${d.last}`).join("\n");
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, lines + "\n", { mode: 0o600 });
      fs.renameSync(tmp, this.file);
    } catch {
      // best effort
    }
  }
}

/** zoxide's recency weights */
const recency = (ageMs: number): number => {
  const hour = 3_600_000;
  if (ageMs < hour) return 4;
  if (ageMs < 24 * hour) return 2;
  if (ageMs < 7 * 24 * hour) return 0.5;
  return 0.25;
};

export const dirs = new DirFrecency();
