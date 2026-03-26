#!/usr/bin/env bash
# Reads the version from package.json and updates the version badge in README.md.
# Called by the pre-commit hook so the badge stays in sync automatically.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERSION=$(node -p "require('$REPO_ROOT/package.json').version")
README="$REPO_ROOT/README.md"

if [[ -z "$VERSION" ]]; then
  echo "sync-version-badge: failed to read version from package.json" >&2
  exit 1
fi

# Replace the version badge (shields.io style: version-X.Y.Z-blue)
if [[ "$(uname)" == "Darwin" ]]; then
  sed -i '' "s|version-[0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*-blue|version-${VERSION}-blue|g" "$README"
else
  sed -i "s|version-[0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*-blue|version-${VERSION}-blue|g" "$README"
fi

git add "$README"
