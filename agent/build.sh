#!/bin/bash
# Builds the bundled helper binaries (Apple silicon, macOS 14 or later).
# Usage: ./build.sh
set -euo pipefail
cd "$(dirname "$0")"
for name in macsensors macsession; do
  swiftc -O -target arm64-apple-macos14 -o "$name" "src/$name.swift"
  codesign -s - --force "$name"
done
