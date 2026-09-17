#!/bin/bash
# Builds the bundled macsensors binary (Apple silicon, macOS 14 or later).
# Usage: ./build.sh
set -euo pipefail
cd "$(dirname "$0")"
swiftc -O -target arm64-apple-macos14 -o macsensors src/macsensors.swift
codesign -s - --force macsensors
