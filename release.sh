#!/usr/bin/env bash
set -e

# Usage: ./release.sh [patch|minor|major] ["release message"]
# Bumps version in package.json, commits, tags, pushes.

BUMP="${1:-patch}"
MSG="${2:-}"
ROOT="$(cd "$(dirname "$0")" && pwd)"

# Read current version
CURRENT=$(node -e "console.log(require('$ROOT/package.json').version)")

# Compute next version
IFS='.' read -r MAJOR MINOR PATCH <<< "$CURRENT"
case "$BUMP" in
  patch) PATCH=$((PATCH + 1)) ;;
  minor) MINOR=$((MINOR + 1)); PATCH=0 ;;
  major) MAJOR=$((MAJOR + 1)); MINOR=0; PATCH=0 ;;
  *) echo "Usage: $0 {patch|minor|major}"; exit 1 ;;
esac
NEXT="$MAJOR.$MINOR.$PATCH"

echo "Bumping $CURRENT → $NEXT ($BUMP)"

# Update package.json
node -e "
const fs = require('fs');
const p = '$ROOT/package.json';
const j = JSON.parse(fs.readFileSync(p, 'utf8'));
j.version = '$NEXT';
fs.writeFileSync(p, JSON.stringify(j, null, 2) + '\n');
console.log('  updated ' + p);
"

git add -A
git commit -m "v$NEXT"

if [ -n "$MSG" ]; then
  git tag -a "v$NEXT" -m "$MSG"
else
  git tag "v$NEXT"
fi

git push
git push --tags

echo "released v$NEXT"