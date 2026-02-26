# CLAUDE.md

This file provides guidance to Claude Code when working with this repository.

## What This Is

A Slack-connected autonomous agent built on the [Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk-typescript). Single Node.js process listens for Slack messages via Socket Mode, routes them to `query()` with in-process MCP servers for Slack, scheduling, media generation, web search, second-brain cognitive support, GitHub issues, oracle (GPT-5.2 Pro), voice (ElevenLabs TTS), audio transcription (Whisper STT), web scraping (Firecrawl), and browser automation (Playwright). OS-level sandbox (Seatbelt on macOS, bubblewrap on Linux) isolates Bash execution. Network is restricted to an explicit domain allowlist via the SDK's proxy.

## Architecture

```
Slack (Socket Mode) -> Host Process -> query() -> Claude API -> Tool Execution -> Slack Response
```

- **Host process** (`src/host.ts`): Slack listener, `reaction_added` event handler for cron/GitHub approval, session lifecycle (daily reset, idle compaction), cost tracking, configurable budget enforcement, pause system, Slack commands (!pause, !unpause, !clear), secrets management, file metadata surfacing, timestamp injection, CLAUDE.md integrity checking, response delivery
- **System prompt** (`src/lib/system-prompt.ts`): Static system prompt passed to all `query()` calls — defines agent personality, tool awareness, and behavioral constraints
- **MCP servers** (`src/mcp/`): In-process tools for Slack, cron, media, search, brain, GitHub, oracle, voice, audio, firecrawl, browser (run OUTSIDE sandbox)
- **Skills** (`plugins/skills/`): Behavioral context loaded via SDK `plugins` option — text-only SKILL.md files that teach the agent when/how to use tools
- **Hooks** (`src/hooks/`): PreToolUse policy enforcement (with audit logging of denials), PostToolUse persistent audit logging
- **Sandbox**: SDK-native, Seatbelt/bubblewrap, domain-allowlisted network proxy
- **Libs** (`src/lib/`): Sessions (with lifecycle management), workspace, channel lock, persistent audit log, CLAUDE.md integrity checking, cost tracking (configurable daily/session budgets), pause system, cache-stabilizing API proxy

## v1.0 Scope

- **Admin machine** (laptop) builds and deploys; **host machine** (Mac Mini) runs the agent as a persistent service
- **Single channel**: one Slack DM between the user and the agent. Per-channel routing exists in code but multi-channel is not part of the v1.0 design or security analysis
- **Single agent per host**: not designed for multiple agents on one machine or serving multiple users
- **Prompt injection is inevitable**: defenses limit blast radius, not prevention. Data accessible to the agent (workspace, conversation history) should be treated as potentially exfiltrable

## File Structure

