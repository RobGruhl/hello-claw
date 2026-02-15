#!/bin/bash
set -euo pipefail

# hello-claw — Mac Mini Bootstrap Script
# Idempotent: safe to re-run at any point. Detects what's already installed
# and skips ahead. Secrets survive failed builds. Config.env is only deleted
# after a fully successful run.

INSTALL_DIR="$HOME/hello-claw"
APP_DIR="${INSTALL_DIR}/app"
LOG_DIR="$HOME/Library/Logs"
PLIST_LABEL="com.hello-claw.agent"
PLIST_DIR="$HOME/Library/LaunchAgents"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
MIN_NODE_MAJOR=22

info()  { echo "==> $*"; }
warn()  { echo "  ! $*" >&2; }
ok()    { echo "  ✓ $*"; }
fail()  { echo "  ✗ $*" >&2; exit 1; }

# ─── Phase 0: Detect Run Mode ──────────────────────────────────────────────

UPGRADE_IN_PLACE=false
if [[ "${SCRIPT_DIR}" == "${INSTALL_DIR}" ]]; then
  UPGRADE_IN_PLACE=true
  info "Running from install dir (${INSTALL_DIR}) — upgrade-in-place mode"
  info "  Source files already in place; will rebuild and restart service"
else
  info "Installing from ${SCRIPT_DIR} → ${INSTALL_DIR}"
fi

# ─── Phase 1: Config & Validation ──────────────────────────────────────────

# Load secrets: prefer config.env, fall back to existing .env
CONFIG_FILE=""
for candidate in "${SCRIPT_DIR}/config.env" "$HOME/Desktop/config.env" "$HOME/Downloads/config.env"; do
  if [[ -f "$candidate" ]]; then
    CONFIG_FILE="$candidate"
    break
  fi
done

if [[ -n "$CONFIG_FILE" ]]; then
  info "Found config: $CONFIG_FILE"
  set -a; source "$CONFIG_FILE"; set +a
elif [[ -f "${INSTALL_DIR}/.env" ]]; then
  info "No config.env found — sourcing existing ${INSTALL_DIR}/.env (upgrade mode)"
  set -a; source "${INSTALL_DIR}/.env"; set +a
else
  fail "config.env not found (looked in: script dir, ~/Desktop, ~/Downloads) and no existing .env at ${INSTALL_DIR}/.env"
fi

# Validate required secrets
[[ -n "${ANTHROPIC_API_KEY:-}" ]]  || fail "ANTHROPIC_API_KEY is required"
[[ -n "${SLACK_BOT_TOKEN:-}"   ]]  || fail "SLACK_BOT_TOKEN is required"
[[ -n "${SLACK_APP_TOKEN:-}"   ]]  || fail "SLACK_APP_TOKEN is required"
[[ -z "${GEMINI_API_KEY:-}" ]] && warn "GEMINI_API_KEY not set — image generation will be disabled"
[[ -z "${PERPLEXITY_API_KEY:-}" ]] && warn "PERPLEXITY_API_KEY not set — Perplexity search will be disabled"

# Verify bootstrap source files exist (catch running from wrong directory)
if [[ ! -d "${SCRIPT_DIR}/app/src" ]]; then
  fail "app/src/ not found in ${SCRIPT_DIR} — are you running from the unzipped bootstrap directory?"
fi

ok "Config validated"

# ─── Phase 2: System Configuration ─────────────────────────────────────────

if [[ -n "${MINI_HOSTNAME:-}" ]]; then
  current_hostname=$(scutil --get LocalHostName 2>/dev/null || echo "")
  if [[ "$current_hostname" != "$MINI_HOSTNAME" ]]; then
    info "Setting hostname to ${MINI_HOSTNAME}"
    sudo scutil --set ComputerName "$MINI_HOSTNAME"
    sudo scutil --set LocalHostName "$MINI_HOSTNAME"
    sudo scutil --set HostName "${MINI_HOSTNAME}.local"
    ok "Hostname set to ${MINI_HOSTNAME} (${MINI_HOSTNAME}.local)"
  else
    ok "Hostname already ${MINI_HOSTNAME}"
  fi
