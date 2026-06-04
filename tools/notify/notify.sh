#!/usr/bin/env bash
set -euo pipefail

message="$*"

if [[ -z "$message" ]]; then
  message="default message"
fi

args=(-title "notify" -message "$message" -sound Glass)

if [[ -n "${SPACETERM_SURFACE_ID:-}" ]]; then
  args+=(-open "spaceterm-surface://${SPACETERM_SURFACE_ID}")
fi

terminal-notifier "${args[@]}"