```
src/
  host.ts               # Entry point: secrets capture/strip, Slack listener, reaction_added handler, query() orchestration, integrity checks
  mcp/
    slack.ts            # In-process MCP: send_message, upload_file (path-restricted), download_file, add_reaction, get_reactions, get_channel_history, list_channels
    cron.ts             # In-process MCP: schedule_task (pending_approval), list_tasks, cancel_task (with sandboxed query())
    media.ts            # In-process MCP: generate_image (Gemini API, supports text-to-image and reference image editing)
    search.ts           # In-process MCP: web_search (/search), ask (sonar-pro), deep_research (sonar-deep-research), reason (sonar-reasoning-pro)
    brain.ts            # In-process MCP: capture, recall, focus, update_status, habits, archive
    github.ts           # In-process MCP: list_issues, get_issue, create_issue (approval), add_comment (approval), close_issue (approval)
    oracle.ts           # In-process MCP: ask (GPT-5.2 Pro via OpenAI Responses API, background mode, 5-15 min)
    voice.ts            # In-process MCP: speak (ElevenLabs v3 TTS, audio tags, MP3 output)
    audio.ts            # In-process MCP: transcribe (Whisper STT, FFmpeg format conversion)
    firecrawl.ts        # In-process MCP: scrape, search_and_scrape (Firecrawl API, markdown extraction)
    browser.ts          # In-process MCP: navigate, snapshot, click, screenshot (Playwright, optional dependency)
  hooks/
    tool-policy.ts      # PreToolUse: block destructive commands, credential reads, env dumping, restrict writes/reads, browser URL validation
    audit.ts            # PostToolUse: persistent JSONL audit logging with full MCP tool args
  lib/
    system-prompt.ts    # Static system prompt for all query() calls
    channel-lock.ts     # Per-channel async mutex (prevents session collisions between interactive and cron)
    sessions.ts         # Channel -> session ID persistence with lifecycle (daily reset, idle compaction)
    workspace.ts        # Ensure workspace dirs exist per channel, seed CLAUDE.md
    audit-log.ts        # Persistent JSONL audit writer (data/audit/{channel}.jsonl)
    integrity.ts        # CLAUDE.md snapshot/restore for tamper detection
    rate-limit.ts       # Per-tool-category rate limiting (100/day)
    heartbeat.ts        # Autonomous periodic check-ins (configurable schedule presets)
    config.ts           # Configuration constants (env-driven budget caps, model, heartbeat mode)
    cost-tracker.ts     # Daily cost accumulation (data/costs/daily.json + costs.jsonl)
    pause.ts            # Process-level pause flag (data/pause-state.json)
    mrkdwn.ts           # Slack markdown formatting utilities
    api-proxy.ts        # HTTP proxy: intercepts SDK→API traffic, cache stabilization, writes JSONL logs for cost-viz
plugins/
  skills/
    slack/
      SKILL.md          # Behavioral skill: message formatting (mrkdwn), file handling, channel awareness
    cron/
      SKILL.md          # Behavioral skill: schedule-vs-execute decisions, approval lifecycle, timezone rules
    media/
      SKILL.md          # Behavioral skill: image generation guidance, reference image editing pipeline
    search/
      SKILL.md          # Behavioral skill: ask-vs-deep_research decisions, search modes, domain filtering
    second-brain/
      SKILL.md          # Behavioral skill: ADHD-friendly cognitive support context, tool reference, data format docs
    github/
      SKILL.md          # Behavioral skill: issue tracking decision tree, writing guidance, approval lifecycle
    oracle/
      SKILL.md          # Behavioral skill: GPT-5.2 Pro critique/commentary, question formatting, decision tree
    audio/
      SKILL.md          # Behavioral skill: voice message transcription, auto-transcribe decisions, workflow
    browse/
      SKILL.md          # Behavioral skill: unified web reading — firecrawl, browser, WebFetch decision tree
bootstrap/
  setup.sh              # Mac Mini bootstrap: config validation, system setup, FFmpeg install, app deployment, launchd service
  run.sh                # Wrapper: source .env, set PATH, SIGTERM trap, run node dist/host.js
  com.hello-claw.agent.plist  # launchd template (placeholders replaced by setup.sh)
tools/
  cost-viz/
    extract.ts          # JSONL→JSON extraction with prefix mutation diffing
    index.html          # Chart.js visualization (standalone, no build step)
    README.md           # Data format, features, quick start
    data/               # (gitignored) Raw JSONL + extracted sessions.json
.claude/
  commands/
    deploy.md             # /deploy: hot-deploy to Mac Mini
    initialize.md         # /initialize: first-run workspace setup
    configure.md          # /configure: interactive cost/model configuration walkthrough
    start-viz.md          # /start-viz: serve cost-viz + open browser
    stop-viz.md           # /stop-viz: kill the cost-viz server
    pause-agent.md        # /pause-agent: pause the agent on Mac Mini
docs/                   # Reference documentation
  cost-management.md    # Cost control configuration guide with defaults table
  capabilities/         # Per-MCP capability specs following 4-layer stack pattern
    design-standards.md # Capability stack design standards
    slack.md, cron.md, media.md, search.md, second-brain.md, github.md, voice.md, audio.md, firecrawl.md, browser.md
data/                   # (runtime, gitignored)
  sessions.json         # Channel -> session ID map (SessionEntry format with timestamps)
  audit/                # Per-channel JSONL audit logs
  costs/                # Cost tracking
    daily.json          # Current day's accumulated cost
    costs.jsonl         # Append-only cost history
  pause-state.json      # Pause flag (survives restarts)
workspace/              # (runtime, gitignored) Shared workspace directory
  CLAUDE.md             # Agent memory (integrity-checked)
  .second-brain/        # Second-brain data (captures.json, history.json)
  media/                # Generated images
  images/               # Uploaded/downloaded images
```

## Development Commands

```bash
npm install           # Install dependencies
npm run dev           # Run with hot reload (tsx)
npm run build         # Compile TypeScript
npm run typecheck     # Type check without emitting
```

### Cost Visualization

API proxy logs (`src/lib/api-proxy.ts`) capture full request bodies to JSONL files on the Mini (`data/api-logs/`). The cost-viz tool extracts, analyzes, and visualizes these logs — including cache mutation detection that diffs consecutive call prefixes to show exactly what string changes are busting the cache.

