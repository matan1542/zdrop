#!/bin/sh
# `zdrop setup` / `zdrop uninstall` against Homebrew, installer and source layouts, in a throwaway HOME.
# HOME and ZDOTDIR are always both set: an inherited ZDOTDIR would edit the real ~/.zshrc.
# The login item is skipped (ZDROP_NO_LOGIN=1): loading it would touch this user's launchd domain.
set -eu
repo=$(cd "$(dirname "$0")/.." && pwd)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
fails=0
check() { if eval "$2"; then echo "ok   $1"; else echo "FAIL $1"; fails=$((fails + 1)); fi; }
run() { h=$1; shift; HOME="$h" ZDOTDIR="$h" ZDROP_HOME="$h/cache" ZDROP_NO_LOGIN=1 "$@" >/dev/null; }

# Homebrew: <prefix>/bin/zdrop -> ../Cellar/zdrop/<v>/libexec/bin/zdrop
b=$tmp/brew
mkdir -p "$b/Cellar/zdrop/9.9.9/libexec/bin" "$b/bin" "$b/home"
cp "$repo/bin/zdrop" "$b/Cellar/zdrop/9.9.9/libexec/bin/"
ln -s ../Cellar/zdrop/9.9.9/libexec/bin/zdrop "$b/bin/zdrop"
printf 'export X=1\nsource ~/old/zdrop/zsh/zdrop.plugin.zsh\n' >"$b/home/.zshrc"
run "$b/home" "$b/bin/zdrop" setup
run "$b/home" "$b/bin/zdrop" setup
check "brew: sources the opt/ path, not the Cellar" "grep -qxF 'source \"$b/opt/zdrop/libexec/zsh/zdrop.plugin.zsh\"' '$b/home/.zshrc'"
check "brew: running setup twice adds one line" "[ \$(grep -c '^source.*zdrop.plugin.zsh' '$b/home/.zshrc') = 1 ]"
check "brew: an older zdrop line is commented out" "grep -q '^# source ~/old/zdrop' '$b/home/.zshrc'"
check "brew: other lines kept, backup taken" "grep -qx 'export X=1' '$b/home/.zshrc' && ls -a '$b/home' | grep -q bak-zdrop"
run "$b/home" "$b/bin/zdrop" uninstall
check "brew: uninstall removes the line and the marker" "! grep -q 'opt/zdrop\\|Kiro-style' '$b/home/.zshrc'"

# installer: ~/.local/bin/zdrop -> ~/.zdrop/current/bin/zdrop, current -> versions/<v>
c=$tmp/curl/home
mkdir -p "$c/.zdrop/versions/9.9.9/bin" "$c/.local/bin"
cp "$repo/bin/zdrop" "$c/.zdrop/versions/9.9.9/bin/"
ln -s "$c/.zdrop/versions/9.9.9" "$c/.zdrop/current"
ln -s "$c/.zdrop/current/bin/zdrop" "$c/.local/bin/zdrop"
run "$c" "$c/.local/bin/zdrop" setup
check "installer: sources current/" "grep -qxF 'source \"$c/.zdrop/current/zsh/zdrop.plugin.zsh\"' '$c/.zshrc'"
rm -f "$c/.zshrc"
run "$c" "$c/.zdrop/versions/9.9.9/bin/zdrop" setup
check "installer: run from versions/, still sources current/" "grep -qxF 'source \"$c/.zdrop/current/zsh/zdrop.plugin.zsh\"' '$c/.zshrc'"
ZDROP_NO_RC=1 run "$c" "$c/.local/bin/zdrop" setup
check "ZDROP_NO_RC=1 leaves ~/.zshrc alone" "[ \$(grep -c zdrop.plugin.zsh '$c/.zshrc') = 1 ]"

[ $fails = 0 ] && echo "setup: all checks passed" || { echo "setup: $fails failed"; exit 1; }
