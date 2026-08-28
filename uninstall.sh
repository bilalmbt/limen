#!/usr/bin/env bash
# Remove the Claude Island login item and stop the running widget.
# Never touches your Claude credentials. Config and state stay in
# ~/.config/claude-island (delete that directory yourself if you want).
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LABEL="com.claudeisland.widget"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

if [ -f "$PLIST" ]; then
  launchctl unload "$PLIST" 2>/dev/null || true
  rm "$PLIST"
  echo "Login item removed."
else
  echo "No login item was registered."
fi

pkill -f "electron $DIR" 2>/dev/null || true
echo "Done."
