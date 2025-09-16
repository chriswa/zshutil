#!/bin/bash

# zshutil - Modular zsh configuration
# Source this file from your ~/.zshrc to load all utilities

# Get the directory where this script is located
# Use a more robust method that works in both bash and zsh
if [[ -n "${BASH_SOURCE[0]}" ]]; then
    SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
elif [[ -n "${(%):-%x}" ]]; then
    # zsh method
    SCRIPT_DIR="$(cd "$(dirname "${(%):-%x}")" && pwd)"
else
    # fallback - assume we're in the right directory
    SCRIPT_DIR="$HOME/zshutil/zshrc"
fi

ZSHUTIL_DIR="$(dirname "$SCRIPT_DIR")"

# Add bin directory to PATH
source "$SCRIPT_DIR/path.sh"

# Load aliases
source "$SCRIPT_DIR/aliases.sh"

# Load prompt configuration
source "$SCRIPT_DIR/prompt.sh"