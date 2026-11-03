#!/bin/sh
# End-to-end check of the zsh plugin: drives a real interactive zsh in a private tmux server and
# asserts on what is on screen. Needs tmux and a built daemon (yarn build).
#
#   scripts/e2e.sh [path/to/zsh-autosuggestions.zsh]
set -u
root=$(cd "$(dirname "$0")/.." && pwd)
work=$(mktemp -d "${TMPDIR:-/tmp}/zdrop-e2e.XXXXXX")
tmux_="tmux -L zdrop-e2e-$$"
failures=0

cleanup() { $tmux_ kill-server 2>/dev/null; ZDROP_HOME="$work/home" "$root/bin/zdrop" stop >/dev/null 2>&1; rm -rf "$work"; }
trap cleanup EXIT

# fixture project: package.json scripts, folders, a git repo with branches
app="$work/app"
mkdir -p "$app/src" "$app/docs" "$app/deep/inner" "$work/zdot" "$work/home"
printf '{ "name": "app", "scripts": { "build": "tsc", "build:watch": "tsc -w", "test": "vitest" } }\n' >"$app/package.json"
(cd "$app" && git init -q -b main && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m init && git branch feature/login)

# a CLI with no Fig spec, learned from its --help
mkdir -p "$work/fakebin"
cat >"$work/fakebin/fakecli" <<'EOF2'
#!/bin/sh
# usage: fakecli [--help]
case "$1" in
  deploy) printf 'Usage: fakecli deploy [options]\n\nOptions:\n  --force     Skip checks\n  --dry-run   Print only\n' ;;
  *) printf 'Usage: fakecli [command]\n\nA fake deployment tool\n\nCommands:\n  deploy   Deploy a target\n  status   Show status\n\nOptions:\n  -v, --verbose  Verbose\n  -h, --help     Help\n' ;;
esac
EOF2
chmod +x "$work/fakebin/fakecli"

cat >"$work/zdot/.zshrc" <<EOF
PS1='\$ '
PATH="$work/fakebin:\$PATH"
alias g=git
${1:+source $1}
source "$root/zsh/zdrop.plugin.zsh"
cd "$app"
EOF

$tmux_ -f /dev/null new-session -d -x 100 -y 30 -s t \
  "env ZDOTDIR=$work/zdot XDG_CONFIG_HOME=$work/config ZDROP_HOME=$work/home ZDROP_LEARN_BACKGROUND=0 ZDROP_TEST_NOTICE='zdrop 9.9.9 available' COLORTERM=truecolor TERM=xterm-256color zsh -d -i"
sleep 1.5

send() { $tmux_ send-keys -t t "$@"; sleep 0.5; }
text() { $tmux_ send-keys -t t -l "$1"; sleep 0.6; }
screen() { $tmux_ capture-pane -t t -p; }
# wait_for <grep -E pattern> <seconds>: until the pattern is on screen (for slow cold starts)
wait_for() { i=0; while [ $i -lt $(( $2 * 5 )) ] && ! screen | grep -Eq -- "$1"; do sleep 0.2; i=$((i + 1)); done; }
check() { # check <description> <grep -E pattern> [absent]
  if screen | grep -Eq -- "$2"; then found=1; else found=0; fi
  if [ "${3:-}" = absent ]; then found=$((1 - found)); fi
  if [ $found = 1 ]; then echo "ok   $1"; else echo "FAIL $1"; screen | sed 's/^/     | /'; failures=$((failures + 1)); fi
}

text "git ch";            check "subcommands appear while typing" "› checkout"
                          check "an update notice shows in the first popup" "zdrop 9.9.9 available"
                          check "ghost text previews the first suggestion" '^\$ git checkout'
                          check "no run-as-typed row" "Immediately execute" absent
if $tmux_ capture-pane -t t -p -e | grep '48;2;30;90;199m' | sed 's/\x1b\[[0-9;]*m//g' | grep -q 'checkout'; then echo "ok   the first row is highlighted (Kiro blue)"
else echo "FAIL the first row is highlighted (Kiro blue)"; failures=$((failures + 1)); fi
send Down;                check "Down moves the selection (description follows)" "Apply the changes"

# flicker guard: a keypress must reach the terminal as one synchronized frame (DEC 2026), with
# zle's clear and our repaint inside it and exactly one paint
frame_check() {
  : >"$work/keys.bin"
  $tmux_ pipe-pane -t t -o "cat >> '$work/keys.bin'"
  send Down
  $tmux_ pipe-pane -t t
  python3 -I - "$work/keys.bin" <<'PY2'
import sys
d = open(sys.argv[1], "rb").read()
begin, end = d.find(b"\x1b[?2026h"), d.rfind(b"\x1b[?2026l")
outside = d[:begin] + d[end:] if begin != -1 and end > begin else d
ok = d.count(b"\x1b[?2026h") == 1 and d.count(b"\x1b[?2026l") == 1 and d.count(b"\x1b7") == 1
ok = ok and outside.count(b"\x1b[J") == 0 and outside.count(b"\x1b7") == 0
sys.exit(0 if ok else 1)
PY2
}
send Up
if frame_check; then echo "ok   moving through the list is one synchronized frame per key"; else echo "FAIL moving through the list is one synchronized frame per key"; failures=$((failures + 1)); fi
send Up; send Enter
                          check "Enter fills in the highlighted row" '^\$ git checkout *$'
                          check "next token lists branches, current first" "★ main"
