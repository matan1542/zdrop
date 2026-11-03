#!/bin/sh
# Records docs/demo.gif with vhs (brew install vhs) from docs/demo.tape, in a throwaway setup: a
# fixture project with package.json scripts, a git repo with branches, a CLI that has no Fig spec,
# and a short history. Nothing in your HOME, ~/.zshrc or zdrop cache is read or written.
#
#   yarn build && scripts/demo.sh
set -eu
root=$(cd "$(dirname "$0")/.." && pwd)
command -v vhs >/dev/null || { echo "vhs not found: brew install vhs" >&2; exit 1; }
# short path: the daemon's unix socket lives under it
work=$(mktemp -d /tmp/zdrop-demo.XXXX)
trap 'ZDROP_HOME="$work/zdrop" "$root/bin/zdrop" stop >/dev/null 2>&1; rm -rf "$work"' EXIT

app="$work/app"
mkdir -p "$app/src/components" "$app/docs" "$app/scripts" "$work/bin" "$work/zdrop" "$work/config"
cat >"$app/package.json" <<'EOF'
{ "name": "app", "private": true,
  "scripts": { "build": "vite build", "dev": "vite", "test": "vitest", "lint": "eslint .", "typecheck": "tsc --noEmit" } }
EOF
(
  cd "$app"
  git init -q -b main
  git -c user.email=demo@example.com -c user.name=demo commit -q --allow-empty -m init
  git branch feature/login
  git branch feature/search
  git branch fix/flaky-test
)

# a CLI with no Fig spec: zdrop learns it from --help the first time it is typed
cat >"$work/bin/deploy-tool" <<'EOF'
#!/bin/sh
case "$1" in
  release) printf 'Usage: deploy-tool release [options] <env>\n\nShip a build to an environment\n\nOptions:\n  --canary       Roll out to 5%% first\n  --dry-run      Show the plan only\n  -h, --help     Show help\n' ;;
  *) printf 'Usage: deploy-tool <command> [options]\n\nDeploys our services\n\nCommands:\n  release    Ship a build to an environment\n  rollback   Return to the previous release\n  status     Show what runs where\n  logs       Stream logs from a service\n\nOptions:\n  -v, --verbose  More output\n  -h, --help     Show help\n' ;;
esac
EOF
chmod +x "$work/bin/deploy-tool"

cat >"$work/history" <<'EOF'
: 1790000000:0;git checkout feature/login
: 1790000100:0;git checkout feature/login
: 1790000200:0;yarn build
EOF

cat >"$work/demo.zshrc" <<EOF
export ZDROP_HOME="$work/zdrop" XDG_CONFIG_HOME="$work/config" HISTFILE="$work/history"
export PATH="$work/bin:\$PATH" COLORTERM=truecolor ZDROP_UPDATE_CHECK=0 ZDROP_LEARN_BACKGROUND=0
PS1='%F{39}app%f %F{245}❯%f '
source "$root/zsh/zdrop.plugin.zsh"
cd "$app"
EOF

# warm daemon, so the recording starts at the first keystroke
ZDROP_HOME="$work/zdrop" XDG_CONFIG_HOME="$work/config" "$root/bin/zdrop" start
sleep 1

cd "$root"
ZDROP_DEMO_RC="$work/demo.zshrc" vhs docs/demo.tape
ls -la docs/demo.gif