fi

if [[ -n "${SSH_AUTHORIZED_KEY:-}" ]]; then
  mkdir -p ~/.ssh && chmod 700 ~/.ssh
  touch ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys
  if ! grep -qF "$SSH_AUTHORIZED_KEY" ~/.ssh/authorized_keys 2>/dev/null; then
    echo "$SSH_AUTHORIZED_KEY" >> ~/.ssh/authorized_keys
    ok "SSH key added to authorized_keys"
  else
    ok "SSH key already present"
  fi
  if ! sudo systemsetup -getremotelogin 2>/dev/null | grep -q "On"; then
    sudo systemsetup -setremotelogin on
    ok "Remote Login enabled"
  else
    ok "Remote Login already enabled"
  fi
fi

# ─── Phase 3: Software Installation ────────────────────────────────────────

# Xcode Command Line Tools
if ! xcode-select -p &>/dev/null; then
  info "Installing Xcode Command Line Tools..."
  xcode-select --install
  echo "    Press Enter after the Xcode CLT installer finishes..."
  read -r
  xcode-select -p &>/dev/null || fail "Xcode CLT still not detected after install"
  ok "Xcode CLT installed"
else
  ok "Xcode CLT already installed"
fi

# Homebrew — check both Apple Silicon and Intel paths
BREW_BIN=""
if command -v brew &>/dev/null; then
  BREW_BIN="$(command -v brew)"
elif [[ -x /opt/homebrew/bin/brew ]]; then
  BREW_BIN="/opt/homebrew/bin/brew"
  eval "$($BREW_BIN shellenv)"
elif [[ -x /usr/local/bin/brew ]]; then
  BREW_BIN="/usr/local/bin/brew"
  eval "$($BREW_BIN shellenv)"
fi

if [[ -z "$BREW_BIN" ]]; then
  info "Installing Homebrew..."
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  # Detect where it landed
  if [[ -x /opt/homebrew/bin/brew ]]; then
    BREW_BIN="/opt/homebrew/bin/brew"
  elif [[ -x /usr/local/bin/brew ]]; then
    BREW_BIN="/usr/local/bin/brew"
  else
    fail "Homebrew installed but binary not found at expected paths"
  fi
  eval "$($BREW_BIN shellenv)"
  if ! grep -qF 'brew shellenv' ~/.zprofile 2>/dev/null; then
    echo "eval \"\$(${BREW_BIN} shellenv)\"" >> ~/.zprofile
  fi
  ok "Homebrew installed at ${BREW_BIN}"
else
  ok "Homebrew already installed at ${BREW_BIN}"
fi

# Node — accept any Node 22+ from any source (brew, nvm, volta, system)
NODE_BIN=""
find_suitable_node() {
  # Check common locations in priority order
  local candidates=(
    "$(command -v node 2>/dev/null || true)"
    "/opt/homebrew/opt/node@22/bin/node"
    "/opt/homebrew/bin/node"
    "/usr/local/bin/node"
  )
  for bin in "${candidates[@]}"; do
    if [[ -n "$bin" ]] && [[ -x "$bin" ]]; then
      local ver
      ver=$("$bin" -v 2>/dev/null | sed 's/^v//' | cut -d. -f1)
      if [[ -n "$ver" ]] && (( ver >= MIN_NODE_MAJOR )); then
        echo "$bin"
        return 0
      fi
    fi
  done
  return 1
}

if NODE_BIN=$(find_suitable_node); then
  ok "Node already installed: ${NODE_BIN} ($($NODE_BIN -v))"
else
  info "No Node ${MIN_NODE_MAJOR}+ found, installing via Homebrew..."
  brew install node@22
  # Add to PATH for this session
  if [[ -d /opt/homebrew/opt/node@22/bin ]]; then
    export PATH="/opt/homebrew/opt/node@22/bin:$PATH"
  fi
  if NODE_BIN=$(find_suitable_node); then
    ok "Node installed: ${NODE_BIN} ($($NODE_BIN -v))"
  else
    fail "Node ${MIN_NODE_MAJOR}+ not found after brew install. Check: brew info node@22"
  fi
