#!/bin/bash
# Downloads and installs homey-mac-agent.
# Usage: curl -fsSL https://raw.githubusercontent.com/kircuvaloglu/homey-mac-monitor/main/agent/get.sh | sudo bash
set -euo pipefail

REPO="kircuvaloglu/homey-mac-monitor"
REF="${HOMEY_MAC_AGENT_REF:-main}"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

echo "Downloading $REPO ($REF)..."
curl -fsSL "https://github.com/$REPO/archive/refs/heads/$REF.tar.gz" | tar -xz -C "$tmp" --strip-components=1
bash "$tmp/agent/install.sh"
