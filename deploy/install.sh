#!/bin/bash
# install.sh — install/reload the market-data scraper launchd agent.
set -euo pipefail

PLIST_SRC="$(cd "$(dirname "$0")" && pwd)/com.henry.marketdata.plist"
LABEL="com.henry.marketdata"
DEST="$HOME/Library/LaunchAgents/$LABEL.plist"

echo "Installing $LABEL ..."
cp "$PLIST_SRC" "$DEST"

# Unload if already loaded (ignore errors), then load fresh.
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$DEST"
launchctl enable "gui/$(id -u)/$LABEL"

echo "Loaded. Status:"
launchctl print "gui/$(id -u)/$LABEL" | grep -E "state =|pid =" || true
echo
echo "Logs: tail -f $HOME/workspace/market-data/logs/runner.{out,err}.log"
echo "Stop: launchctl bootout gui/$(id -u)/$LABEL"
