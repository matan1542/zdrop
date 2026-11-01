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
mkdir -p "$app/src" "$app/docs" "$work/zdot" "$work/home"
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
${1:+source $1}
source "$root/zsh/zdrop.plugin.zsh"
cd "$app"
EOF

$tmux_ -f /dev/null new-session -d -x 100 -y 30 -s t \
  "env ZDOTDIR=$work/zdot ZDROP_HOME=$work/home ZDROP_LEARN_BACKGROUND=0 COLORTERM=truecolor TERM=xterm-256color zsh -i"
sleep 1.5

send() { $tmux_ send-keys -t t "$@"; sleep 0.5; }
text() { $tmux_ send-keys -t t -l "$1"; sleep 0.6; }
screen() { $tmux_ capture-pane -t t -p; }
check() { # check <description> <grep -E pattern> [absent]
  if screen | grep -Eq -- "$2"; then found=1; else found=0; fi
  if [ "${3:-}" = absent ]; then found=$((1 - found)); fi
  if [ $found = 1 ]; then echo "ok   $1"; else echo "FAIL $1"; screen | sed 's/^/     | /'; failures=$((failures + 1)); fi
}

text "git ch";            check "subcommands appear while typing" "› checkout"
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
                          check "Enter inserts the selection" '^\$ git checkout *$'
                          check "next token lists branches, current first" "★ main"
send Escape;              check "Esc closes the popup" "★ main" absent
send C-u; text "yarn ";   check "yarn lists package.json scripts" "build:watch"
text "b"; send Tab;       check "Tab completes a script" '^\$ yarn build'
send C-u; text "cd ";     check "cd lists folders" "▸ docs"
                          check "cd does not list files" "package.json" absent
send C-u; text "fakecl"; check "every command on PATH is offered" "fakecli"
text "i "; sleep 1;       check "a CLI without a spec is learned from --help" "› deploy"
send Down;                check "learned subcommands carry descriptions" "Deploy a target"
send C-u; text "fakecli deploy --"; sleep 1
                          check "learned subcommand flags" "--dry-run"
send C-u; text "echo e2e-ran"; send Enter
                          check "Enter runs a command when nothing is selected" "^e2e-ran"

[ $failures = 0 ] && echo "all e2e checks passed" || echo "$failures e2e check(s) failed"
exit $failures
