# zdrop

Kiro CLI–style dropdown autocomplete for zsh: an IDE-like popup while you type `yarn `, `cd `,
`git checkout `, … backed by the 700+ open-source [Fig completion specs](https://github.com/withfig/autocomplete).

```
 $ git ch▌
   › checkout  [branch, file, tag or commit]
   › cherry-pick  commit...
  ────────────────────────────────────────────
   Switch branches or restore working tre  ⌃k
```

- Runs **inside the terminal**: no PTY wrapper, no desktop overlay window, no Accessibility permission.
  Works in Terminal.app, iTerm2 and VS Code / Cursor / Kiro terminals, next to zsh-autosuggestions.
- **Kiro's look and behaviour**, taken from Amazon Q's open-source UI (which Kiro inherited): blue
  selected row, highlighted matches, dimmed argument hints, an italic description bar, ghost text,
  and loading states (marching dots, or a spinner in the description bar while static results show).
- **Every command on your PATH**, not just the 700 with a spec: tools like `claude`, `codex` or your
  team's internal CLIs are learned from their `--help` (run in a sandbox) or man page, with no
  per-tool setup (see [Learned commands](#learned-commands)).
- **Bounded memory**: one shared daemon for every shell, about 55 MB idle and about 80 MB under heavy use,
  with hard caps and a self-restart watchdog (see [Memory](#memory)).

## Install

On macOS (Apple silicon or Intel), with zsh:

```sh
curl -fsSL https://github.com/matan1542/zdrop/releases/latest/download/install.sh | sh
```

Then open a new terminal tab. The installer:
- downloads the release for your Mac and verifies its SHA-256 checksum
- installs into `~/.zdrop`. The release bundles its own Node.js, so nothing else is needed and nvm or
  fnm version switching can't break it.
- adds one `source` line to the end of `~/.zshrc` (backing it up first), and comments out an older
  zdrop line if there is one
- links `zdrop` into `~/.local/bin` if that directory exists

```sh
zdrop update             # latest release (or: zdrop update 0.2.0)
zdrop uninstall          # removes ~/.zdrop, the ~/.zshrc line and the cache
zdrop version
```

Installer options: `ZDROP_VERSION=0.2.0` installs a specific release, `ZDROP_PREFIX=<dir>` sets the
install directory, and `ZDROP_NO_RC=1` leaves `~/.zshrc` alone.

Keep the `source` line **last** in `~/.zshrc`, after oh-my-zsh, zsh-autosuggestions, fzf-tab and so
on, so zdrop's key bindings win. The daemon starts by itself on the first keystroke and stops after 30
idle minutes.

### From source

Requires zsh 5.8+, Node 20+ and yarn.

```sh
git clone https://github.com/matan1542/zdrop ~/zdrop && cd ~/zdrop
yarn install && yarn build
echo 'source ~/zdrop/zsh/zdrop.plugin.zsh' >> ~/.zshrc
```

**Turn off other popups** so two don't compete:
- VS Code / Cursor: set `"terminal.integrated.suggest.enabled": false`.
- Kiro CLI: turn off its autocomplete, or stop launching shells through `kiro-cli-term`.

## Keys (while the popup is open)

The popup opens with nothing selected, so **Enter keeps meaning "run"** until you move into the list.
The rest of the first (or selected) suggestion is previewed after the cursor as dimmed ghost text.

| Key | Action |
|---|---|
| **Enter** | Insert the selected suggestion; with nothing selected, run the command as typed |
| **Tab** | Extend to the common prefix of all suggestions, otherwise insert the selected (or first) one |
| **→ / End / ⌃E** | Accept the ghost text |
| **↓ / ⌃N** | Select the next suggestion |
| **↑ / ⌃P / ⇧Tab** | Previous suggestion; ↑ on the first row closes the popup |
| **Esc** | Close the popup until the next word |
| **⌃K** | Toggle the description bar |

When the popup is closed, or there is no ghost text, every key does exactly what it did before:
→ still accepts zsh-autosuggestions' suggestion.

## Configuration

Set these before sourcing the plugin. Variables marked "daemon" take effect when the daemon next starts (`bin/zdrop stop` restarts it on demand).

| Variable | Default | |
|---|---|---|
| `ZDROP_THEME` | `dark` | `dark` or `light` (Kiro's colour tokens) |
| `ZDROP_ICONS` | `unicode` | `unicode`, `nerd` (needs a Nerd Font) or `none` |
| `ZDROP_WIDTH` | `44` | popup width in cells |
| `ZDROP_MAX_ROWS` | `7` | visible rows |
| `ZDROP_DESCRIPTION` | `1` | show the description bar |
| `ZDROP_WRAP` | `0` | ↓ on the last row wraps to the top |
| `ZDROP_GHOST` | `1` | preview the suggestion after the cursor; `0` turns it off |
| `ZDROP_GHOST_STYLE` | `fg=8` | zle highlight style of the ghost text |
| `ZDROP_SYNC` | `1` | draw each keystroke as one synchronized frame (DEC mode 2026) to avoid flicker; `0` turns it off |
| `ZDROP_DISABLE` | `0` | `1` skips loading the plugin |
| `ZDROP_SPEC_PATH` | | daemon: extra spec directories (colon-separated), searched first |
| `ZDROP_HEAVY_SPECS` | `0` | daemon: `1` enables the aws, gcloud and az specs (82% of all spec bytes) |
| `ZDROP_RSS_LIMIT_MB` | `120` | daemon: restart when resident memory passes this |
| `ZDROP_SPEC_CACHE_MB` | `24` | daemon: estimated heap for loaded specs |
| `ZDROP_IDLE_MINUTES` | `30` | daemon: exit after this long with no shell connected |
| `ZDROP_LEARN` | `1` | daemon: `0` turns off learning commands from `--help` / man pages |
| `ZDROP_LEARN_BACKGROUND` | `1` | daemon: `0` learns only commands you type, never in the background |
| `ZDROP_LEARN_DENY` | | daemon: commands never to run `--help` for (colon-separated; their man page is still used) |
| `ZDROP_LEARN_DAILY` | `500` | daemon: most background probes per day |
| `ZDROP_DEBUG` | `0` | daemon: `1` logs to `~/.cache/zdrop/daemon.log` |

## Commands

```sh
bin/zdrop query "git checkout " --cwd .   # suggestions as JSON (in-process, no daemon needed)
bin/zdrop status                          # daemon memory, loaded specs, caches, child processes
bin/zdrop stop
bin/zdrop learn claude mcp                # learn a command (and subcommand) now, print what was parsed
bin/zdrop why ghidraRun                   # where a command's completions come from, and why
bin/zdrop forget claude                   # drop what was learned (relearned on next use); --all for everything
```

## Ranking

Suggestions follow what you actually do.
- **History:** zdrop reads the end of your `$HISTFILE` (the last 1 MB) when the daemon starts, and then
  learns every command you run.
  - Within prefix matches, the subcommands, flags and first words you use most come first (`git ch` →
    `cherry-pick` if that's your habit). Recent use counts more, with a 30-day half-life.
  - Values you typed before are offered again where the spec has none, marked `↺` (`kubectl -n` →
    `prod`, `git commit -m` → earlier messages). Values of password, token, secret, key and auth flags
    are never offered.
  - Pinned suggestions (like the current branch) stay on top.
- **Directories:** `cd`, `pushd` and `z` also offer the directories you visit most often and most
  recently (zoxide's algorithm), marked `⌂`.
  - With nothing typed, the top three come first. Once you type, the matching ones follow the children.
  - Stored in `~/.cache/zdrop/dirs.tsv` (at most 1,000 directories).
- **Memory:** everything is in memory and capped at 2,000 contexts and 15,000 entries. Your real history
  costs about 2 MB. A deliberately adversarial 60,000-line history settles at +6 MB.

## Learned commands

Commands without a Fig spec are learned automatically. There is no per-tool configuration.

- **When you type one** (`claude `):
  - zdrop reads its `--help` while the popup shows a loading state.
  - The result is cached on disk.
  - Subcommands are learned the first time you reach them (`claude mcp `).
  - After a 300 ms pause in typing, the command or subcommand you are most likely to need next is
    prefetched.
- **In the background:**
  - Shortly after the daemon starts, a separate low-priority worker learns everything else on your PATH.
  - It goes in order: commands from your shell history (most used first, plus their favourite
    subcommands), then your own and Homebrew tools, then system commands from their man pages.
  - After the first run, only new or changed binaries are learned again.
- **Sources, best first:**
  1. your specs
  2. Fig specs
  3. `--help`
  4. the man page
- **Parsing** follows the layouts of commander, clap, cobra, yargs, click, argparse, GNU getopt and mdoc
  man pages: subcommands and aliases, options, which options take a value, choices (`<a|b|c>`, `{a,b}`,
  `[possible values: …]`) and file or folder arguments.

### Safety

Running `x --help` is only safe if `x` actually reads its arguments, so each command is triaged first
(`zdrop why <cmd>` shows the decision).
- **Learned from the man page, never executed:**
  - destructive or privileged tools (`rm`, `dd`, `shutdown`, `sudo`, …), editors, shells and REPLs
  - setuid binaries and system directories (`/sbin`, `/usr/sbin`, `/System`, `/usr/libexec`)
  - application bundles, JVM tools, and macOS's hard-linked tool stubs
  - scripts that never read their arguments or that launch a GUI or JVM application
  - in the background, `/usr/bin` and `/bin` as well
- **Probes run in a sandbox:**
  - macOS: `sandbox-exec`. Linux: `bwrap`, and without it only typed commands are probed.
  - no network
  - writes only inside a throwaway HOME
  - no windows, LaunchServices or `open`
  - no reading of `~/.ssh`, `~/.aws` and other credential stores
- **Environment:** an allow-list, so your tokens and API keys never reach a probed program. stdin is
  `/dev/null`, `NO_COLOR=1 TERM=dumb CI=1`.
- **Limits:** a 5 s CPU limit, a 3 s (typed) / 5 s (background) timeout with the whole process group
  killed, and 256 KB of output at most.
- **A command that hangs** is remembered and not retried in the background.

### Resources

The background worker is designed not to be noticed:
- **A separate process:** V8 lite mode, a 32 MB heap, about 56 MB RSS. It exits after each batch of
  100, so its memory goes back to the OS. Nothing it parses enters the daemon.
- **One probe at a time** at nice 19, with a pause between probes.
- **It freezes while you type:** both the worker and its probe are stopped. It resumes after 2 s of quiet.
- **It starts only on AC power** with spare CPU (1-minute load < 70% of cores) and memory (macOS
  memory-pressure level ≥ 20% available), and checks again every 10 probes.
- **At most 500 probes a day,** so the first full run spreads over several idle periods.
- **Cache:** one JSON file per command in `~/.cache/zdrop/learned`, capped at 32 MB.
  - Files are written atomically.
  - Each is keyed to the binary's path, inode, size and mtime, so an upgrade relearns it while the old
    spec keeps answering.
  - A miss is retried after 1, 7, then 30 days.

Measured on a machine with 1,746 commands on PATH (`yarn budget`):
- The daemon went from 58 to 61.6 MB.
- The worker peaked at 55.7 MB.
- Never more than one probe ran at a time, and none ran while typing.
- Query latency p95 was 0.6 ms during learning.

A command that parses badly can always be overridden by dropping a Fig spec with its name into
`specs/build/`.

## Memory

Kiro's own CLI has had memory leaks: kiro-cli-chat grew about 50 MB/min, and kiro-cli-term held up to
1.5 GB per shell. zdrop is built so it cannot grow without limit:

- **One daemon for all shells.**
  - A second copy refuses to start.
  - The zsh side never forks or spawns a process per keystroke.
- **Specs are evaluated with `new Function`, not `import()`.**
  - ES modules can never be unloaded, so `import()` would keep every spec forever.
  - Specs sit in an LRU capped by estimated bytes. cd, git, npm and yarn are always kept.
  - aws, gcloud and az are off by default.
- **Generator cache:**
  - a total budget of 50k suggestions and at most 2k per generator
  - entries for generators with no cache policy get a TTL
- **Generator processes:**
  - run in their own process group, killed as a group on abort or timeout (`a | b` pipelines too)
  - output capped at 1 MB
  - at most 4 at once across all shells
  - never left waiting on a grandchild that holds the pipe open
- **V8 flags:** `--max-semi-space-size=1 --optimize-for-size --max-old-space-size=96`.
- **Watchdog:** if resident memory passes 120 MB, the daemon exits, and the next keystroke starts a
  fresh one. Restarting is the only way to get memory back from V8.

Measured with `scripts/soak.mjs`, 50,000 keystrokes from 5 simulated shells:
- RSS levelled off at 81 MB.
- Latency to the first reply was p50 0.2 ms and p95 1.9 ms.
- No child processes were left behind.

## Development

```sh
yarn build && yarn test     # unit tests: engine fixtures, memory budgets, process limits
yarn e2e                    # drives a real zsh in a private tmux server
yarn soak                   # 50k-keystroke memory/latency soak
yarn budget                 # background-learning resource budget (RSS, probes, freezing while typing)
scripts/package.sh          # release tarballs into release/ (bundles Node.js for arm64 and x64)
```

Releasing: bump `version` in `package.json`, commit, then push a matching tag (`git tag v0.2.0 && git push
--tags`). The Release workflow tests the code, builds both tarballs, smoke-tests the install, and
publishes them with `install.sh` as a GitHub release. `latest` always points at the newest one.

How it fits together:
- `zsh/zdrop.plugin.zsh` handles keys, hooks and the socket.
- `zsh/zdrop-render.zsh` draws the popup with ANSI, using nerv's reserve-rows-then-paint technique.
- `daemon/src/` holds the daemon. `engine.ts` runs a fast pass first, then a pass after generators finish.
- `daemon/src/learn/` learns commands without a spec:
  - `helpParser.ts`: text to completion tree
  - `gate.ts`: what may be executed
  - `sandbox.ts`, `prober.ts`: running help safely
  - `store.ts`: disk cache
  - `learner.ts`: on demand, in the daemon
  - `worker.ts`, `builder.ts`: the background batch process and its supervisor
- `daemon/vendor/inshellisense/` is the vendored Fig runtime, with the local patches listed in its `SOURCE.md`.

Custom specs go in `specs/build/` (or any directory on `ZDROP_SPEC_PATH`). They are Fig specs compiled
with `npx @withfig/autocomplete-tools compile`, and they override stock specs with the same name.

## Credits

- Completion specs: [withfig/autocomplete](https://github.com/withfig/autocomplete) (MIT).
- Suggestion runtime: vendored from [microsoft/inshellisense](https://github.com/microsoft/inshellisense) (MIT).
- Look and behaviour: [aws/amazon-q-developer-cli-autocomplete](https://github.com/aws/amazon-q-developer-cli-autocomplete).
- In-terminal painting technique: [nerv-sh/nerv](https://github.com/nerv-sh/nerv).
