# /configure — Interactive Cost & Model Configuration

Walk the user through configuring hello-claw's cost controls and model settings.

## Steps

### 1. Read current configuration

Read the `.env` file in the project root (if it exists) and extract current values for:
- `MAX_DAILY_BUDGET_USD` (default: 5)
- `MAX_SESSION_BUDGET_USD` (default: 50)
- `ENABLE_1M_CONTEXT` (default: false)
- `HEARTBEAT_MODE` (default: conservative)
- `AGENT_MODEL` (default: claude-opus-4-6)
- `FIRECRAWL_API_KEY` (present or not)

Display a summary table showing each setting, its current value (or "default" if unset), and the default.

### 2. Explain each setting

Walk through each setting with cost implications:

**Daily Budget (`MAX_DAILY_BUDGET_USD`)**
- Controls when the agent auto-pauses to prevent runaway spending
- Default $5/day is conservative — a typical interactive session costs $0.50-2.00
- Heartbeats add $0.10-0.30 each depending on what the agent does
- The agent posts a warning at 50% and auto-pauses at 100%

**Session Budget (`MAX_SESSION_BUDGET_USD`)**
- SDK-level cap on a single query() call
- Default $50 is generous — most sessions use $1-5
- This is a safety net, not a daily control

**1M Context (`ENABLE_1M_CONTEXT`)**
- Enables the `context-1m-2025-08-07` beta for 1M token context window
- Doubles per-token pricing (2x surcharge)
- Only needed for very long sessions or large codebases
- Recommended: leave disabled unless you have a specific need

**Heartbeat Mode (`HEARTBEAT_MODE`)**
- `conservative` (default): 4 beats/day at 8:00, 12:00, 18:00, 22:00 PT
- `standard`: 8 beats/day (original schedule)
- `off`: no autonomous check-ins at all
- Each heartbeat costs $0.10-0.30 depending on what the agent does
- Conservative = ~$0.40-1.20/day in heartbeat costs

**Model (`AGENT_MODEL`)**
- Default: `claude-opus-4-6` (most capable)
- Can be changed to other Claude models if desired
- Opus provides the best reasoning for autonomous agent tasks

**Firecrawl API Key (`FIRECRAWL_API_KEY`)**
- Optional — enables web scraping via Firecrawl API
- Without it, the agent falls back to WebFetch and browser tools
- Get a key at firecrawl.dev

### 3. Recommend settings for first-time users

For first-time users, recommend:
```
MAX_DAILY_BUDGET_USD=5          # Safe daily limit
MAX_SESSION_BUDGET_USD=50       # Generous session cap
HEARTBEAT_MODE=conservative     # 4 check-ins/day
ENABLE_1M_CONTEXT=false         # Standard pricing
AGENT_MODEL=claude-opus-4-6    # Best model
```

These are the defaults — if none of these env vars are set, you get these values automatically.

### 4. Ask for preferences

Ask the user if they want to change any settings. Common adjustments:
- Increase daily budget for heavy use days
- Set heartbeat to `off` during development/testing
- Enable 1M context for specific use cases

### 5. Apply changes

If running locally, offer to update the `.env` file directly.

If deploying to a remote Mac Mini, show the values to set in `~/hello-claw/.env` on the Mini:
```bash
ssh $MINI_HOST 'cat ~/hello-claw/.env'  # check current
# Edit and restart:
ssh $MINI_HOST 'launchctl stop com.hello-claw.agent'
# ... edit .env ...
ssh $MINI_HOST 'launchctl start com.hello-claw.agent'
```

Remind: after changing cost config, a service restart picks up new values (no session clear needed — these are read at process startup, not baked into sessions).
