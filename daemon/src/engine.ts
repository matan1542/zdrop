import path from "node:path";
import fuzzysort from "fuzzysort";
import { getSuggestions } from "../vendor/inshellisense/runtime/runtime.js";
import { generationMode } from "../vendor/inshellisense/runtime/generatorCache.js";
import type { Suggestion, SuggestionBlob } from "../vendor/inshellisense/runtime/model.js";
import { Shell } from "../vendor/inshellisense/utils/shell.js";

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

const toResult = (blob: SuggestionBlob | undefined, pending: string[]): QueryResult => {
  if (blob == null) return { items: [], replaceLen: 0, commonPrefix: "", argHint: "", pending };
  const term = queryTerm(blob);
  const items: Item[] = blob.suggestions.slice(0, maxItems).map((s) => ({
    icon: s.icon,
    name: s.name,
    insert: insertText(s),
    description: s.description ?? "",
    args: s.args ?? "",
    matchIndices: matchIndices(s.name, term),
    type: s.type ?? "",
  }));

  const prefix = commonPrefix(items.map((item) => item.name));
  return {
    items,
    replaceLen: rawTokenLength(blob),
    commonPrefix: prefix.toLowerCase().startsWith(term.toLowerCase()) ? prefix : "",
    argHint: blob.argumentDescription ?? "",
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
  const context = { fast: true, pending: [] as Promise<unknown>[], labels: [] as string[] };
  const fast = await generationMode.run(context, () => getSuggestions(lbuffer, cwd, Shell.Zsh, signal));
  signal?.throwIfAborted();
  if (context.pending.length === 0) {
    emit(toResult(fast, []));
    return;
  }

  emit(toResult(fast, [pendingLabel(fast, context.labels)]));
  await Promise.all(context.pending);
  signal?.throwIfAborted();
  const full = await getSuggestions(lbuffer, cwd, Shell.Zsh, signal);
  signal?.throwIfAborted();
  emit(toResult(full, []));
};
