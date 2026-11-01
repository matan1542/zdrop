import fs from "node:fs";
import readline from "node:readline";

export type HistoryRank = {
  /** command → number of times it was run */
  commands: Map<string, number>;
  /** "command sub" → number of times */
  subcommands: Map<string, number>;
};

const maxLines = 200_000;
const wrappers = new Set(["sudo", "time", "nice", "nohup", "env", "command", "builtin", "exec", "noglob"]);

/**
 * Counts which commands (and first subcommands) appear in a zsh/bash history file. Streams the file
 * line by line so a huge history never sits in memory; reads at most the first `maxLines` lines.
 */
export const readHistory = async (file: string | undefined): Promise<HistoryRank> => {
  const rank: HistoryRank = { commands: new Map(), subcommands: new Map() };
  if (!file) return rank;
  let stream: fs.ReadStream;
  try {
    await fs.promises.access(file, fs.constants.R_OK);
    stream = fs.createReadStream(file, { encoding: "latin1" });
  } catch {
    return rank;
  }
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let count = 0;
  for await (const raw of lines) {
    if (++count > maxLines) break;
    // zsh EXTENDED_HISTORY: ": 1700000000:0;git status"
    const line = raw.replace(/^: \d+:\d+;/, "");
    for (const segment of line.split(/\s*(?:&&|\|\||;|\|)\s*/)) {
      const words = segment.trim().split(/\s+/).filter((w) => !/^\w+=/.test(w));
      while (words.length > 0 && wrappers.has(words[0])) words.shift();
      const [command, sub] = words;
      if (!command || !/^[\w.+-]+$/.test(command)) continue;
      rank.commands.set(command, (rank.commands.get(command) ?? 0) + 1);
      if (sub && /^[a-z][\w:-]*$/.test(sub)) {
        const key = `${command} ${sub}`;
        rank.subcommands.set(key, (rank.subcommands.get(key) ?? 0) + 1);
      }
    }
  }
  stream.destroy();
  return rank;
};
