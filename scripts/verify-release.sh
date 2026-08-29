#!/usr/bin/env bash
# Refuse to publish what Gatekeeper would refuse to open.
#
# Every artifact is checked the way a downloader meets it: mount the image,
# assess the app inside, and confirm the notarization ticket is stapled
# rather than merely obtainable over the network. Run before `gh release`.
set -euo pipefail

fail=0
shopt -s nullglob
dmgs=(dist/*.dmg)
[ ${#dmgs[@]} -gt 0 ] || { echo "no .dmg in dist/ — nothing to verify"; exit 1; }

for dmg in "${dmgs[@]}"; do
  echo "== $(basename "$dmg")"
  if ! xcrun stapler validate "$dmg" >/dev/null 2>&1; then
    echo "   FAIL: disk image has no stapled ticket"; fail=1; continue
  fi
  mnt="$(mktemp -d)"
  hdiutil attach "$dmg" -nobrowse -quiet -mountpoint "$mnt"
  app=("$mnt"/*.app)
  verdict="$(spctl -a -vvv "${app[0]}" 2>&1 || true)"
  stapled="$(xcrun stapler validate "${app[0]}" 2>&1 || true)"
  hdiutil detach "$mnt" -quiet
  case "$verdict" in
    *"source=Notarized Developer ID"*) echo "   ok: notarized, accepted by Gatekeeper" ;;
    *) echo "   FAIL: $(echo "$verdict" | head -2 | tr '\n' ' ')"; fail=1 ;;
  esac
  case "$stapled" in
    *"The validate action worked"*) echo "   ok: app carries its own ticket (works offline)" ;;
    *) echo "   FAIL: app has no stapled ticket"; fail=1 ;;
  esac
done

[ $fail -eq 0 ] || { echo; echo "NOT RELEASABLE."; exit 1; }
echo; echo "All artifacts releasable."
