import fs from "node:fs";
import path from "node:path";
import { getAliasNames, getFunctionNames, shellCorrects, shellKnows } from "../../vendor/inshellisense/runtime/alias.js";
import { getSpecNames } from "../../vendor/inshellisense/runtime/runtime.js";
import { currentEnv } from "../learn/context.js";
import { usage } from "./usage.js";

// "Did you mean": when the command word of a line is finished and is not a command this shell can run
// (`gti status`), offer the closest one that is. Only runs for an unknown word, so it costs nothing on
// ordinary typing; zsh's own CORRECT option, when on, is left to do it instead.

export type Typo = { start: number; word: string; fix: string };

/** Optimal-string-alignment distance (a swap of neighbours counts as one edit), or max + 1 once it exceeds `max`. */
export const editDistance = (a: string, b: string, max: number): number => {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev2: number[] = [];
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let d = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d = Math.min(d, prev2[j - 2] + 1);
      row.push(d);
      best = Math.min(best, d);
    }
    if (best > max) return max + 1;
    prev2 = prev;
    prev = row;
  }
  return prev[b.length];
};

/** Where the last simple command's first word is in `line` (after `;`, `&&`, `|`, `(` and `VAR=x`). */
const commandWord = (line: string): { start: number; word: string } | undefined => {
  let segment = 0;
  let quote = "";
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === quote) quote = "";
    } else if (c === "'" || c === '"') quote = c;
    else if (c === "\\") i++;
    else if (c === ";" || c === "&" || c === "|" || c === "(" || c === "{" || c === "`") segment = i + 1;
  }
  if (quote) return;
  const re = /\s*(?:[A-Za-z_]\w*=\S*\s+)*/y;
  re.lastIndex = segment;
  re.exec(line);
  const start = re.lastIndex;
  const word = /^\S+/.exec(line.slice(start))?.[0];
  // only once the word is finished (followed by a space); while it is typed, completion shows matches
  if (word == null || start + word.length >= line.length) return;
  return { start, word };
};

const onPath = (name: string): boolean => currentEnv().path.split(":").some((dir) => dir !== "" && fs.existsSync(path.join(dir, name)));

/** project-local tools (node_modules/.bin up the tree) run by name through yarn/npx shims */
const inLocalBin = (name: string, cwd: string): boolean => {
  for (let dir = cwd, i = 0; i < 12; i++) {
    if (fs.existsSync(path.join(dir, "node_modules", ".bin", name))) return true;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return false;
};

const sorted = (names: string[], name: string): boolean => {
  let low = 0;
  let high = names.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (names[mid] < name) low = mid + 1;
    else high = mid;
  }
  return names[low] === name;
};

/** The correction for `line`'s command word, if it is not a command and something close is. */
export const findTypo = (line: string, cwd: string): Typo | undefined => {
  if (shellCorrects()) return;
  const found = commandWord(line);
  if (found == null) return;
  const { start, word } = found;
  if (word.length < 2 || !/^[\w.+@-]+$/.test(word) || word.startsWith(".")) return;
  const specs = getSpecNames();
  if (sorted(specs, word) || shellKnows(word) || onPath(word) || inLocalBin(word, cwd)) return;

  const max = word.length <= 4 ? 1 : 2;
  let best: { name: string; distance: number; score: number } | undefined;
  for (const names of [specs, getAliasNames(), getFunctionNames()]) {
    for (const name of names) {
      if (name.length < 2) continue;
      const distance = editDistance(word, name, max);
      if (distance > max) continue;
      const score = usage.score([], name) + (name[0] === word[0] ? 0.5 : 0);
      if (best == null || distance < best.distance || (distance === best.distance && score > best.score)) best = { name, distance, score };
    }
  }
  return best == null ? undefined : { start, word, fix: best.name };
};
