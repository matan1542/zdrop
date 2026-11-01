import path from "node:path";
import fuzzysort from "fuzzysort";
import { getSuggestions } from "../vendor/inshellisense/runtime/runtime.js";
import { generationMode } from "../vendor/inshellisense/runtime/generatorCache.js";
import type { Suggestion, SuggestionBlob } from "../vendor/inshellisense/runtime/model.js";
import { aliasExpand } from "../vendor/inshellisense/runtime/alias.js";
import { parseCommand, type CommandToken } from "../vendor/inshellisense/runtime/parser.js";
import { Shell } from "../vendor/inshellisense/utils/shell.js";
import { dirs, tildify } from "./rank/dirs.js";
import { usage } from "./rank/usage.js";

export const maxItems = 50;

export type Item = {
  /** semantic icon key, mapped to a glyph by the zsh renderer */
  icon: string;
  name: string;
  /** text that replaces the active token; ends with a space unless it is a folder or has {cursor} */
  insert: string;
  description: string;
  args: string;
  /** character indexes in `name` that matched what was typed (highlighted in the popup) */
  matchIndices: number[];
  type: string;
};

export type QueryResult = {
  items: Item[];
  /** characters before the cursor that belong to the token being completed */
  replaceLen: number;
  /** longest prefix shared by every item name; what Tab inserts */
  commonPrefix: string;
  /** "name: description" of the argument being completed, shown when there are no items */
  argHint: string;
  /** generators still running; non-empty means a later result will follow */
  pending: string[];
};

