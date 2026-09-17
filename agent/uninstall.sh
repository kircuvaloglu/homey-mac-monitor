#!/bin/bash
# Removes homey-mac-agent.  Usage: sudo ./uninstall.sh [--purge]
set -euo pipefail
LABEL="com.homey.macagent"
[[ $EUID -ne 0 ]] && { echo "Run as root: sudo ./uninstall.sh" >&2; exit 1; }

launchctl bootout system/"$LABEL" 2>/dev/null || true
rm -f "/Library/LaunchDaemons/$LABEL.plist"
rm -rf /usr/local/libexec/homey-mac-agent
echo "Service and program files removed."

if [[ "${1:-}" == "--purge" ]]; then
  rm -rf /usr/local/etc/homey-mac-agent /var/log/homey-mac-agent.log
  echo "Config and log removed."
else
  echo "Config kept in /usr/local/etc/homey-mac-agent (use --purge to remove it)."
fi