fi

# FFmpeg (required for audio format conversion in transcription pipeline)
if command -v ffmpeg &>/dev/null; then
  ok "ffmpeg already installed ($(ffmpeg -version 2>&1 | head -1))"
else
  info "Installing ffmpeg..."
  brew install ffmpeg
  command -v ffmpeg &>/dev/null || fail "ffmpeg not found after brew install"
  ok "ffmpeg installed"
fi

# Ensure the directory containing node is in PATH for npm
NODE_DIR="$(dirname "$NODE_BIN")"
case ":${PATH}:" in
  *":${NODE_DIR}:"*) ;;
  *) export PATH="${NODE_DIR}:$PATH" ;;
esac

# ─── Phase 4: Application Deployment ───────────────────────────────────────

info "Deploying application to ${APP_DIR}"
mkdir -p "$APP_DIR"

# Write .env FIRST so secrets survive a build failure
info "Writing app secrets to ${INSTALL_DIR}/.env"
cat > "${INSTALL_DIR}/.env" <<ENVEOF
ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}
SLACK_BOT_TOKEN=${SLACK_BOT_TOKEN}
SLACK_APP_TOKEN=${SLACK_APP_TOKEN}
GEMINI_API_KEY=${GEMINI_API_KEY:-}
PERPLEXITY_API_KEY=${PERPLEXITY_API_KEY:-}
ENVEOF
chmod 600 "${INSTALL_DIR}/.env"
ok ".env written (mode 600)"

# Copy app source — never overwrite data/ or workspace/
# Skip if running from within the install dir (re-run / upgrade-in-place)
if [[ "$UPGRADE_IN_PLACE" == false ]]; then
  for item in package.json package-lock.json tsconfig.json CLAUDE.md src; do
    if [[ -e "${SCRIPT_DIR}/app/${item}" ]]; then
      cp -R "${SCRIPT_DIR}/app/${item}" "${APP_DIR}/"
    fi
  done
  ok "App source copied"
else
  ok "Source already in place (upgrade-in-place)"
fi

# Install dependencies
info "Installing dependencies..."
cd "$APP_DIR"
if ! npm ci --ignore-scripts; then
  if [[ -d "${APP_DIR}/node_modules" ]]; then
    warn "npm ci failed but node_modules exists from a previous run — trying npm install as fallback"
    if ! npm install --ignore-scripts; then
      fail "npm install also failed — check network and Node version: $(node -v 2>&1)"
    fi
  else
    fail "npm ci failed — check network connectivity and Node version (need ${MIN_NODE_MAJOR}+): $(node -v 2>&1)"
  fi
fi
ok "Dependencies installed"

# Build
info "Building..."
if ! npm run build; then
  fail "npm run build failed — see errors above"
fi
[[ -f "${APP_DIR}/dist/host.js" ]] || fail "Build failed — dist/host.js not found"
ok "Build complete (dist/host.js exists)"

# Restore state archive (optional) — only search external locations on fresh install
STATE_ARCHIVE=""
if [[ "$UPGRADE_IN_PLACE" == false ]]; then
  for candidate in "${SCRIPT_DIR}/state.tar.gz" "$HOME/Desktop/state.tar.gz" "$HOME/Downloads/state.tar.gz"; do
    if [[ -f "$candidate" ]]; then
      STATE_ARCHIVE="$candidate"
      break
    fi
  done
else
  # In upgrade-in-place, only check Desktop/Downloads (not SCRIPT_DIR which is INSTALL_DIR)
  for candidate in "$HOME/Desktop/state.tar.gz" "$HOME/Downloads/state.tar.gz"; do
    if [[ -f "$candidate" ]]; then
      STATE_ARCHIVE="$candidate"
      break
    fi
  done
fi

