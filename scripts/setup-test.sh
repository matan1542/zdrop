#!/bin/sh
# `zdrop setup` / `zdrop uninstall` against Homebrew, installer and source layouts, in a throwaway HOME.
# HOME, ZDOTDIR and XDG_CONFIG_HOME are always set: an inherited ZDOTDIR would edit the real ~/.zshrc,
# and XDG_CONFIG_HOME holds the systemd unit. The login item is skipped (ZDROP_NO_LOGIN=1): loading
# it would touch this user's launchd or systemd session.
set -eu
repo=$(cd "$(dirname "$0")/.." && pwd)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
fails=0
check() { if eval "$2"; then echo "ok   $1"; else echo "FAIL $1"; fails=$((fails + 1)); fi; }
run() { h=$1; shift; HOME="$h" ZDOTDIR="$h" XDG_CONFIG_HOME="$h/.config" ZDROP_HOME="$h/cache" ZDROP_NO_LOGIN=1 "$@" >/dev/null; }

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
check "brew: one marker comment" "[ \$(grep -c 'keep this last' '$b/home/.zshrc') = 1 ]"
run "$b/home" "$b/bin/zdrop" uninstall
check "brew: uninstall removes the line and the marker" "! grep -q 'opt/zdrop\\|keep this last' '$b/home/.zshrc'"

# a ~/.zshrc set up by a release before 0.4.1, whose marker had different wording
o=$tmp/old
mkdir -p "$o"
printf 'export X=1\n\n# zdrop: Kiro-style autocomplete (keep this last)\nsource "%s/opt/zdrop/libexec/zsh/zdrop.plugin.zsh"\n' "$b" >"$o/.zshrc"
run "$o" "$b/bin/zdrop" setup
check "older marker: setup rewords it" "grep -qx '# zdrop: dropdown autocomplete (keep this last)' '$o/.zshrc' && [ \$(grep -c 'keep this last' '$o/.zshrc') = 1 ]"
check "older marker: the source line is kept once" "[ \$(grep -c '^source.*zdrop.plugin.zsh' '$o/.zshrc') = 1 ]"
printf '\n# zdrop: Kiro-style autocomplete (keep this last)\n' >>"$o/.zshrc"
run "$o" "$b/bin/zdrop" uninstall
check "older marker: uninstall removes every wording" "! grep -q 'keep this last\\|zdrop.plugin' '$o/.zshrc' && grep -qx 'export X=1' '$o/.zshrc'"

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
# (a subshell: in sh, an assignment before a function call can outlive the call)
(export ZDROP_NO_RC=1; run "$c" "$c/.local/bin/zdrop" setup)
check "ZDROP_NO_RC=1 leaves ~/.zshrc alone" "[ \$(grep -c zdrop.plugin.zsh '$c/.zshrc') = 1 ]"

# a dotfiles-managed ~/.zshrc (a symlink) stays a symlink when an older line is commented out
d=$tmp/dots
mkdir -p "$d/repo"
printf 'source ~/old/zdrop/zsh/zdrop.plugin.zsh\n' >"$d/repo/zshrc"
ln -s "$d/repo/zshrc" "$d/.zshrc"
run "$d" "$c/.local/bin/zdrop" setup
check "a symlinked ~/.zshrc stays a symlink" "[ -L '$d/.zshrc' ] && grep -q '^# source ~/old' '$d/repo/zshrc'"

[ $fails = 0 ] && echo "setup: all checks passed" || { echo "setup: $fails failed"; exit 1; }
