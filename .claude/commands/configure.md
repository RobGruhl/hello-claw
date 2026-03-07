# /configure — Interactive Cost & Model Configuration

Walk the user through configuring hello-claw's cost controls and model settings.

## Steps

### 1. Read current configuration

Read the `.env` file in the project root (if it exists) and extract current values for:
- `MAX_DAILY_BUDGET_USD` (default: 3)
- `MAX_SESSION_BUDGET_USD` (default: 50)
- `HEARTBEAT_MODE` (default: off)
- `AGENT_MODEL` (default: claude-sonnet-4-6)
- `AGENT_EFFORT` (default: high)
- `CRON_MODEL` (default: same as AGENT_MODEL)
- `AGENT_TIMEZONE` (default: America/Los_Angeles)
- `FIRECRAWL_API_KEY` (present or not)

Display a summary table showing each setting, its current value (or "default" if unset), and the default.

### 2. Explain each setting

**Daily Budget (`MAX_DAILY_BUDGET_USD`)**
- Controls when the agent auto-pauses to prevent runaway spending
- Default $3/day is frugal — a typical Sonnet session costs $0.10–1.00
- Heartbeats (if enabled) add roughly $0.10–0.40 each depending on tier
- The agent posts a warning at 50% and auto-pauses at 100%
- If you run Opus with heartbeats on, you'll want this higher — $15–20 is reasonable

**Session Budget (`MAX_SESSION_BUDGET_USD`)**
- SDK-level cap on a single `query()` call
- Default $50 is a safety net, not a daily control — most sessions use under $2
- If a session hits this, the SDK kills it mid-response

**Heartbeat Mode (`HEARTBEAT_MODE`)**
- `off` (default) — no autonomous check-ins. The agent only responds when spoken to.
- `conservative` — 4 beats/day: 8am (flagship), noon + 6pm (economy), 10pm (flagship)
- `standard` — 8 beats/day: 7am flagship, four midday economy beats, then a 10/10:30/11pm flagship wind-down trilogy
- Tiers: flagship beats run `AGENT_MODEL` at `AGENT_EFFORT`, economy beats run Sonnet at medium effort with 15-turn cap
- The heartbeat is what makes the agent a presence rather than a chatbot — but it costs money. Start with `off`, turn it on once you've built trust.

**Model (`AGENT_MODEL`)**
- Default `claude-sonnet-4-6` — good reasoning, one-fifth the cost of Opus
- Set `claude-opus-4-6` for the best reasoning the SDK can provide
- This is the primary model: interactive sessions + flagship heartbeat tier
- Economy heartbeat tier is always Sonnet regardless of this setting

**Effort (`AGENT_EFFORT`)**
- `low` | `medium` | `high` (default) | `max`
- Controls thinking depth. Higher effort means more output tokens and faster context growth.
- `high` is a good balance. `max` is for when you really need the agent to chew on something.
- Economy heartbeat tier always runs at `medium` regardless of this setting.

**Cron Model (`CRON_MODEL`)**
- Defaults to whatever `AGENT_MODEL` is
- Independent dial for scheduled tasks — a cron job that pulls a daily summary probably doesn't need Opus
- Set `claude-sonnet-4-6` or `claude-haiku-4-5-20251001` if your cron tasks are routine

**Timezone (`AGENT_TIMEZONE`)**
- IANA timezone string (e.g., `America/New_York`, `Europe/London`, `Asia/Tokyo`)
- Affects all agent-facing timestamps, cron schedules, and the 4am daily reset boundary
- Default `America/Los_Angeles` — change if you live somewhere else

**Firecrawl API Key (`FIRECRAWL_API_KEY`)**
- Optional — enables structured web scraping
- Without it, the agent falls back to WebFetch and browser tools
- Get a key at firecrawl.dev

### 3. Profiles

Offer two reference configurations:

**Frugal (the defaults):**
```
# Leave all unset — these are the defaults
# Sonnet, effort: high, heartbeat off, $3/day cap
```
Approximate idle cost: $0/day. Approximate light-use cost: under $1/day.

**Full presence (what the project was designed around):**
```
AGENT_MODEL=claude-opus-4-6
AGENT_EFFORT=high
HEARTBEAT_MODE=standard
MAX_DAILY_BUDGET_USD=20
```
Approximate cost: $5–15/day depending on interactive volume.

### 4. Ask for preferences

Common adjustments:
- Turn on heartbeat once the agent has a filled-out SOUL.md and knows who it is
- Raise daily budget for heavy-use days, lower it when you're away
- Change timezone if you're not on the US west coast
- Set `CRON_MODEL=claude-haiku-4-5-20251001` if you have routine scheduled tasks

### 5. Apply changes

If running locally, offer to update the `.env` file directly.

If deploying to a remote Mac Mini:
```bash
ssh $MINI_HOST 'cat ~/hello-claw/.env'  # check current
# Edit and restart:
ssh $MINI_HOST 'launchctl stop com.hello-claw.agent'
# ... edit .env ...
ssh $MINI_HOST 'launchctl start com.hello-claw.agent'
```

These settings are read at process startup, not baked into sessions — no session clear needed after changing them.
