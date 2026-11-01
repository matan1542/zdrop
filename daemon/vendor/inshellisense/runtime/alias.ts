// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// zdrop: aliases are sent by the zsh client (`${(kv)aliases}`) instead of spawning `zsh -i -c alias`,
// so the shared daemon never forks an interactive shell.

import log from "../utils/log.js";
import { Shell } from "../utils/shell.js";
import { CommandToken, parseCommand } from "./parser.js";

let loadedAliases: { [key: string]: CommandToken[] | undefined } = {};
let aliasNames: string[] = [];

export const setAliases = (aliases: Record<string, string>) => {
  loadedAliases = {};
  for (const [alias, command] of Object.entries(aliases)) {
    loadedAliases[alias] = parseCommand(command + " ", Shell.Zsh);
  }
  aliasNames = Object.keys(loadedAliases).sort();
};

export const getAliasNames = () => aliasNames;

export const aliasExpand = (command: CommandToken[]): CommandToken[] => {
  if (!command.at(0)?.complete) return command;

  const alias = loadedAliases[command.at(0)?.token ?? ""];
  if (alias) {
    log.debug({ msg: "expanding alias", alias, command: command.slice(1) });
    return [...alias, ...command.slice(1)];
  }
  return command;
};
