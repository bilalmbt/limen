#!/usr/bin/env bash
# Notarize and staple a built Limen .dmg.
#
# Credentials are never passed on the command line and never live in this
# repo: they are stored once in the keychain, by you, with
#
#   xcrun notarytool store-credentials "limen-notary" \
#     --apple-id "<your-apple-id>" --team-id GX922H5C5A
#
# which prompts for an app-specific password from appleid.apple.com. Every
# run after that refers to the profile by name only.
set -euo pipefail

PROFILE="${NOTARY_PROFILE:-limen-notary}"
# Every image of THIS version, not the newest file: the build makes one dmg
# per architecture, and "the newest" silently notarized half a release.
VERSION="$(node -p "require('./package.json').version")"
if [ $# -ge 1 ]; then DMGS=("$1"); else DMGS=(dist/*-"$VERSION"-*.dmg); fi

[ -f "${DMGS[0]}" ] || { echo "No ${VERSION} .dmg found. Run: npm run dist"; exit 1; }
xcrun notarytool history --keychain-profile "$PROFILE" >/dev/null 2>&1 || {
  echo "No stored credentials for profile \"$PROFILE\"."
  echo "Create them once (it will prompt for an app-specific password):"
  echo "  xcrun notarytool store-credentials \"$PROFILE\" --apple-id <your-apple-id> --team-id GX922H5C5A"
  exit 1
}

for DMG in "${DMGS[@]}"; do
  echo "Submitting $DMG — Apple usually answers in a few minutes…"
  xcrun notarytool submit "$DMG" --keychain-profile "$PROFILE" --wait

  # Stapling writes the ticket INTO the dmg, so the app validates on a Mac
  # that is offline the first time it is opened.
  echo "Stapling…"
  xcrun stapler staple "$DMG"

  # A dmg is not code-signed, so `spctl -t install` on it always says "no
  # usable signature" — true and irrelevant. What matters is the app a user
  # drags out of it, so mount the thing and ask about that.
  echo "Verifying the app as Gatekeeper will see it:"
  MNT="$(mktemp -d)"
  hdiutil attach "$DMG" -nobrowse -quiet -mountpoint "$MNT"
  spctl -a -vvv "$MNT"/*.app
  xcrun stapler validate "$MNT"/*.app
  hdiutil detach "$MNT" -quiet
done
echo "Done."