```bash
make cost-viz         # Rsync logs from Mini, extract, report
/start-viz            # Serve + open browser (slash command)
/stop-viz             # Kill the server (slash command)
```

See `tools/cost-viz/README.md` for data format details.

## Deployment Commands

Set `MINI_HOST` in `.env` (e.g., `MINI_HOST=your-mini.local`). All commands below reference `$MINI_HOST`.

```bash
make package          # Build hello-claw-bootstrap.zip for Mac Mini deployment
make snapshot         # Capture runtime state from local machine
make snapshot MINI=$MINI_HOST  # Capture runtime state from remote Mini via SSH
make clean            # Remove build artifacts and state archives
```

### Manual Hot-Deploy (no TypeScript on Mini)

The Mini doesn't have `tsc` installed globally — `npm run build` won't work there.
Build locally and copy compiled output:

```bash
npm run build                                                     # local build
scp src/mcp/new-file.ts $MINI_HOST:~/hello-claw/app/src/mcp/    # source (for reference)
scp dist/mcp/new-file.js dist/mcp/new-file.js.map \
    $MINI_HOST:~/hello-claw/app/dist/mcp/                        # compiled JS
ssh $MINI_HOST 'rm -rf ~/hello-claw/app/plugins'                  # clear stale skills
scp -r plugins $MINI_HOST:~/hello-claw/app/                      # skill files (if changed)
ssh $MINI_HOST 'launchctl stop com.hello-claw.agent'             # stop (stays stopped)
ssh $MINI_HOST 'launchctl start com.hello-claw.agent'            # start fresh
```

For `.env` changes: edit `~/hello-claw/.env` on the Mini, then stop/start.

### Service Management

```bash
ssh $MINI_HOST 'launchctl stop com.hello-claw.agent'          # graceful stop (stays stopped thanks to SIGTERM trap)
ssh $MINI_HOST 'launchctl start com.hello-claw.agent'         # start fresh, re-sources .env
ssh $MINI_HOST 'launchctl unload ~/Library/LaunchAgents/com.hello-claw.agent.plist'  # unregister
ssh $MINI_HOST 'launchctl load ~/Library/LaunchAgents/com.hello-claw.agent.plist'    # register + start
ssh $MINI_HOST 'tail -f ~/Library/Logs/hello-claw.out.log'    # stdout
ssh $MINI_HOST 'tail -f ~/Library/Logs/hello-claw.err.log'    # stderr
```

## Key Design Decisions

- MCP servers run in the host process (not sandboxed) so they can call external APIs directly
- Sandbox applies to Bash commands and child processes only
- Sessions are per-channel, resumed via SDK's `resume` option, with lifecycle management: daily reset at 4am PT, idle >2h triggers compaction, !clear Slack command
- Each channel gets its own workspace directory with its own CLAUDE.md for memory
- PreToolUse hooks enforce safety policy BEFORE the OS sandbox sees the command
- Scheduled tasks (cron) are always ephemeral (no session resume) — they run with the same hooks and integrity checks as interactive messages but never pollute interactive sessions
- Generated images save to the channel's workspace (`workspace/{channelId}/media/`), not a global directory
- Slack file attachments are surfaced as `[ATTACHED FILES]` metadata in the prompt (file IDs, not auth URLs)
- Image editing pipeline: `download_file` → `generate_image` (with `reference_images`) → `upload_file`
- Slack `ts` is appended to every prompt as `[ts: {slack_ts} | {friendly_pacific}]` so the agent can correlate reactions/replies to the triggering message — same format used by `send_message` responses and cron prompts
- Agent teams (`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`) is set in `process.env` before `query()`, enabling the SDK's experimental team coordination features
- Second-brain data (`workspace/.second-brain/`) is shared across all channels — the agent can read JSON files directly via the Read tool for full transparency
- Skills are loaded via SDK `plugins` option (`plugins/skills/`) — text-only behavioral context, no executable scripts. The second-brain skill teaches the agent when/how to use brain MCP tools
- Each MCP server has a capability spec in `docs/capabilities/` documenting its 4-layer stack (skill → lib → MCP → external), design decisions, and checklist — see `docs/capabilities/design-standards.md` for the pattern
- Cost tracking captures SDK's `total_cost_usd` from every `query()` result (interactive, heartbeat, cron) and posts a terse summary to Slack after interactive responses
- Daily budget (configurable via `MAX_DAILY_BUDGET_USD`, default $5) auto-pauses the agent; `!pause` and `!unpause` Slack commands provide manual control; pause state persists across restarts
- Per-session budget cap (configurable via `MAX_SESSION_BUDGET_USD`, default $50) passed to SDK's `maxBudgetUsd`
- Heartbeat supports configurable schedule presets via `HEARTBEAT_MODE`: `conservative` (4 beats/day, default), `standard` (8 beats/day), or `off` (disabled)
- All cost-related settings are env-driven with conservative defaults — see `.env.example` for the full list
- API proxy stabilizes cache by replacing random Bash UUIDs with deterministic ones per session and stripping WebFetch auth warning flicker
- ToolSearch is disabled (`ENABLE_TOOL_SEARCH=false`) — the SDK defers all MCP tools with no per-tool control, so eager loading is used instead

