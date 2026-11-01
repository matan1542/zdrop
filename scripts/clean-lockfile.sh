#!/bin/sh
# yarn.lock must not name a private npm mirror: a mirror writes each package's archive URL into the
# lockfile (`::__archiveUrl=…`). Without them, yarn fetches the same packages (same checksums) from
# whichever registry is configured: registry.npmjs.org in CI, a mirror on a machine set up for one.
#
#   scripts/clean-lockfile.sh     run after `yarn install` / `yarn add`, before committing
set -eu
cd "$(dirname "$0")/.."
sed -i '' -E 's/::__archiveUrl=[^"]*//; s/%3A%3A__archiveUrl=[^#"]*//g' yarn.lock
if grep -q '__archiveUrl' yarn.lock; then echo "yarn.lock still has archive URLs" >&2; exit 1; fi
