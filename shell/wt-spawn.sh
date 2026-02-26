#!/bin/bash

# Create a new git worktree with .env files and symlinked node_modules from a parent
# Usage: wt-spawn <branch-name> [parent]
wt-spawn() {
  local worktree_path
  worktree_path=$(bun "$CHRISWA_DEVKIT_DIR/shell/wt-spawn.ts" "$@")
  local exit_code=$?

  if [[ $exit_code -ne 0 ]]; then
    return $exit_code
  fi

  if [[ -n "$worktree_path" ]]; then
    cd "$worktree_path"
  fi
}
