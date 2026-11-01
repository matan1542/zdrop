#!/bin/sh
# Builds self-contained release tarballs: compiled daemon, zsh plugin, runtime dependencies and a
# bundled Node.js, so the install needs nothing but a Mac. Nothing is compiled natively, so both
# architectures are packaged from any machine.
#
#   scripts/package.sh [arm64|x64 ...]     (default: both)  -> release/zdrop-<version>-darwin-<arch>.tar.xz
#
# The aws, gcloud and az specs (off by default, ~80% of all spec bytes) ship separately as
# zdrop-heavy-specs-<version>.tar.xz, installed on request with `zdrop extras install`.
set -eu
root=$(cd "$(dirname "$0")/.." && pwd)
cd "$root"

node_version=24.18.0
version=$(node -p 'require("./package.json").version')
archs=${*:-arm64 x64}
out="$root/release"
cache="$root/.cache/node"
mkdir -p "$out" "$cache"

[ -f dist/src/cli.js ] || { echo "run yarn build first" >&2; exit 1; }

curl -fsSL "https://nodejs.org/dist/v$node_version/SHASUMS256.txt" -o "$cache/SHASUMS256-$node_version.txt"

for arch in $archs; do
  name="zdrop-$version-darwin-$arch"
  stage=$(mktemp -d)/$name
  mkdir -p "$stage/runtime" "$stage/node_modules/@withfig/autocomplete"

  # Node.js, verified against the official checksums
  node_tar="node-v$node_version-darwin-$arch.tar.gz"
  [ -f "$cache/$node_tar" ] || curl -fsSL "https://nodejs.org/dist/v$node_version/$node_tar" -o "$cache/$node_tar"
  expected=$(grep " $node_tar\$" "$cache/SHASUMS256-$node_version.txt" | cut -d' ' -f1)
  actual=$(shasum -a 256 "$cache/$node_tar" | cut -d' ' -f1)
  [ "$expected" = "$actual" ] || { echo "checksum mismatch for $node_tar" >&2; exit 1; }
  tar -xzf "$cache/$node_tar" -C "$stage/runtime" --strip-components 2 "node-v$node_version-darwin-$arch/bin/node"
  tar -xzf "$cache/$node_tar" -O "node-v$node_version-darwin-$arch/LICENSE" >"$stage/runtime/LICENSE"

  # the app: compiled daemon, zsh plugin, launcher, and only the runtime parts of its dependencies
  cp -R bin zsh dist "$stage/"
  rm -rf "$stage/dist/test"
  cp daemon/vendor/inshellisense/LICENSE "$stage/dist/vendor/inshellisense/LICENSE"
  cp package.json README.md LICENSE THIRD_PARTY_NOTICES.md install.sh "$stage/"
  cp -R node_modules/@withfig/autocomplete/package.json node_modules/@withfig/autocomplete/LICENSE node_modules/@withfig/autocomplete/build \
    "$stage/node_modules/@withfig/autocomplete/"
  rm -rf "$stage/node_modules/@withfig/autocomplete/build/"aws* "$stage/node_modules/@withfig/autocomplete/build/"gcloud* "$stage/node_modules/@withfig/autocomplete/build/"az*
  cp -R node_modules/fuzzysort "$stage/node_modules/"
  printf '%s\n' "$version" >"$stage/VERSION"

  tar -C "$(dirname "$stage")" -cf - "$name" | xz -9 -T0 >"$out/$name.tar.xz"
  (cd "$out" && shasum -a 256 "$name.tar.xz" >"$name.tar.xz.sha256")
  rm -rf "$(dirname "$stage")"
  echo "$out/$name.tar.xz ($(du -h "$out/$name.tar.xz" | cut -f1))"
done

heavy="zdrop-heavy-specs-$version"
(cd node_modules/@withfig/autocomplete/build && tar -cf - aws* gcloud* az*) | xz -9 -T0 >"$out/$heavy.tar.xz"
(cd "$out" && shasum -a 256 "$heavy.tar.xz" >"$heavy.tar.xz.sha256")
echo "$out/$heavy.tar.xz ($(du -h "$out/$heavy.tar.xz" | cut -f1))"
cp install.sh "$out/install.sh"
