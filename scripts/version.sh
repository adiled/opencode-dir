#!/usr/bin/env bash
set -e

# Usage: ./scripts/version.sh "release message" [patch|minor|major]
# Bumps version in package.json, commits, tags, pushes.

MSG="${1:-}"
BUMP="${2:-patch}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

if [ -z "$MSG" ]; then
  echo "Usage: $0 \"release message\" [patch|minor|major]"
  exit 1
fi

# Read current version
CURRENT=$(node -e "console.log(require('$ROOT/package.json').version)")

# Compute next version
IFS='.' read -r MAJOR MINOR PATCH <<< "$CURRENT"
case "$BUMP" in
  patch) PATCH=$((PATCH + 1)) ;;
  minor) MINOR=$((MINOR + 1)); PATCH=0 ;;
  major) MAJOR=$((MAJOR + 1)); MINOR=0; PATCH=0 ;;
  *) echo "Usage: $0 \"release message\" {patch|minor|major}"; exit 1 ;;
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

# Pre-release gates
echo "Running typecheck..."
bunx tsc --noEmit || { echo "❌ Typecheck failed — aborting release"; exit 1; }
echo "Running tests..."
bun test lib.test.ts || { echo "❌ Tests failed — aborting release"; exit 1; }
echo "✅ All checks passed"

git add -A
git commit -m "v$NEXT: $MSG"

git tag -a "v$NEXT" -m "$MSG"

git push
git push --tags

echo "released v$NEXT"