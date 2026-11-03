#!/bin/sh
# Writes the Homebrew formula for a published release, from the release's checksum files.
#
#   scripts/update-formula.sh <version> <tap checkout dir>     -> <dir>/Formula/zdrop.rb
set -eu
version=${1#v}
tap=$2
repo="matan1542/zdrop"
base="https://github.com/$repo/releases/download/v$version"
sha() { curl -fsSL --retry 3 "$base/zdrop-$version-$1.tar.xz.sha256" | cut -d' ' -f1; }
mac_arm=$(sha darwin-arm64)
mac_intel=$(sha darwin-x64)
linux_arm=$(sha linux-arm64)
linux_intel=$(sha linux-x64)
[ -n "$mac_arm" ] && [ -n "$mac_intel" ] && [ -n "$linux_arm" ] && [ -n "$linux_intel" ] || { echo "release v$version has no checksums" >&2; exit 1; }
mkdir -p "$tap/Formula"
cat >"$tap/Formula/zdrop.rb" <<RUBY
class Zdrop < Formula
  desc "IDE-style dropdown autocomplete for zsh, for every command on your PATH"
  homepage "https://github.com/$repo"
  version "$version"
  license "MIT"

  on_macos do
    if Hardware::CPU.arm?
      url "$base/zdrop-$version-darwin-arm64.tar.xz"
      sha256 "$mac_arm"
    else
      url "$base/zdrop-$version-darwin-x64.tar.xz"
      sha256 "$mac_intel"
    end
  end

  on_linux do
    if Hardware::CPU.arm?
      url "$base/zdrop-$version-linux-arm64.tar.xz"
      sha256 "$linux_arm"
    else
      url "$base/zdrop-$version-linux-x64.tar.xz"
      sha256 "$linux_intel"
    end
  end

  def install
    # self-contained: the daemon, the zsh plugin and a bundled Node.js
    libexec.install Dir["*"]
    bin.install_symlink libexec/"bin/zdrop"
  end

  def caveats
    <<~EOS
      Turn it on (a line in ~/.zshrc and a login item), then open a new terminal tab:
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