const zshSpecial = /([\s'"\\$`!&|;<>()*?[\]{}#])/g;

const insertText = (s: Suggestion): string => {
  if (s.insertValue != null) return s.insertValue;
  return s.name.replace(zshSpecial, "\\$1") + " ";
};

// the lexer unescapes "\ " and strips quotes; recover how many characters the token occupies in the buffer
const rawTokenLength = (blob: SuggestionBlob): number => {
  const token = blob.activeToken;
  if (token == null) return 0;
  if (token.isQuoted && !token.isQuoteContinued) return token.token.length + 1;
  return token.token.replaceAll(" ", "\\ ").length;
};

const queryTerm = (blob: SuggestionBlob): string => {
  const token = blob.activeToken;
  if (token == null) return "";
  if (token.isPath) return token.isPathComplete ? "" : path.basename(token.token);
  return token.token;
};

const matchIndices = (name: string, term: string): number[] => {
  if (term.length === 0) return [];
  if (name.toLowerCase().startsWith(term.toLowerCase())) return [...Array(term.length).keys()];
  const result = fuzzysort.single(term, name);
  return result == null ? [] : [...result.indexes];
};

const commonPrefix = (names: string[]): string => {
  if (names.length === 0) return "";
  let prefix = names[0];
  for (const name of names.slice(1)) {
    let i = 0;
    while (i < prefix.length && i < name.length && prefix[i] === name[i]) i++;
    prefix = prefix.slice(0, i);
    if (prefix.length === 0) break;
  }
  return prefix;
};

/** What the line looks like around the cursor, for ranking by usage and directory frecency. */
type LineContext = { before: string[]; active?: CommandToken; cwd: string };

const lineContext = (lbuffer: string, cwd: string): LineContext => {
  const tokens = aliasExpand(parseCommand(lbuffer, Shell.Zsh));
  const active = tokens.at(-1)?.complete === false ? tokens.at(-1) : undefined;
  return { before: (active ? tokens.slice(0, -1) : tokens).map((t) => t.token), active, cwd };
};

const escapeZsh = (value: string): string => value.replace(zshSpecial, "\\$1");
const quoteValue = (value: string): string => (escapeZsh(value) === value ? value : value.includes("'") ? escapeZsh(value) : `'${value}'`);

const cdCommands = new Set(["cd", "pushd", "z"]);

/** Pinned suggestions (Fig priority > 75, e.g. the current branch) stay on top; then prefix matches by usage. */
const rankItems = (items: Item[], priorities: number[], ctx: LineContext, term: string): Item[] => {
  const lower = term.toLowerCase();
  return items
    .map((item, index) => ({
      item,
      index,
      group: (priorities[index] ?? 50) > 75 ? 0 : lower === "" || item.name.toLowerCase().startsWith(lower) ? 1 : 2,
      score: usage.score(ctx.before, item.name),
    }))
    .sort((a, b) => a.group - b.group || b.score - a.score || a.index - b.index)
    .map((r) => r.item);
};

/** Values used before in this position (flag values, positional words) that the spec didn't offer. */
const historyItems = (items: Item[], ctx: LineContext, term: string): Item[] => {
  if (ctx.before.length === 0 || term.startsWith("-") || cdCommands.has(ctx.before[0])) return [];
  const known = new Set(items.map((item) => item.name));
  return usage
    .values(ctx.before, term, 5)
    .filter((hit) => !known.has(hit.name))
    .map((hit) => ({
      icon: "history",
      name: hit.name,
      insert: quoteValue(hit.name) + " ",
      description: `used ${hit.count}×`,
      args: "",
      matchIndices: matchIndices(hit.name, term),
      type: "history",
    }));
};

/** Frecent directories for `cd`: the top ones before anything is typed, matching ones after. */
const dirItems = (items: Item[], ctx: LineContext, term: string): { first: Item[]; last: Item[] } => {
  if (ctx.before.length !== 1 || !cdCommands.has(ctx.before[0]) || term.includes("/")) return { first: [], last: [] };
  const listed = new Set(items.map((item) => path.resolve(ctx.cwd, item.insert.replace(/\\(.)/g, "$1"))));
  const hits = dirs.top(term ? 5 : 3, term, (dir) => dir === ctx.cwd || listed.has(dir) || listed.has(dir + "/"));
  const toItem = (dir: string): Item => {
    const full = tildify(dir) + "/";
    // long paths show their last segments; the description has the whole path
    const parts = full.split("/").filter(Boolean);
    const name = full.length <= 28 ? full : "…/" + parts.slice(-2).join("/") + "/";
    return {
      icon: "frecent",
      name,
      insert: full.startsWith("~") ? "~" + escapeZsh(full.slice(1)) : escapeZsh(full),
      description: full,
      args: "",
      matchIndices: matchIndices(name, term),
      type: "folder",
    };
  };
  return term ? { first: [], last: hits.map((h) => toItem(h.dir)) } : { first: hits.map((h) => toItem(h.dir)), last: [] };
};

const toResult = (blob: SuggestionBlob | undefined, pending: string[], ctx: LineContext): QueryResult => {
  const term = blob ? queryTerm(blob) : (ctx.active?.token ?? "");
  const suggestions = blob?.suggestions.slice(0, maxItems) ?? [];
  const specItems: Item[] = suggestions.map((s) => ({
    icon: s.icon,
    name: s.name,
    insert: insertText(s),
    description: s.description ?? "",
    args: s.args ?? "",
    matchIndices: matchIndices(s.name, term),
    type: s.type ?? "",
  }));
  const priorities = suggestions.map((s) => s.priority ?? 50);
  const history = historyItems(specItems, ctx, term);
  const ranked = rankItems([...specItems, ...history], [...priorities, ...history.map(() => 50)], ctx, term);
  const frecent = dirItems(ranked, ctx, term);
  const items = [...frecent.first, ...ranked, ...frecent.last].slice(0, maxItems);
  if (items.length === 0 && blob == null) return { items: [], replaceLen: 0, commonPrefix: "", argHint: "", pending };

  const prefix = commonPrefix(items.map((item) => item.name));
  return {
    items,
    replaceLen: blob ? rawTokenLength(blob) : (ctx.active?.tokenLength ?? 0),
    commonPrefix: prefix.toLowerCase().startsWith(term.toLowerCase()) ? prefix : "",
    argHint: blob?.argumentDescription ?? "",
    pending,
  };
};

const pendingLabel = (blob: SuggestionBlob | undefined, labels: string[]): string => {
  const hint = blob?.argumentDescription;
  if (hint != null && hint.length > 0 && hint.length <= 24) return hint;
  return labels[0] ?? "suggestions";
};

/**
 * Computes suggestions for the text before the cursor. Emits once with whatever is available
 * immediately (static subcommands/options plus cached generator output); if generators are still
 * running it emits again with their results. Throws an AbortError if `signal` fires.
 */
export const runQuery = async (
  lbuffer: string,
  cwd: string,
  emit: (result: QueryResult) => void,
  signal?: AbortSignal,
): Promise<void> => {
  const line = lineContext(lbuffer, cwd);
  const context = { fast: true, pending: [] as Promise<unknown>[], labels: [] as string[] };
  const fast = await generationMode.run(context, () => getSuggestions(lbuffer, cwd, Shell.Zsh, signal));
  signal?.throwIfAborted();
  if (context.pending.length === 0) {
    emit(toResult(fast, [], line));
    return;
  }

  emit(toResult(fast, [pendingLabel(fast, context.labels)], line));
  await Promise.all(context.pending);
  signal?.throwIfAborted();
  const full = await getSuggestions(lbuffer, cwd, Shell.Zsh, signal);
  signal?.throwIfAborted();
  emit(toResult(full, [], line));
};
