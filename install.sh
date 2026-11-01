#!/bin/sh
# zdrop installer: Kiro-style dropdown autocomplete for zsh.
#
#   curl -fsSL https://github.com/matan1542/zdrop/releases/latest/download/install.sh | sh
#
# Environment:
#   ZDROP_VERSION=0.2.0     install a specific release (default: latest)
#   ZDROP_PREFIX=~/.zdrop   where to install
#   ZDROP_NO_RC=1           do not edit ~/.zshrc
#   ZDROP_TARBALL=<file>    install from a local tarball (testing)
#
# Re-running it updates in place. `zdrop uninstall` removes everything it added.
set -eu

repo="matan1542/zdrop"
prefix="${ZDROP_PREFIX:-$HOME/.zdrop}"
version="${ZDROP_VERSION:-latest}"
zshrc="${ZDOTDIR:-$HOME}/.zshrc"
marker="# zdrop: Kiro-style autocomplete (keep this last)"

say() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(uname -s)" = Darwin ] || die "zdrop releases are built for macOS"
case "$(uname -m)" in
  arm64) arch=arm64 ;;
  x86_64) arch=x64 ;;
  *) die "unsupported architecture: $(uname -m)" ;;
esac
command -v zsh >/dev/null 2>&1 || die "zsh is required"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

if [ -n "${ZDROP_TARBALL:-}" ]; then
  tarball="$ZDROP_TARBALL"
else
  if [ "$version" = latest ]; then
    base="https://github.com/$repo/releases/latest/download"
    # resolve "latest" to a version number to name the asset
    version=$(curl -fsSLI -o /dev/null -w '%{url_effective}' "https://github.com/$repo/releases/latest" | sed 's|.*/tag/v||')
    [ -n "$version" ] || die "could not find the latest release"
  else
    version=${version#v}
    base="https://github.com/$repo/releases/download/v$version"
  fi
  asset="zdrop-$version-darwin-$arch.tar.gz"
  say "Downloading zdrop $version ($arch)"
  curl -fL --progress-bar "$base/$asset" -o "$tmp/$asset" || die "download failed: $base/$asset"
  curl -fsSL "$base/$asset.sha256" -o "$tmp/$asset.sha256" || die "checksum download failed"
  (cd "$tmp" && shasum -a 256 -c "$asset.sha256" >/dev/null) || die "checksum mismatch: refusing to install"
  tarball="$tmp/$asset"
fi

say "Installing into $prefix"
mkdir -p "$prefix/versions"
tar -xzf "$tarball" -C "$tmp"
src=$(find "$tmp" -maxdepth 1 -type d -name 'zdrop-*' | head -1)
[ -n "$src" ] || die "unexpected tarball layout"
installed_version=$(cat "$src/VERSION")
dest="$prefix/versions/$installed_version"
rm -rf "$dest"
mv "$src" "$dest"
touch "$dest" # tar restores the archive's mtime; pruning below keeps the most recently installed
xattr -dr com.apple.quarantine "$dest" 2>/dev/null || true
"$dest/runtime/node" --version >/dev/null 2>&1 || die "the bundled Node.js does not run on this Mac"

# switch atomically; open shells keep working and pick up the new daemon on their next keystroke
ln -sfn "$dest" "$prefix/current.tmp"
mv -fh "$prefix/current.tmp" "$prefix/current" 2>/dev/null || { rm -f "$prefix/current"; mv "$prefix/current.tmp" "$prefix/current"; }
"$prefix/current/bin/zdrop" stop >/dev/null 2>&1 || true

# keep the previous version for shells that still have it loaded; drop older ones
ls -1t "$prefix/versions" | tail -n +3 | while IFS= read -r old; do rm -rf "$prefix/versions/$old"; done

# `zdrop` on PATH, if ~/.local/bin is used
if [ -d "$HOME/.local/bin" ]; then
  ln -sfn "$prefix/current/bin/zdrop" "$HOME/.local/bin/zdrop"
fi

if [ "${ZDROP_NO_RC:-0}" != 1 ]; then
  line="source \"$prefix/current/zsh/zdrop.plugin.zsh\""
  touch "$zshrc"
  if grep -qF "$line" "$zshrc"; then
    :
  else
    cp "$zshrc" "$zshrc.bak-zdrop-$(date +%Y%m%d%H%M%S)"
    # another copy of zdrop (a git checkout) would load twice: comment it out
    if grep -q '^[^#]*zdrop\.plugin\.zsh' "$zshrc"; then
      sed -i '' 's|^\([^#]*zdrop\.plugin\.zsh.*\)$|# \1  # replaced by the zdrop installer|' "$zshrc"
      say "Commented out an older zdrop line in $zshrc"
    fi
    grep -qF "$marker" "$zshrc" || printf '\n%s\n' "$marker" >>"$zshrc"
    printf '%s\n' "$line" >>"$zshrc"
    say "Added zdrop to $zshrc (backup saved next to it)"
  fi
fi

say "zdrop $installed_version installed. Open a new terminal tab (or run: exec zsh)."
cat <<EOF
    Keep the source line LAST in ~/.zshrc (after oh-my-zsh, zsh-autosuggestions, …).
    In VS Code / Cursor, set "terminal.integrated.suggest.enabled": false.
    Update:     zdrop update        Uninstall:  zdrop uninstall
EOF