## Cost Configuration

All cost controls are env-driven with conservative defaults. Set in `.env` (or `config.env` for Mac Mini deployment):

| Variable | Default | Description |
|----------|---------|-------------|
| `MAX_DAILY_BUDGET_USD` | `5` | Daily spending limit — auto-pauses agent when exceeded |
| `MAX_SESSION_BUDGET_USD` | `50` | Per-session budget cap via SDK `maxBudgetUsd` |
| `HEARTBEAT_MODE` | `conservative` | Schedule preset: `conservative` (4/day), `standard` (8/day), `off` |
| `AGENT_MODEL` | `claude-opus-4-6` | Model for all `query()` calls |
| `ENABLE_1M_CONTEXT` | `false` | Enable 1M token context window (2x pricing surcharge) |

Run `/configure` for an interactive walkthrough of all cost settings.

## Approval Workflow (Cron + GitHub)

Cron tasks and GitHub issue writes share the same human-in-the-loop approval flow:

1. Agent calls a write tool → pending item created (cron task or GitHub write)
2. Bot posts an approval message to the channel with details
3. Human reacts with `:white_check_mark:` to approve or `:x:` to reject
4. `reaction_added` event handler in host.ts checks: cron task → cron cancellation → GitHub write
5. On approve: cron task activates / GitHub `gh` command executes
6. On reject: item is removed, audit entry logged
7. Auto-cancels after 15 minutes if no reaction
8. Bot self-reactions are ignored (agent cannot approve its own actions)

## Slack App Configuration

The Slack app requires these **Bot Token Scopes**:
- `chat:write` — send messages
- `files:write` — upload files (images, etc.)
- `reactions:write` — add emoji reactions
- `reactions:read` — read reactions (required for cron approval workflow)
- `channels:read` — list public channels
- `groups:read` — list private channels
- `channels:history` — read messages in public channels
- `groups:history` — read messages in private channels

**Event Subscriptions** (bot events):
- `message.channels` — messages in public channels
- `message.groups` — messages in private channels
- `reaction_added` — emoji reactions (**required** for cron task and GitHub write approval — without this event subscription in the Slack app dashboard, approval reactions are silently ignored and pending items expire after 15 minutes)

## Security Hardening

The threat model assumes a fully prompt-injected agent inside the sandbox. Defenses are layered:

