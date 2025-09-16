#!/bin/bash

# Add zshutil bin directory to PATH if not already present
# This avoids duplicate entries when sourcing multiple times

if [[ -n "$ZSHUTIL_DIR" ]]; then
  ZSHUTIL_BIN_DIR="$ZSHUTIL_DIR/bin"
  
  # Check if the directory exists and is not already in PATH
  if [[ -d "$ZSHUTIL_BIN_DIR" && ":$PATH:" != *":$ZSHUTIL_BIN_DIR:"* ]]; then
    export PATH="$ZSHUTIL_BIN_DIR:$PATH"
  fi
fi