if [[ -n "$STATE_ARCHIVE" ]]; then
  if [[ -d "${APP_DIR}/data" ]] && [[ -f "${APP_DIR}/data/sessions.json" ]]; then
    warn "State archive found but data/ already exists — skipping restore (upgrade mode)"
  else
    info "Restoring state from ${STATE_ARCHIVE}..."
    tar xzf "$STATE_ARCHIVE" -C "$INSTALL_DIR"
    ok "State restored"
  fi
fi

# Install run.sh
if [[ "$UPGRADE_IN_PLACE" == false ]]; then
  cp "${SCRIPT_DIR}/run.sh" "${INSTALL_DIR}/run.sh"
fi
chmod +x "${INSTALL_DIR}/run.sh"
ok "run.sh installed"

# ─── Phase 5: Service Installation ─────────────────────────────────────────

info "Installing launchd service"
mkdir -p "$PLIST_DIR" "$LOG_DIR"

# Template the plist — source template must exist
PLIST_TEMPLATE="${SCRIPT_DIR}/com.hello-claw.agent.plist"
PLIST_DEST="${PLIST_DIR}/${PLIST_LABEL}.plist"
if [[ ! -f "$PLIST_TEMPLATE" ]]; then
  fail "Plist template not found at ${PLIST_TEMPLATE}. Cannot install service."
fi
sed -e "s|__INSTALL_DIR__|${INSTALL_DIR}|g" \
    -e "s|__LOG_DIR__|${LOG_DIR}|g" \
    "$PLIST_TEMPLATE" > "$PLIST_DEST"
ok "Plist installed to ${PLIST_DEST}"

# Stop existing service (try both new and legacy APIs, ignore errors)
if launchctl print "gui/$(id -u)/${PLIST_LABEL}" &>/dev/null; then
  launchctl bootout "gui/$(id -u)/${PLIST_LABEL}" 2>/dev/null || true
  ok "Stopped previous service (bootout)"
elif launchctl list 2>/dev/null | grep -q "$PLIST_LABEL"; then
  launchctl unload "$PLIST_DEST" 2>/dev/null || true
  ok "Stopped previous service (unload)"
fi
# Brief pause for launchd to fully release the service
sleep 1

# Start service — try new API first, fall back to legacy
if launchctl bootstrap "gui/$(id -u)" "$PLIST_DEST" 2>/dev/null; then
  ok "Service started (bootstrap)"
elif launchctl load "$PLIST_DEST" 2>/dev/null; then
  ok "Service started (load)"
else
  warn "Could not start service via launchctl."
  warn "If running over SSH, log in to the Mac directly and run:"
  warn "  launchctl load ${PLIST_DEST}"
  warn "Or reboot — RunAtLoad will start it automatically."
fi

# Verify service is actually running
sleep 2
if launchctl list 2>/dev/null | grep -q "$PLIST_LABEL"; then
  ok "Service verified running"
else
  warn "Service not detected in launchctl list — it may start on next login or reboot (RunAtLoad=true)"
fi

# ─── Cleanup (only after full success) ─────────────────────────────────────

if [[ -n "${CONFIG_FILE:-}" ]] && [[ -f "$CONFIG_FILE" ]]; then
  rm "$CONFIG_FILE"
  ok "Deleted ${CONFIG_FILE} (secrets are in ${INSTALL_DIR}/.env)"
fi

# ─── Summary ────────────────────────────────────────────────────────────────

echo ""
echo "═══════════════════════════════════════════════════════"
echo "  hello-claw deployed successfully!"
echo "═══════════════════════════════════════════════════════"
echo ""
echo "  Install dir:  ${INSTALL_DIR}"
echo "  App dir:      ${APP_DIR}"
echo "  Secrets:      ${INSTALL_DIR}/.env"
echo "  Node:         ${NODE_BIN} ($(node -v))"
echo "  Logs:         ${LOG_DIR}/hello-claw.{out,err}.log"
echo ""
echo "  Useful commands:"
echo "    tail -f ${LOG_DIR}/hello-claw.out.log"
echo "    launchctl print gui/$(id -u)/${PLIST_LABEL}"
echo "    launchctl kickstart -k gui/$(id -u)/${PLIST_LABEL}"
echo ""
