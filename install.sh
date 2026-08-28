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
mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
LOG="$HOME/Library/Logs/claude-island.log"

# Built with plutil rather than a heredoc: a project path containing &, < or
# > would otherwise produce invalid XML, and a crafted one could inject plist
# keys. plutil handles the escaping and validates the result.
/usr/bin/plutil -create xml1 "$PLIST"
/usr/bin/plutil -insert Label -string "$LABEL" "$PLIST"
/usr/bin/plutil -insert ProgramArguments -json '[]' "$PLIST"
/usr/bin/plutil -insert ProgramArguments.0 -string "$ELECTRON" "$PLIST"
/usr/bin/plutil -insert ProgramArguments.1 -string "$DIR" "$PLIST"
/usr/bin/plutil -insert WorkingDirectory -string "$DIR" "$PLIST"
/usr/bin/plutil -insert RunAtLoad -bool true "$PLIST"
/usr/bin/plutil -insert KeepAlive -json '{"SuccessfulExit": false}' "$PLIST"
/usr/bin/plutil -insert StandardOutPath -string "$LOG" "$PLIST"
/usr/bin/plutil -insert StandardErrorPath -string "$LOG" "$PLIST"
/usr/bin/plutil -lint "$PLIST" >/dev/null

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"

echo
echo "Done. The island is running — hover the notch (or the top-center of"
echo "your screen) once Claude Code is signed in."
echo "Remove it any time with: bash $DIR/uninstall.sh"
