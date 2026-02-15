#!/bin/bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

ENV_FILE="${SCRIPT_DIR}/.env"
APP_DIR="${SCRIPT_DIR}/app"
ENTRY="${APP_DIR}/dist/host.js"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "FATAL: ${ENV_FILE} not found" >&2
  echo "" >&2
  echo "  If you just unzipped the bootstrap, run setup.sh first:" >&2
  echo "    ./setup.sh" >&2
  echo "" >&2
  echo "  If setup.sh already ran, the service is at ~/hello-claw/" >&2
  echo "  and managed by launchd. Check logs:" >&2
  echo "    tail ~/Library/Logs/hello-claw.err.log" >&2
  exit 1
fi

if [[ ! -f "$ENTRY" ]]; then
  echo "FATAL: ${ENTRY} not found" >&2
  echo "  Run setup.sh to build, or check npm run build output." >&2
  exit 1
fi

# Add common Node locations to PATH (brew keg, brew default, Intel brew)
for d in /opt/homebrew/opt/node@22/bin /opt/homebrew/bin /usr/local/bin; do
  [[ -d "$d" ]] && export PATH="$d:$PATH"
done

if ! command -v node &>/dev/null; then
  echo "FATAL: node not found in PATH=$PATH" >&2
  exit 1
fi

cd "$APP_DIR"
set -a; source "$ENV_FILE"; set +a

# Trap SIGTERM (from launchctl stop) and exit 0 so launchd treats it
# as a "successful exit" and doesn't auto-restart with stale state.
# Without this, KeepAlive.SuccessfulExit=false sees SIGTERM as failure
# and immediately relaunches before unload/load can refresh the plist.
trap 'kill $NODE_PID 2>/dev/null; wait $NODE_PID 2>/dev/null; exit 0' TERM

node dist/host.js &
NODE_PID=$!
wait $NODE_PID
