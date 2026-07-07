#!/bin/zsh

# Kill leftover local dev services on known ports (skips Docker-owned processes)
killdev() {
  # Source the port list live from dev-launcher's Services.ts so it never bit-rots.
  local ports=($(bun -e '
    const { ports } = await import(`${process.env.HOME}/spare/dev-launcher/src/config/Services.ts`)
    console.log([...new Set(Object.values(ports))].join(" "))
  '))
  if [[ ${#ports[@]} -eq 0 ]]; then
    echo "killdev: could not load ports from ~/spare/dev-launcher/src/config/Services.ts" >&2
    return 1
  fi
  local killed=0
  for port in "${ports[@]}"; do
    for pid in $(lsof -ti :"$port" 2>/dev/null); do
      local cmd=$(ps -p "$pid" -o comm= 2>/dev/null)
      if [[ "$cmd" == *"com.docker."* || "$cmd" == *"Docker"* || "$cmd" == *"docker"* || "$cmd" == *"vpnkit"* ]]; then
        echo "Skipping port $port (PID $pid) — Docker process ($cmd)"
        continue
      fi
      echo "Killing port $port (PID $pid — $cmd)"
      kill -9 "$pid" 2>/dev/null
      ((killed++))
    done
  done
  if [[ $killed -eq 0 ]]; then
    echo "No leftover services found."
  else
    echo "Killed $killed process(es)."
  fi
}
