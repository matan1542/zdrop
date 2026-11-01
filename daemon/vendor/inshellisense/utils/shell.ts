// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// zdrop: trimmed to the enum and path helpers the runtime uses; shell setup/detection is not needed.

import path from "node:path";

export enum Shell {
  Bash = "bash",
  Powershell = "powershell",
  Pwsh = "pwsh",
  Zsh = "zsh",
  Fish = "fish",
  Cmd = "cmd",
  Xonsh = "xonsh",
  Nushell = "nu",
}

export const getPathSeparator = (shell: Shell) => (shell == Shell.Bash || shell == Shell.Xonsh || shell == Shell.Nushell ? "/" : path.sep);

export const removePathSeparator = (dir: string) => {
  return dir.endsWith("/") || dir.endsWith("\\") ? dir.slice(0, -1) : dir;
};

export const addPathSeparator = (dir: string, shell: Shell) => {
  const pathSep = getPathSeparator(shell);
  return dir.endsWith(pathSep) ? dir : dir + pathSep;
};

export const getPathDirname = (dir: string, shell: Shell) => {
  const pathSep = getPathSeparator(shell);
  return dir.endsWith(pathSep) || path.dirname(dir) == "." ? dir : addPathSeparator(path.dirname(dir), shell);
};

export const endsWithPathSeparator = (dir: string, shell: Shell) => {
  const pathSep = getPathSeparator(shell);
  return dir.endsWith(pathSep);
};