send Escape;              check "Esc closes the popup" "★ main" absent
send C-u; text "yarn ";   check "yarn lists package.json scripts" "build:watch"
text "b"; send Enter;     check "Enter fills in a partly typed word" '^\$ yarn build *$'
send C-u; text "git ch"; send Tab
                          check "Tab moves to the next row" "Apply the changes"
send BTab;                check "Shift-Tab moves back" "Switch branches"
send C-u; text "git chec"; send Right
                          check "→ fills in the highlighted row" '^\$ git checkout *$'
send C-u; text "cd ";     check "cd lists folders" "▸ docs"
                          check "the notice shows only once per shell" "9.9.9" absent
                          check "cd does not list files" "package.json" absent
send C-u; text "fakecl"; check "every command on PATH is offered" "fakecli"
text "i "; sleep 1;       check "a CLI without a spec is learned from --help" "› deploy"
                          check "learned subcommands carry descriptions" "Deploy a target"
send C-u; text "fakecli deploy --"; sleep 1
                          check "learned subcommand flags" "--dry-run"
# history and frecency come from what the shell actually runs
send C-u; text "git cherry-pick --abort 2>/dev/null; cd deep/inner; cd ../.."; send Enter; sleep 0.5
text "git ch";            check "what you ran ranks first (ghost shows it)" '^\$ git cherry-pick'
send C-u; text "cd ";     check "cd offers a frecent directory" "⌂ .*deep/inner/"
send C-u; text "ls "; send Enter
                          check "after a space Enter runs the line" "^.*build:watch|^app|package\.json"
send C-u; text "git status"; send Enter
                          check "Enter runs when the word is already the suggestion" "On branch main"
send C-u; text "echo e2e-ran"; send Enter
                          check "Enter runs a command with no suggestions" "^e2e-ran"
# typed one key at a time (as people do), zle shifts highlight offsets: the ghost's dim style must not
# stay on the text once the suggestion is filled in
send C-u
for key in g i t Space c h; do $tmux_ send-keys -t t "$key"; sleep 0.15; done; sleep 0.5
send Tab; send Tab; send Enter
if $tmux_ capture-pane -t t -p -e | grep -F '$ git ch' | tail -1 | grep -q "$(printf '\033')\\[90m"; then echo "FAIL a filled-in suggestion is not left dimmed"; failures=$((failures + 1))
else echo "ok   a filled-in suggestion is not left dimmed"; fi

# aliases, functions and typos
send C-u; text "g ch";    check "an alias completes like its command" "› checkout"
send C-u; text "zzhello() { echo hi }"; send Enter
text "zzhe";              check "a function defined in the session is offered" "zzhello"
send C-u; text "gti status "
                          check "a mistyped command offers a fix" "did you mean: git status"
send Enter;               check "Enter applies the fix instead of running" '^\$ git status *$'
send C-u
# the docs panel: beside the list when there is room, below it otherwise; ⌃K cycles side → below → off
send C-u; text "git ch";  check "the docs panel sits beside the list" "› c[a-z-]+ .{10,}(Switch branches|Apply the changes)"
                          check "the panel says what the item is" "command +⌃k"
send C-k;                 check "⌃K moves the description below the list" "^ +─{20,}"
send C-k;                 check "⌃K again hides it" "Switch branches|Apply the changes" absent
send C-k;                 check "⌃K again brings the panel back" "› c[a-z-]+ .{10,}(Switch branches|Apply the changes)"
$tmux_ resize-window -t t -x 70; sleep 0.3
send C-u; text "git ch";  check "a narrow window gets the description below" "^ +─{20,}"
$tmux_ resize-window -t t -x 100; sleep 0.3
send C-u
# the config file: a new shell picks up its keys
mkdir -p "$work/config/zdrop"
printf '# e2e\naccent = #AA0000\nrows = 2\n' >"$work/config/zdrop/config"
text "exec zsh -d -i"; send Enter; sleep 1
send C-u; text "git ch"; sleep 1
if $tmux_ capture-pane -t t -p -e | grep '48;2;170;0;0m' | sed 's/\x1b\[[0-9;]*m//g' | grep -q 'c[a-z-]* '; then echo "ok   the config file sets the highlight colour"
else echo "FAIL the config file sets the highlight colour"; $tmux_ capture-pane -t t -p -e | grep -v "^$" | tail -8 | cat -v | sed 's/^/     | /'; failures=$((failures + 1)); fi
send C-u; text "cd ";     check "folders are listed after the restart" "▸ d"
                          check "the config file sets the number of rows" "▸ src" absent
# a cold start answers without another keystroke
send C-u; ZDROP_HOME="$work/home" "$root/bin/zdrop" stop >/dev/null 2>&1; sleep 0.3
text "git ch"; wait_for "› c[a-z-]+ " 8
                          check "the first keystrokes after a cold start get a popup" "› c[a-z-]+ "
send C-u

[ $failures = 0 ] && echo "all e2e checks passed" || echo "$failures e2e check(s) failed"
exit $failures
