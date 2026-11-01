import { AsyncLocalStorage } from "node:async_hooks";

/** The environment of the shell a request came from. The daemon is shared, so its own PATH is not the user's. */
export type ShellEnv = { path: string; histfile?: string; cwd?: string };

export const requestEnv = new AsyncLocalStorage<ShellEnv>();

export const currentEnv = (): ShellEnv => requestEnv.getStore() ?? { path: process.env.PATH ?? "/usr/bin:/bin" };
