// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// zdrop: timing hooks are no-ops; the daemon reports its own stats via `zdrop status`.

export const startTiming = (): bigint | undefined => undefined;

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export const endTiming = (_name: string, _start: bigint | undefined): void => {};
