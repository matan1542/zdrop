import fs from "node:fs";
import path from "node:path";

// Every command on the user's PATH, the way zsh's command hash table and nushell build it: one
// readdir per directory, no stat per file. Directories are re-read only when their mtime changed,
// and that is checked at most every `recheckMs` (lazy revalidation instead of file watchers).

type DirEntry = { mtimeMs: number; names: string[] };
type Merged = { names: string[]; where: Map<string, string>; checkedAt: number; dirs: string[] };

const maxDirs = 128;
const maxPathVariants = 4;

export class CommandIndex {
  private readonly dirs = new Map<string, DirEntry>();
  private readonly merged = new Map<string, Merged>();

  constructor(private readonly recheckMs = 15_000) {}

  /** Sorted, de-duplicated command names on `pathValue`, first directory winning. */
  names(pathValue: string): string[] {
    return this.get(pathValue).names;
  }

  /** Absolute path of `name` on `pathValue`, if it is an executable regular file. */
  resolve(name: string, pathValue: string): string | undefined {
    if (name.includes("/")) return;
    const dir = this.get(pathValue).where.get(name);
    if (dir == null) return;
    const file = path.join(dir, name);
    try {
      const stat = fs.statSync(file);
      if (!stat.isFile() || (stat.mode & 0o111) === 0) return;
      return file;
    } catch {
      return;
    }
  }

  stats() {
    return { dirs: this.dirs.size, pathVariants: this.merged.size, commands: [...this.merged.values()].at(-1)?.names.length ?? 0 };
  }

  private get(pathValue: string): Merged {
    const now = Date.now();
    let merged = this.merged.get(pathValue);
    if (merged != null && now - merged.checkedAt < this.recheckMs) {
      this.merged.delete(pathValue);
      this.merged.set(pathValue, merged);
      return merged;
    }
    const dirs = [...new Set(pathValue.split(":").filter((d) => path.isAbsolute(d)))];
    const changed = dirs.map((dir) => this.refreshDir(dir)).some(Boolean);
    if (merged == null || changed || merged.dirs.join(":") !== dirs.join(":")) {
      const where = new Map<string, string>();
      for (const dir of dirs) for (const name of this.dirs.get(dir)?.names ?? []) if (!where.has(name)) where.set(name, dir);
      merged = { names: [...where.keys()].sort(), where, checkedAt: now, dirs };
    } else {
      merged.checkedAt = now;
    }
    this.merged.delete(pathValue);
    this.merged.set(pathValue, merged);
    while (this.merged.size > maxPathVariants) this.merged.delete(this.merged.keys().next().value!);
    return merged;
  }

  /** Re-reads `dir` if it changed; returns true when its listing changed. */
  private refreshDir(dir: string): boolean {
    let mtimeMs: number;
    try {
      mtimeMs = fs.statSync(dir).mtimeMs;
    } catch {
      const had = this.dirs.delete(dir);
      return had;
    }
    const cached = this.dirs.get(dir);
    if (cached != null && cached.mtimeMs === mtimeMs) {
      this.dirs.delete(dir);
      this.dirs.set(dir, cached);
      return false;
    }
    let names: string[] = [];
    try {
      names = fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((e) => (e.isFile() || e.isSymbolicLink()) && !e.name.startsWith(".") && !/[\s\x00-\x1f]/.test(e.name))
        .map((e) => e.name);
    } catch {
      // unreadable directory: treat as empty
    }
    this.dirs.set(dir, { mtimeMs, names });
    while (this.dirs.size > maxDirs) this.dirs.delete(this.dirs.keys().next().value!);
    return true;
  }
}
