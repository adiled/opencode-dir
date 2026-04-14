#!/usr/bin/env bash
set -euo pipefail

BUMP="${1:-patch}"

if [[ "$BUMP" != "patch" && "$BUMP" != "minor" && "$BUMP" != "major" ]]; then
  echo "Usage: ./release.sh [patch|minor|major]"
  exit 1
fi

# Ensure clean working tree
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "Error: working tree is dirty. Commit or stash changes first."
  exit 1
fi

# Run tests
echo "Running tests..."
bun test lib.test.ts lib.version.test.ts
echo ""

# Bump version, commit, and tag
VERSION=$(npm version "$BUMP" -m "release: v%s")
echo "Bumped to $VERSION"

# Push commit + tag
git push origin main --follow-tags
echo ""
echo "Released $VERSION"