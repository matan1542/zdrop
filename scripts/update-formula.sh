#!/bin/sh
# Writes the Homebrew formula for a published release, from the release's checksum files.
#
#   scripts/update-formula.sh <version> <tap checkout dir>     -> <dir>/Formula/zdrop.rb
set -eu
version=${1#v}
tap=$2
repo="matan1542/zdrop"
base="https://github.com/$repo/releases/download/v$version"
sha() { curl -fsSL --retry 3 "$base/zdrop-$version-darwin-$1.tar.xz.sha256" | cut -d' ' -f1; }
arm=$(sha arm64)
intel=$(sha x64)
[ -n "$arm" ] && [ -n "$intel" ] || { echo "release v$version has no checksums" >&2; exit 1; }
mkdir -p "$tap/Formula"
cat >"$tap/Formula/zdrop.rb" <<RUBY
class Zdrop < Formula
  desc "Kiro-style dropdown autocomplete for zsh, for every command on your PATH"
  homepage "https://github.com/$repo"
  version "$version"
  license "MIT"

  if Hardware::CPU.arm?
    url "$base/zdrop-$version-darwin-arm64.tar.xz"
    sha256 "$arm"
  else
    url "$base/zdrop-$version-darwin-x64.tar.xz"
    sha256 "$intel"
  end

  depends_on :macos

  def install
    # self-contained: the daemon, the zsh plugin and a bundled Node.js
    libexec.install Dir["*"]
    bin.install_symlink libexec/"bin/zdrop"
  end

  def caveats
    <<~EOS
      Turn it on (adds one line to the end of ~/.zshrc), then open a new terminal tab:
        zdrop setup
      Check the setup any time with: zdrop doctor
    EOS
  end

  test do
    assert_match "checkout", shell_output("#{bin}/zdrop query 'git ch'")
  end
end
RUBY
echo "$tap/Formula/zdrop.rb -> $version"
