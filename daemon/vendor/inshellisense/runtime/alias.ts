// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// zdrop: aliases are sent by the zsh client (`${(kv)aliases}`) instead of spawning `zsh -i -c alias`,
// so the shared daemon never forks an interactive shell. Each shell has its own table (the daemon is
// shared), along with its function, builtin and reserved-word names; requests run inside `shellNames`.

import { AsyncLocalStorage } from "node:async_hooks";
import log from "../utils/log.js";
import { Shell } from "../utils/shell.js";
import { CommandToken, parseCommand } from "./parser.js";

/** expansion depth limit: `alias g=git; alias gco='g checkout'` needs two, a cycle stops earlier */
const maxDepth = 5;

export class ShellNames {
  private aliases = new Map<string, { tokens: CommandToken[]; text: string }>();
  /** sorted, for prefix search */
  aliasNames: string[] = [];
  functionNames: string[] = [];
  /** builtins and reserved words: commands that are neither on PATH nor worth suggesting */
  private builtins = new Set<string>();
  /** zsh's CORRECT option is on in this shell */
  corrects = false;

  setAliases(aliases: Record<string, string>) {
    this.aliases = new Map(Object.entries(aliases).map(([alias, command]) => [alias, { tokens: parseCommand(command + " ", Shell.Zsh), text: command }]));
    this.aliasNames = [...this.aliases.keys()].sort();
  }

  setFunctions(functions: string[], builtins: string[], corrects = false) {
    this.functionNames = [...new Set(functions)].sort();
    this.builtins = new Set(builtins);
    this.corrects = corrects;
  }

  alias(name: string) {
    return this.aliases.get(name);
  }

  /** a name this shell runs without PATH: alias, function, builtin or reserved word */
  knows(name: string): boolean {
    return this.aliases.has(name) || this.builtins.has(name) || this.functionNames.includes(name);
  }
}

/** The names of the shell a request came from. */
export const shellNames = new AsyncLocalStorage<ShellNames>();
const outside = new ShellNames();
const current = () => shellNames.getStore() ?? outside;

/** Sets the aliases used outside any shell's request (`zdrop query`, tests). */
export const setAliases = (aliases: Record<string, string>) => outside.setAliases(aliases);

export const getAliasNames = () => current().aliasNames;
export const getFunctionNames = () => current().functionNames;
export const shellKnows = (name: string) => current().knows(name);
export const shellCorrects = () => current().corrects;
/** what an alias stands for, as typed in the alias definition */
export const aliasText = (name: string) => current().alias(name)?.text;

export const aliasExpand = (command: CommandToken[]): CommandToken[] => {
  if (!command.at(0)?.complete) return command;
  const names = current();
  const seen = new Set<string>();
  let tokens = command;
  for (let depth = 0; depth < maxDepth; depth++) {
    const name = tokens.at(0)?.token ?? "";
    // `alias ls='ls -G'` expands once
    if (seen.has(name)) break;
    const alias = names.alias(name);
    if (alias == null) break;
    seen.add(name);
    tokens = [...alias.tokens, ...tokens.slice(1)];
  }
  if (tokens !== command) log.debug({ msg: "expanding alias", alias: command[0].token, command: command.slice(1) });
  return tokens;
};
