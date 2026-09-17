#!/bin/bash
# Installs homey-mac-agent.  Usage: sudo ./install.sh
set -euo pipefail

LABEL="com.homey.macagent"
INSTALL_DIR="/usr/local/libexec/homey-mac-agent"
CONFIG_DIR="/usr/local/etc/homey-mac-agent"
CONFIG="$CONFIG_DIR/config.json"
PLIST="/Library/LaunchDaemons/$LABEL.plist"
LOG="/var/log/homey-mac-agent.log"
SRC="$(cd "$(dirname "$0")" && pwd)"

if [[ "$(uname -m)" != "arm64" ]]; then
  echo "This agent requires a Mac with Apple silicon." >&2
  exit 1
fi

if [[ $EUID -ne 0 ]]; then
  echo "Run as root: sudo ./install.sh" >&2
  exit 1
fi

# Node.js
NODE=""
for cand in /opt/homebrew/bin/node /usr/local/bin/node "$(command -v node 2>/dev/null || true)"; do
  [[ -n "$cand" && -x "$cand" ]] && { NODE="$cand"; break; }
done
if [[ -z "$NODE" ]]; then
  echo "ERROR: Node.js is not installed." >&2
  echo "Install it from https://nodejs.org (LTS) or with Homebrew: brew install node" >&2
  echo "Then run this installer again." >&2
  exit 1
fi
if ! "$NODE" -e 'process.exit(parseInt(process.versions.node) >= 18 ? 0 : 1)'; then
  echo "ERROR: Node.js 18 or later is required (found $("$NODE" -v))." >&2
  exit 1
fi
echo "node        : $NODE ($("$NODE" -v))"

# Helper binaries
# Use the bundled binaries; build from source only when one is missing and the
# developer tools are installed (the swiftc shim alone would open an install prompt).
mkdir -p "$INSTALL_DIR"
for name in macsensors macsession; do
  if [[ -f "$SRC/$name" ]]; then
    echo "$(printf '%-12s' "$name"): installing bundled binary"
    cp "$SRC/$name" "$INSTALL_DIR/$name"
    # Downloaded files are quarantined, and Gatekeeper blocks unsigned binaries.
    xattr -d com.apple.quarantine "$INSTALL_DIR/$name" 2>/dev/null || true
    codesign -s - --force "$INSTALL_DIR/$name" 2>/dev/null || true
  elif xcode-select -p >/dev/null 2>&1 && [[ -f "$SRC/src/$name.swift" ]]; then
    echo "$(printf '%-12s' "$name"): building..."
    swiftc -O -o "$INSTALL_DIR/$name" "$SRC/src/$name.swift"
  else
    echo "WARNING: $name missing. Some readings will be unavailable." >&2
  fi
  [[ -f "$INSTALL_DIR/$name" ]] && chmod 755 "$INSTALL_DIR/$name"
done

cp "$SRC/agent.js" "$INSTALL_DIR/agent.js"
cp "$SRC/uninstall.sh" "$INSTALL_DIR/uninstall.sh"
chmod 755 "$INSTALL_DIR/agent.js" "$INSTALL_DIR/uninstall.sh"

# Config
mkdir -p "$CONFIG_DIR"
if [[ -f "$CONFIG" ]]; then
  echo "config      : kept existing file ($CONFIG)"
  TOKEN="$(/usr/bin/python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["token"])' "$CONFIG")"
else
  TOKEN="$(/usr/bin/openssl rand -hex 24)"
  cat > "$CONFIG" <<JSON
{
  "port": 8787,
  "token": "$TOKEN",
  "pollSeconds": 10,
  "updateCheckHours": 6,
  "allowActions": {
    "sleep": true,
    "displaysleep": true,
    "lock": true,
    "notify": true,
    "say": true,
    "keepawake": true,
    "restart": false,
    "shutdown": false
  },
  "commands": {},
  "allowedIPs": [],
  "advertiseBonjour": true
}
JSON
  echo "config      : created ($CONFIG)"
fi
chmod 600 "$CONFIG"

# launchd
cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE</string>
    <string>$INSTALL_DIR/agent.js</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>UserName</key><string>root</string>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict>
</plist>
PL
chmod 644 "$PLIST"

# bootout returns before the old service is gone; bootstrap fails with error 5 until it is.
launchctl bootout system/"$LABEL" 2>/dev/null || true
for _ in $(seq 1 20); do
  launchctl print system/"$LABEL" >/dev/null 2>&1 || break
  sleep 0.5
done
loaded=0
for _ in 1 2 3 4 5; do
  if launchctl bootstrap system "$PLIST" 2>/dev/null; then loaded=1; break; fi
  sleep 1
done
if [[ $loaded -ne 1 ]]; then
  echo "ERROR: could not load $PLIST. Try: sudo launchctl bootstrap system $PLIST" >&2
  exit 1
fi
launchctl kickstart -k system/"$LABEL" 2>/dev/null || true

# Firewall
# With the macOS firewall on, incoming connections to node are dropped silently
# unless node is allowed. The rule is tied to the real binary, so resolve symlinks.
FW=/usr/libexec/ApplicationFirewall/socketfilterfw
if [[ -x "$FW" ]] && "$FW" --getglobalstate 2>/dev/null | grep -q "enabled"; then
  NODE_REAL="$(/usr/bin/python3 -c 'import os,sys;print(os.path.realpath(sys.argv[1]))' "$NODE" 2>/dev/null || echo "$NODE")"
  "$FW" --add "$NODE_REAL" >/dev/null 2>&1 || true
  "$FW" --unblockapp "$NODE_REAL" >/dev/null 2>&1 || true
  echo "firewall    : allowed incoming connections for $NODE_REAL"
fi

# Check
PORT="$(/usr/bin/python3 -c 'import json;print(json.load(open("'"$CONFIG"'"))["port"])')"
# List every address: with several networks (e.g. VLANs) the default route may not be the one Homey uses.
IPS="$(ifconfig | awk '/inet /{print $2}' | grep -v '^127\.' || true)"
IP="$(ipconfig getifaddr "$(route -n get default 2>/dev/null | awk '/interface:/{print $2}')" 2>/dev/null || true)"
[[ -z "$IP" ]] && IP="$(ipconfig getifaddr en0 2>/dev/null || echo '?')"

if curl -s --retry-connrefused --retry 15 --retry-delay 1 --max-time 25 "http://127.0.0.1:$PORT/ping" >/dev/null; then
  STATUS="running"
else
  STATUS="NOT RESPONDING, see $LOG"
fi

cat <<OUT

--------------------------------------------------------------
  homey-mac-agent installed: $STATUS
--------------------------------------------------------------
  Address : http://$IP:$PORT
  All IPs : $(echo $IPS | tr '\n' ' ')
            (use the one on the same network as Homey)
  Token   : $TOKEN
  Config  : $CONFIG
  Log     : $LOG

  Enter the address and token in Homey when adding the Mac.
  To uninstall: sudo $INSTALL_DIR/uninstall.sh

  Notes:
   - Restart and shutdown are disabled. To enable them, set "restart" and
     "shutdown" to true in $CONFIG and run:
       sudo launchctl kickstart -k system/$LABEL
   - A "background item added" notification from macOS is expected.
--------------------------------------------------------------
OUT
