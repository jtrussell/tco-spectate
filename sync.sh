#!/usr/bin/env bash
# Refresh the deployable copy from the experiment folder, then rebuild the
# landing page. Run this before pushing to the Pages repo.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
src="$here/../mobile-spectator/keyforge-mobile-spectator.user.js"

cp "$src" "$here/mobile-spectator.js"
node "$here/make-index.js" "$here"

printf 'synced %s bytes from the experiment folder\n' "$(wc -c < "$here/mobile-spectator.js")"
