import os from "node:os";
import path from "node:path";
import type { QueryResult } from "./engine.js";

// Line protocol designed to be parsed by zsh without a JSON parser: one message per line, fields
// separated by US (0x1f), records by RS (0x1e). Control characters are stripped from every field.
//
// client → daemon
//   Q US seq US cwd US lbuffer      complete the text before the cursor (last line only)
//   A US name US value ...          replace the alias table
//   E US PATH US HISTFILE           the shell's environment (sent on connect and when PATH changes);
//                                   commands are resolved and learned against this PATH
//   H US line                       a command line the user just ran (ranks suggestions by usage)
//   D US dir                        the shell changed into dir (frecent directories for cd)
//   N                               a new command line started (drops implicit generator caches)
//   S                               status (JSON reply, for `zdrop status`)
//   X                               stop the daemon
// daemon → client
//   R US seq US replaceLen US commonPrefix US argHint US pending US notice RS item RS item ...
//        notice = a one-line message for the description bar (an available update), usually empty
//        item = icon US name US insert US description US args US matchIndices(,) US type
//   P US seq US label               a generator is still running (sent ~every 100ms while pending)

export const US = "\x1f";
export const RS = "\x1e";

export const zdropHome = process.env.ZDROP_HOME ?? path.join(os.homedir(), ".cache", "zdrop");
export const socketPath = path.join(zdropHome, "zdrop.sock");
export const pidPath = path.join(zdropHome, "zdrop.pid");

// eslint-disable-next-line no-control-regex
const clean = (value: string): string => value.replace(/[\x00-\x1f\x7f]/g, " ");

export const encodeResult = (seq: string, result: QueryResult, notice = ""): string => {
  const header = [seq, String(result.replaceLen), clean(result.commonPrefix), clean(result.argHint), clean(result.pending.join(", ")), clean(notice)].join(US);
  const items = result.items.map((item) =>
    [item.icon, item.name, item.insert, item.description, item.args, item.matchIndices.join(","), item.type].map(clean).join(US),
  );
  return ["R" + US + header, ...items].join(RS) + "\n";
};

export const encodeProgress = (seq: string, label: string): string => ["P", seq, clean(label)].join(US) + "\n";
