#!/usr/bin/env bash
# install-schedule.sh
# Installs the daily-commit LaunchAgent so it runs every day at 10:30 AM.
#
# Usage:  bash .automation/install-schedule.sh
# Undo:   bash .automation/install-schedule.sh uninstall
#
set -euo pipefail

PLIST_NAME="com.rashi.astrareach.daily"
SRC_PLIST="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/${PLIST_NAME}.plist"
DEST_DIR="$HOME/Library/LaunchAgents"
DEST_PLIST="$DEST_DIR/${PLIST_NAME}.plist"

if [ "${1:-}" = "uninstall" ]; then
  echo "==> Unloading $PLIST_NAME"
  launchctl unload "$DEST_PLIST" 2>/dev/null || true
  rm -f "$DEST_PLIST"
  echo "Done. Schedule removed."
  exit 0
fi

mkdir -p "$DEST_DIR"
cp "$SRC_PLIST" "$DEST_PLIST"
launchctl unload "$DEST_PLIST" 2>/dev/null || true
launchctl load   "$DEST_PLIST"

echo "Installed. Daily run at 3:00 PM."
echo "Plist:  $DEST_PLIST"
echo ""
echo "Manage:"
echo "  launchctl list | grep $PLIST_NAME       # check it's loaded"
echo "  launchctl start $PLIST_NAME             # run once now (for testing)"
echo "  bash .automation/install-schedule.sh uninstall   # remove"
