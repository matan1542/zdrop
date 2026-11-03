# Contributing to zdrop

Thanks for helping. zdrop is small on purpose: a zsh client that never blocks typing, and one shared
daemon that stays within a fixed memory budget. Most contributions are one of these:
- teaching the help parser a format it gets wrong
- fixing a key or drawing glitch in some terminal or plugin setup
- a ranking or suggestion improvement

## Setup

Requires macOS or Linux, zsh 5.8+, Node 20+, yarn (via `corepack enable`) and tmux (for the e2e).

```sh
git clone https://github.com/matan1542/zdrop && cd zdrop
yarn install && yarn build
zsh -c 'source zsh/zdrop.plugin.zsh'   # or add `source <checkout>/zsh/zdrop.plugin.zsh` to ~/.zshrc
```

After changing daemon code, `yarn build`. A running daemon notices that its code changed and exits;
the next keystroke starts the new one. Plugin changes need a new terminal tab (or `exec zsh`).

## Tests

All of these run in CI; run the ones your change touches before opening a PR.

| Command | What it checks |
|---|---|
| `yarn test` | unit tests: engine fixtures, help parsing, ranking, config, memory and process limits |
| `yarn e2e [zsh-autosuggestions.zsh]` | drives a real zsh in a private tmux server and checks the screen: keys, drawing (one synchronized frame per key), ghost text, history, learned CLIs, docs panel, config |
| `yarn setup-test` | `zdrop setup` / `uninstall` in Homebrew, installer and source layouts, in a throwaway HOME |
| `yarn budget` | background learning stays within its budget: daemon and worker RSS, one probe at a time, frozen while you type |
| `yarn soak` | 50k keystrokes: memory stays flat, latency stays low |

Tests never touch your real setup: `ZDROP_HOME` and `XDG_CONFIG_HOME` point at temp folders. Keep it
that way in new tests, and always set both `HOME` and `ZDOTDIR` when a test runs zsh or `zdrop setup`.

## How it fits together

```
zsh (zdrop.plugin.zsh) ── one line per keystroke ──▶ daemon (one per user, shared by every shell)
   draws the popup      ◀── suggestions (R lines) ──   engine.ts: Fig specs + learned specs + ranking
```

- `zsh/zdrop.plugin.zsh` handles keys, hooks and the socket; `zsh/zdrop-render.zsh` draws the popup
  with raw ANSI: it reserves rows with `zle -R`, then does one synchronized paint.
- `daemon/src/protocol.ts` documents the line protocol: fields split by 0x1f and records by 0x1e, so
  zsh can parse it without forking.
- `daemon/src/engine.ts` answers a query with a fast pass first (static results plus cached generator
  output, with loading states), then again once generators finish. It ranks with `rank/usage.ts`
  (history), `rank/dirs.ts` (folder frecency) and `rank/typo.ts` ("did you mean").
- `daemon/src/learn/` learns commands that have no Fig spec:
  `gate.ts` (may we run it?) → `sandbox.ts` (no network, no writes, no credentials) → `prober.ts`
  (`--help`, `help <sub>`, man page) → `helpParser.ts` (text to tree) → `figSpec.ts` (tree to Fig spec)
  → `store.ts` (disk cache). `learner.ts` does this on demand; `worker.ts` and `builder.ts` do it in
  the background, only on AC power and when the machine is idle.
- `daemon/src/config.ts` is the settings table (the plugin reads the shell keys itself, from the same
  file).
- `daemon/vendor/inshellisense/` is the vendored Fig runtime. Every local change is marked with a
  `zdrop:` comment and listed in its `SOURCE.md`; keep both up to date.

## Hard rules

- **Never block typing.** The zsh side forks nothing per keystroke and waits for nothing; replies
  arrive through a `zle -F` handler.
- **Memory has a budget.** Daemon idle about 65 MB, background worker 64 MB; `yarn budget` and
  `limits.test.ts` fail when a change goes over. Caches are capped by bytes or entries, never unbounded.
- **Nothing runs unsandboxed in the background.** A command is only run with `--help` in the sandbox,
  or, without one, only when the user typed it. Probes get an allow-listed environment (no tokens or
  keys).
- **No flicker.** Each keypress reaches the terminal as one synchronized frame; the e2e checks this.

## Teaching the help parser a new format

1. Capture the help: `<tool> --help > daemon/test/fixtures/help/<tool>.txt` (or `man -P cat <tool>`
   for a man page). Remove anything private.
2. Add a test to `daemon/test/helpParser.test.ts`, like the existing ones: subcommands, option names
   and aliases, argument names, choices.
3. Change `daemon/src/learn/helpParser.ts` until it passes without breaking the other fixtures. If the
   output for already-learned tools changes, bump `PARSER_VERSION` so cached specs are re-learned.

`zdrop why <tool>` shows where a command's completions come from, and `zdrop learn <tool>` re-learns
it now and prints the result.

## Pull requests

- One change per PR, with tests. The PR template has the checklist.
- Match the surrounding code: comments explain why, not what; names over comments.
- Commit messages: a short summary line, then what changed and why.

## Releases (maintainers)

Bump `version` in `package.json`, commit, and push a matching tag (`git tag vX.Y.Z && git push --tags`).
The Release workflow tests, builds the tarballs, smoke-tests the installer and publishes the GitHub
release; then run `scripts/update-formula.sh X.Y.Z <tap checkout>` and push the tap (or let the
workflow do it when the `TAP_TOKEN` secret is set).
