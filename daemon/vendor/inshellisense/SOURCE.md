# Vendored from microsoft/inshellisense

- Upstream: https://github.com/microsoft/inshellisense
- Commit: `9ba441d39468a73d4e6aebe8bff9af37fad92e86`
- Files: `src/runtime/*` (minus `initialize.ts`, `replacement.ts`) plus `src/utils/{time,unicode}.ts`.
  `utils/{shell,log,performance}.ts` are trimmed rewrites of the upstream files.
- License: MIT (see `LICENSE`).

## Local patches (search for `zdrop:` comments)

- `runtime.ts`: specs come from an injected `SpecProvider` (byte-capped LRU, `new Function` loading)
  instead of `import()`, which can never be unloaded. Aliases are pushed in by the zsh client.
- `utils.ts`: generator processes run in their own process group, are killed as a group on
  abort/timeout, have a stdout cap, resolve on `exit` + hard deadline, and share a concurrency limit.
- `generatorCache.ts`: total-suggestion budget, per-generator cap, TTL for implicit entries, and a
  "fast" mode that reports pending generators instead of awaiting them (used for loading states).
- `suggestion.ts`: icons are semantic keys (rendered by zsh), fuzzy filtering uses fuzzysort.
- `alias.ts`: aliases are set by the client instead of spawning `zsh -i -c alias`.
- `runtime.ts` (learning): `SpecProvider.describe` gives first-word suggestions a description, and a
  string `loadSpec` that resolves to nothing (still being learned) no longer clears `loadSpec`.
- `utils.ts` (learning): the child runner is exported as `runProcess` with a caller-supplied
  environment, output cap, nice value and a `timedOut` flag, for sandboxed `--help` probes.
- `generatorCache.ts` (learning): `GenerationContext.labels` names what a pending item is waiting for.
