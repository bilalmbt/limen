#!/usr/bin/env bash
# Install Claude Island as a login item (macOS LaunchAgent).
# Run from the project directory: bash install.sh
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LABEL="com.claudeisland.widget"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

command -v node >/dev/null || { echo "Node.js 18+ is required."; exit 1; }

echo "Installing dependencies…"
(cd "$DIR" && npm install --no-fund --no-audit)

echo "Running the test suite…"
# Not `npm test && echo`: under `set -e` a failure on the left of `&&` is
# exempt from exit-on-error, so that reads as a gate without being one.
if ! (cd "$DIR" && npm test >/tmp/claude-island-test.log 2>&1); then
  echo "Tests failed — not installing. Output:"
  tail -20 /tmp/claude-island-test.log
  exit 1
fi
echo "  all tests passed"

ELECTRON="$DIR/node_modules/.bin/electron"
[ -x "$ELECTRON" ] || { echo "Electron did not install correctly."; exit 1; }

echo "Registering the login item…"
mkdir -p "$HOME/Library/LaunchAgents"
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$ELECTRON</string>
    <string>$DIR</string>
  </array>
  <key>WorkingDirectory</key><string>$DIR</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key><false/>
  </dict>
  <key>StandardOutPath</key><string>$DIR/island.log</string>
  <key>StandardErrorPath</key><string>$DIR/island.log</string>
</dict>
</plist>
EOF

launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"

echo
echo "Done. The island is running — hover the notch (or the top-center of"
echo "your screen) once Claude Code is signed in."
echo "Remove it any time with: bash $DIR/uninstall.sh"