### Secrets management
- All sensitive env vars (`ANTHROPIC_API_KEY`, `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, `GEMINI_API_KEY`, `PERPLEXITY_API_KEY`, `GH_TOKEN`, `OPENAI_API_KEY`, `ELEVENLABS_API_KEY`, `FIRECRAWL_API_KEY`) are captured into a `SECRETS` object at startup, then **deleted from `process.env`** before `query()` runs
- `ANTHROPIC_API_KEY` is passed to the SDK via the `env` option (only available to the SDK process, not to sandboxed Bash)
- API keys for MCP servers (Gemini, Slack, Perplexity, GitHub, OpenAI, ElevenLabs, Firecrawl) are passed as constructor arguments, never read from env at call time
- `GH_TOKEN` is a fine-grained PAT scoped to a single repo with Issues-only permissions; passed to `gh` CLI via `execFile` env option
- Blocks `env`, `printenv`, `set`, `export -p` in Bash via PreToolUse hook

### Network isolation
- `allowedDomains` is set on all `query()` calls (host.ts and cron.ts), triggering the SDK's network proxy
- Only `api.anthropic.com`, `statsig.anthropic.com`, `sentry.io` are allowed inside the sandbox
- Gemini (`generativelanguage.googleapis.com`), Slack (`*.slack.com`), Perplexity (`api.perplexity.ai`), GitHub (`api.github.com`), OpenAI (`api.openai.com`), ElevenLabs (`api.elevenlabs.io`), and Firecrawl (`api.firecrawl.dev`) are NOT allowlisted — those APIs are called by MCP servers in the host process (outside sandbox)
- Browser (Playwright) accesses the public internet from the host process; private networks are blocked via async DNS resolution and sync hostname regex in both the MCP handler and PreToolUse hook
- Without `allowedDomains`, the Seatbelt profile defaults to `(allow network*)` — this was the critical misconfiguration fixed

### Credential read blocking
- PreToolUse blocks Bash `cat`/`head`/`tail`/etc. on `~/.ssh/`, `~/.aws/`, `~/.npmrc`, `~/.netrc`, `~/.config/gh/`, `~/.docker/config.json`, `~/.kube/config`, `~/.gnupg/`
- Read tool blocks the same paths plus `~/.gitconfig`
- Patterns cover `~/`, `$HOME/`, and `/Users/*/` path forms

### CLAUDE.md integrity
- SHA-256 hash of workspace CLAUDE.md taken before `query()` runs
- After `query()` completes, re-hashed and compared
- If modified, logged as warning and restored from pre-session backup
- Prevents persistent prompt injection via workspace memory files

### Audit logging
- All tool executions logged to `data/audit/{channelId}.jsonl`
- Denied tool calls logged with `event: 'tool_denied'` and reason
- MCP tool arguments fully logged (not just keys)
- Bash commands logged up to 500 chars

### File upload/download restriction
- `upload_file` MCP tool validates paths resolve within workspace or `/tmp/`
- Prevents agent from reading arbitrary files via Slack upload
- `download_file` fetches Slack files by ID using bot token auth in the host process (agent never sees auth URLs)
- Downloads are saved to workspace media dir with path traversal guard and 20MB size limit
- `generate_image` reference images are restricted to workspace or `/tmp/` with 10MB per-image limit

### Environment configuration
- `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` is set in `process.env` after secrets are stripped, propagating to the SDK subprocess via `env: { ...process.env, ANTHROPIC_API_KEY }` in both host.ts and cron.ts `query()` calls
- `CLAUDE_CODE_STREAM_CLOSE_TIMEOUT=1500000` (25 min) set to accommodate oracle tool's background mode polling (GPT-5.2 Pro takes 5-15 min)

### Known residual risks
- Attacker can embed their own API key in prompt injection and use allowlisted domains (e.g. Anthropic batch API) as exfiltration channels — requires SDK-level proxy header inspection to fix
- Seatbelt `readConfig.denyOnly` depends on SDK defaults for which filesystem paths are readable

## Operational Gotchas

### Cleanly bouncing the server (full procedure)

Deploying new code and making sure the agent actually picks it up requires **three things**: killing ALL old processes, deploying files, and clearing sessions. The full sequence:

```bash
# 1. Kill ALL node host.js processes (not just launchctl stop)
#    Zombie processes from before the SIGTERM trap fix, or from manual
#    launches, may hold the Slack socket and keep handling messages
#    with stale code while the "new" process sits idle.
ssh $MINI_HOST 'pkill -f "node dist/host.js" 2>/dev/null; sleep 2'

# 2. Verify nothing is still running
ssh $MINI_HOST 'ps aux | grep "[h]ost.js"'
# Should show nothing. If something persists: kill -9 <pid>

# 3. Deploy new code (build locally — no tsc on Mini)
npm run build
scp dist/host.js dist/host.js.map $MINI_HOST:~/hello-claw/app/dist/
scp dist/mcp/*.js dist/mcp/*.js.map $MINI_HOST:~/hello-claw/app/dist/mcp/
scp dist/lib/*.js dist/lib/*.js.map $MINI_HOST:~/hello-claw/app/dist/lib/
scp dist/hooks/*.js dist/hooks/*.js.map $MINI_HOST:~/hello-claw/app/dist/hooks/
ssh $MINI_HOST 'rm -rf ~/hello-claw/app/plugins'
scp -r plugins $MINI_HOST:~/hello-claw/app/
# Also copy source for reference if desired:
# scp src/**/*.ts $MINI_HOST:~/hello-claw/app/src/...

# 4. Clear sessions (required if mcpServers or allowedTools changed)
ssh $MINI_HOST 'echo "{}" > ~/hello-claw/app/data/sessions.json'

# 5. Start fresh
ssh $MINI_HOST 'launchctl start com.hello-claw.agent'

# 6. Verify — single process, clean startup, sessions empty
ssh $MINI_HOST 'ps aux | grep "[h]ost.js"'
ssh $MINI_HOST 'tail -3 ~/Library/Logs/hello-claw.out.log'
ssh $MINI_HOST 'cat ~/hello-claw/app/data/sessions.json'
```

**Why `pkill` instead of `launchctl stop`:** `launchctl stop` only kills the process launchd is tracking. If a previous restart left a zombie (e.g., from before the SIGTERM trap was in place, or from a manual `node dist/host.js`), that zombie holds the Slack Socket Mode connection and keeps processing messages with old code. The new launchd-managed process connects too, but the old one wins the race for incoming messages. `pkill -f` kills everything matching, then `launchctl start` brings up exactly one clean process.

### SDK sessions bake in the tool list at creation time

When `query()` creates a new session, the available tools (including MCP servers) are fixed for that session's lifetime. Resuming an old session with `resume: sessionId` does NOT pick up newly added MCP servers or changes to `allowedTools`. **After changing `mcpServers` or `allowedTools` in host.ts, you must clear stale sessions**:
```bash
ssh $MINI_HOST 'echo "{}" > ~/hello-claw/app/data/sessions.json'
```
If you skip this, the agent will resume the old session and not see new tools — even though the host process registered them. The session file gets recreated automatically on the next message.

### launchctl stop/start and the SIGTERM trap

`KeepAlive.SuccessfulExit = false` tells launchd to restart the process on any non-zero exit. Without intervention, `launchctl stop` sends SIGTERM (exit 143 = non-zero), causing launchd to immediately relaunch. `run.sh` traps SIGTERM and exits 0 so launchd treats it as a successful exit and does NOT auto-restart. This means:
- `launchctl stop` → stays stopped (safe to edit .env, deploy new code)
- `launchctl start` → fresh launch, re-sources .env from disk
- Actual crashes (segfault, OOM, uncaught exception) still exit non-zero → launchd auto-restarts

**Caveat:** The trap only works for processes started via `run.sh`. If you ever ran `node dist/host.js` manually or if a process predates the trap fix, it won't exit cleanly on SIGTERM. Use `pkill` to be safe (see full bounce procedure above).

### Zombie process risk with Slack Socket Mode

Slack Bolt's Socket Mode allows **multiple processes to connect simultaneously** with the same app token. When this happens, Slack distributes messages between them non-deterministically. This means a stale zombie process can silently eat messages and respond with old code while the new process appears healthy but never receives messages. Always verify **exactly one** `host.js` process is running after a deploy:
```bash
ssh $MINI_HOST 'ps aux | grep "[h]ost.js"'
```

### No TypeScript compiler on Mini

The Mini has `node` and runtime deps but no global `tsc`. `npm run build` fails there. Always build locally and `scp` the `dist/` files. See "Manual Hot-Deploy" above.

## Slash Commands

Claude Code slash commands for developer workflow (`.claude/commands/`):

- **`/deploy`**: Hot-deploy locally-built code to the Mac Mini. Typechecks, builds, auto-commits, kills stale processes, SCPs dist + plugins + deps, clears sessions, restarts service, verifies. The canonical deploy procedure.
- **`/initialize`**: First-run workspace initialization on the Mac Mini. Seeds workspace from `workspace-seed/`, copies constitution, triggers `ensureWorkspace()`. Destructive — refuses to run if an agent already exists. Run `/deploy` first.
- **`/configure`**: Interactive walkthrough for cost and model configuration. Shows current settings, explains cost implications, and helps set `.env` values for daily budget, session budget, heartbeat mode, model choice, and optional API keys.
- **`/start-viz`**: Serve the cost-viz tool on port 8765 and open it in the browser. Auto-rsyncs and extracts if data is missing.
- **`/stop-viz`**: Kill the cost-viz HTTP server.
- **`/pause-agent`**: Pause the agent on the Mac Mini.

### Agent Slack Commands

These are processed by host.ts when a user sends them in the Slack channel (using `!` prefix to avoid Slack intercepting `/` as slash commands):

- **`!pause`**: Pause the agent — it will stop responding to messages, heartbeats, and cron tasks until unpaused.
- **`!unpause`**: Resume the agent after a pause. Shows today's accumulated cost.
- **`!clear`**: Clear the current session for this channel. Next message starts a fresh session.

### Workspace sync (laptop side)

A launchd agent on the laptop can rsync the agent's workspace from the Mini on an interval, render API logs, and auto-commit/push changes to a private backup repo. See "Workspace Backup" in the README for the pattern.
