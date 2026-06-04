#!/usr/bin/env bash
set -euo pipefail

message="$*"

if [[ -z "$message" ]]; then
  message="default message"
fi

terminal-notifier -title "notify" -message "$message" -sound Glass
