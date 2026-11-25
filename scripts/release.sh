#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

TAG=""
COMMIT_MSG=""

usage() {
  cat <<'EOF'
Test, commit, and push updates to GitHub

Usage:
  scripts/release.sh [--tag vX.Y.Z] ["Commit message"]
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --tag)
      TAG="${2:?Missing tag value for --tag}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      if [[ -z "$COMMIT_MSG" ]]; then
        COMMIT_MSG="$1"
        shift
      else
        echo "Unexpected argument: $1" >&2
        usage >&2
        exit 1
      fi
      ;;
  esac
done

echo "Running automated test suite before push..."
"$ROOT_DIR/tests/run_tests.sh"

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "Error: $ROOT_DIR is not a git repository." >&2
  exit 1
fi

if ! git remote get-url origin >/dev/null 2>&1; then
  echo "Error: Git remote 'origin' is not configured." >&2
  exit 1
fi

git add -A

# Extra safety guard: never commit proprietary app payload or archives
STAGED_BAD="$(git diff --cached --name-only | grep -E '^(app/|app\.new/|app\.bak/)|(\.(exe|zip|7z|part|log)$)' || true)"
if [[ -n "$STAGED_BAD" ]]; then
  echo "Error: Refusing to commit ignored/proprietary files:" >&2
  echo "$STAGED_BAD" >&2
  git reset
  exit 1
fi

if ! git diff --cached --quiet; then
  MSG="${COMMIT_MSG:-chore: update AULA HUB Linux wrapper ($(date +%Y-%m-%d_%H:%M))}"
  git commit -m "$MSG"
else
  echo "Working tree clean; nothing new to commit."
fi

BRANCH="$(git branch --show-current)"
BRANCH="${BRANCH:-main}"

if [[ -n "$TAG" ]]; then
  git tag -f "$TAG"
fi

echo "Pushing $BRANCH to origin..."
if git rev-parse --abbrev-ref --symbolic-full-name '@{u}' >/dev/null 2>&1; then
  git push
else
  git push -u origin "$BRANCH"
fi

if [[ -n "$TAG" ]]; then
  git push origin "$TAG"
fi

echo "Release push completed!"
