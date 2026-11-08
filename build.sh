#!/bin/sh
# Package the plugin as dist/zotero-ai-chat-<version>.xpi
set -e
cd "$(dirname "$0")"
version=$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' manifest.json)
mkdir -p dist
rm -f "dist/zotero-ai-chat-$version.xpi"
zip -qr "dist/zotero-ai-chat-$version.xpi" manifest.json bootstrap.js content
echo "dist/zotero-ai-chat-$version.xpi"
