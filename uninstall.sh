#!/usr/bin/env bash
# Remove the Limen login item and stop the running widget.
# Never touches your Claude credentials. Config and state stay in
# ~/.config/limen (delete that directory yourself if you want).
set -euo pipefail

LABEL="io.moobytes.limen"
# Also removed: the agent this project registered before it was renamed.
OLD_LABEL="com.claudeisland.widget"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

# bootout by label rather than pkill: `pkill -f "$DIR"` interpolates a path
# into a regex, where a dot matches any character and the pattern is tested
# against every one of your processes' full command lines.
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootout "gui/$(id -u)/$OLD_LABEL" 2>/dev/null || true
rm -f "$HOME/Library/LaunchAgents/$OLD_LABEL.plist"

if [ -f "$PLIST" ]; then
  rm "$PLIST"
  echo "Login item removed."
else
  echo "No login item was registered."
fi
echo "Done."
