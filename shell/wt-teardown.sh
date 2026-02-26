#!/bin/bash

# Safely tear down a git worktree
# Usage: wt-teardown [name] [--force]
wt-teardown() {
  local result
  result=$(bun "$CHRISWA_DEVKIT_DIR/shell/wt-teardown.ts" "$@")
  local exit_code=$?

  if [[ $exit_code -ne 0 ]]; then
    return $exit_code
  fi

  if [[ -n "$result" ]]; then
    cd "$result"
  fi
}
