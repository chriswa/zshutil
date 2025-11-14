#!/bin/bash

# Kill processes on specified ports
killport() {
    if [ $# -eq 0 ]; then
        echo "Usage: killport <port1> [port2] [port3] ..."
        return 1
    fi

    # Build lsof arguments
    local lsof_args=()
    for port in "$@"; do
        lsof_args+=("-i:$port")
    done

    # Get PIDs and kill them
    local pids=$(lsof -t "${lsof_args[@]}" 2>/dev/null)

    if [ -z "$pids" ]; then
        echo "No processes found on ports: $@"
        return 1
    fi

    echo "Killing processes on ports $@: $pids"
    kill -9 $pids
}
