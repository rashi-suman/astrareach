#!/usr/bin/env bash
# setup-fresh-repo.sh
# One-time script: wipes existing git history, reinits, makes first commit,
# and points origin at your GitHub. Run from inside the astrareach folder.
#
# Usage:  bash .automation/setup-fresh-repo.sh
#
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

GITHUB_USER="rashisuman76-ops"
REPO_NAME="astrareach"
REMOTE_URL="https://github.com/${GITHUB_USER}/${REPO_NAME}.git"
GIT_USER_NAME="rashisuman76-ops"
GIT_USER_EMAIL="rashi.suman@kratikal.com"

echo "==> Working in: $REPO_DIR"

# 1. Wipe old git history + origin
if [ -d ".git" ]; then
  echo "==> Removing old .git folder"
  rm -rf .git
fi

# 2. Fresh init on main
echo "==> Initializing fresh repo on 'main'"
git init -b main >/dev/null

# 3. Identity for this repo only (does not change global config)
git config user.name  "$GIT_USER_NAME"
git config user.email "$GIT_USER_EMAIL"

# 4. Make sure node artifacts stay ignored
if ! grep -qx "node_modules" .gitignore 2>/dev/null; then
  printf "\nnode_modules\n.env\n.DS_Store\nlogs/\n*.log\n" >> .gitignore
fi

# 5. Stage everything and make the first commit
git add .
git commit -m "chore: initial project setup" >/dev/null

# 6. Wire up your GitHub as origin
git remote add origin "$REMOTE_URL"

echo ""
echo "Done. Current state:"
git log --oneline
echo ""
echo "Remote:"
git remote -v
echo ""
echo "Next step: push to GitHub"
echo "  git push -u origin main"
echo ""
echo "If you haven't yet, create the empty repo here first:"
echo "  https://github.com/new   (name it '${REPO_NAME}', do NOT add README/license)"
