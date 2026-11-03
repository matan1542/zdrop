#!/bin/sh
# zdrop installer: Kiro-style dropdown autocomplete for zsh, on macOS and Linux (glibc).
#
#   curl -fsSL https://github.com/matan1542/zdrop/releases/latest/download/install.sh | sh
#
# Environment:
#   ZDROP_VERSION=0.2.0     install a specific release (default: latest)
#   ZDROP_PREFIX=~/.zdrop   where to install
#   ZDROP_NO_RC=1           do not edit ~/.zshrc
#   ZDROP_NO_LOGIN=1        do not start the daemon at login
#   ZDROP_TARBALL=<file>    install from a local tarball (testing)
#
# Re-running it updates in place. `zdrop uninstall` removes everything it added.
set -eu

repo="matan1542/zdrop"
prefix="${ZDROP_PREFIX:-$HOME/.zdrop}"
version="${ZDROP_VERSION:-latest}"
zshrc="${ZDOTDIR:-$HOME}/.zshrc"

say() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

case "$(uname -s)" in
  Darwin) os=darwin ;;
  Linux)
    os=linux
    # the bundled Node.js needs glibc 2.28+ (Debian 10, Ubuntu 20.04, RHEL 8 and later)
    if ldd --version 2>&1 | grep -qi musl; then die "musl (Alpine) is not supported: the bundled Node.js needs glibc"; fi
    glibc=$(getconf GNU_LIBC_VERSION 2>/dev/null | sed 's/[^0-9.]//g')
    case "$glibc" in
      2.[0-9] | 2.1[0-9] | 2.2[0-7]) die "glibc $glibc is too old: the bundled Node.js needs 2.28 or later" ;;
    esac
    command -v xz >/dev/null 2>&1 || die "xz is required to unpack the release (apt install xz-utils / dnf install xz)"
    ;;
  *) die "zdrop releases are built for macOS and Linux" ;;
esac
case "$(uname -m)" in
  arm64 | aarch64) arch=arm64 ;;
  x86_64 | amd64) arch=x64 ;;
  *) die "unsupported architecture: $(uname -m)" ;;
esac
command -v zsh >/dev/null 2>&1 || die "zsh is required"
sha256_check() { if command -v shasum >/dev/null 2>&1; then shasum -a 256 -c "$1"; else sha256sum -c "$1"; fi; }

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

if [ -n "${ZDROP_TARBALL:-}" ]; then
  tarball="$ZDROP_TARBALL"
else
  if [ "$version" = latest ]; then
    base="https://github.com/$repo/releases/latest/download"
    # resolve "latest" to a version number to name the asset
    version=$(curl -fsSLI --retry 3 --connect-timeout 15 -o /dev/null -w '%{url_effective}' "https://github.com/$repo/releases/latest" | sed 's|.*/tag/v||')
    [ -n "$version" ] || die "could not find the latest release"
  else
    version=${version#v}
    base="https://github.com/$repo/releases/download/v$version"
  fi
  asset="zdrop-$version-$os-$arch.tar.xz"
  say "Downloading zdrop $version ($arch)"
  # retries cover a dropped connection to GitHub's release CDN
  curl -fL --retry 3 --retry-delay 2 --connect-timeout 15 --progress-bar "$base/$asset" -o "$tmp/$asset" || die "download failed: $base/$asset"
  curl -fsSL --retry 3 --retry-delay 2 --connect-timeout 15 "$base/$asset.sha256" -o "$tmp/$asset.sha256" || die "checksum download failed"
  (cd "$tmp" && sha256_check "$asset.sha256" >/dev/null) || die "checksum mismatch: refusing to install"
  tarball="$tmp/$asset"
fi

say "Installing into $prefix"
mkdir -p "$prefix/versions"
tar -xf "$tarball" -C "$tmp"   # .tar.xz (or .tar.gz for releases before 0.2.0)
src=$(find "$tmp" -maxdepth 1 -type d -name 'zdrop-*' | head -1)
[ -n "$src" ] || die "unexpected tarball layout"
installed_version=$(cat "$src/VERSION")
dest="$prefix/versions/$installed_version"
rm -rf "$dest"
mv "$src" "$dest"
touch "$dest" # tar restores the archive's mtime; pruning below keeps the most recently installed
if [ $os = darwin ]; then xattr -dr com.apple.quarantine "$dest" 2>/dev/null || true; fi
"$dest/runtime/node" --version >/dev/null 2>&1 || die "the bundled Node.js does not run on this Mac"

# switch atomically; open shells keep working and pick up the new daemon on their next keystroke
ln -sfn "$dest" "$prefix/current.tmp"
# (BSD mv -h / GNU mv -T: replace the link itself, not move into the directory it points to)
mv -fh "$prefix/current.tmp" "$prefix/current" 2>/dev/null || mv -fT "$prefix/current.tmp" "$prefix/current" 2>/dev/null ||
  { rm -f "$prefix/current"; mv "$prefix/current.tmp" "$prefix/current"; }
"$prefix/current/bin/zdrop" stop >/dev/null 2>&1 || true

# keep the previous version for shells that still have it loaded; drop older ones
ls -1t "$prefix/versions" | tail -n +3 | while IFS= read -r old; do rm -rf "$prefix/versions/$old"; done

# `zdrop` on PATH, if ~/.local/bin is used
if [ -d "$HOME/.local/bin" ]; then
  ln -sfn "$prefix/current/bin/zdrop" "$HOME/.local/bin/zdrop"
fi

# the ~/.zshrc line and the login item (it honours ZDROP_NO_RC and ZDROP_NO_LOGIN)
if ! "$prefix/current/bin/zdrop" setup 2>/dev/null; then
  # releases before 0.2.2 have no `zdrop setup`
  [ "${ZDROP_NO_RC:-0}" = 1 ] || say "Add this line to the end of $zshrc: source \"$prefix/current/zsh/zdrop.plugin.zsh\""
fi

say "zdrop $installed_version installed."
cat <<EOF
    Keep the source line LAST in ~/.zshrc (after oh-my-zsh, zsh-autosuggestions, …).
    In VS Code / Cursor, set "terminal.integrated.suggest.enabled": false.
    Update:     zdrop update        Uninstall:  zdrop uninstall
EOF
