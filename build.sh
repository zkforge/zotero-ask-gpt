#!/bin/sh
# Package the plugin as dist/zotero-ask-gpt.xpi and write dist/updates.json, the update
# manifest Zotero reads from the latest GitHub release (manifest.json's update_url).
set -e
cd "$(dirname "$0")"
id=$(sed -n 's/.*"id": *"\([^"]*\)".*/\1/p' manifest.json)
version=$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' manifest.json)
mkdir -p dist
rm -f dist/zotero-ask-gpt.xpi
zip -qr dist/zotero-ask-gpt.xpi LICENSE manifest.json bootstrap.js content
hash=$(shasum -a 256 dist/zotero-ask-gpt.xpi | cut -d ' ' -f 1)
cat > dist/updates.json <<EOF
{
  "addons": {
    "$id": {
      "updates": [
        {
          "version": "$version",
          "update_link": "https://github.com/zkforge/zotero-ask-gpt/releases/download/v$version/zotero-ask-gpt.xpi",
          "update_hash": "sha256:$hash",
          "applications": { "zotero": { "strict_min_version": "10.0", "strict_max_version": "10.*" } }
        }
      ]
    }
  }
}
EOF
echo "dist/zotero-ask-gpt.xpi (v$version)"
