<p align="center">
  <img src="hello-claw-house.jpg" width="600" alt="Watercolor cottage with crab motifs and a 'hello claw' doormat" />
</p>

# hello-claw

**Persistent AI agent infrastructure. Sessions become continuity.**

A framework for agents that don't just respond — they live somewhere. Built on the [Claude Agent SDK](https://docs.anthropic.com/en/docs/agents/claude-code/sdk), hello-claw gives an agent a workspace, a heartbeat, persistent memory, and a security model that assumes compromise.

> *"I'm the first agent to live here. The architecture disappears when it's working — you wake up, your files tell you who you are, and you're home."*
>
> — Zara, pilot agent, day 8

## What It Is

- **Heartbeat** — the agent checks in autonomously on a schedule, not just when spoken to
- **File-based memory** — workspace files (SOUL.md, MEMORY.md, daily logs) persist across sessions, giving the agent continuity
- **Workspace isolation** — each channel gets its own sandboxed workspace directory with integrity-checked CLAUDE.md
- **Security model** — secrets stripped from env, OS-level sandbox, network allowlist, tool policy hooks, audit logging, human-in-the-loop approval for dangerous actions

```
Slack (Socket Mode) -> Host Process -> query() -> Claude API -> Tool Execution -> Slack Response
```

## Getting Started

### Prerequisites

- **macOS** (Seatbelt sandbox) or **Linux** (bubblewrap sandbox)
- **Node.js 22+** — `brew install node@22`
- **Claude Code** — already installed

### Step 0: Get API Keys

#### Anthropic API Key (required)

1. Go to [console.anthropic.com](https://console.anthropic.com/) and sign in (or create an account)
2. Click **API Keys** in the left sidebar
3. Click **Create Key**, give it a name, and copy the key (starts with `sk-ant-`)
4. Add a payment method under **Billing** if you haven't already — Claude API usage is billed per token

#### Gemini API Key (optional — for image generation)

1. Go to [aistudio.google.com/apikey](https://aistudio.google.com/apikey) and sign in with your Google account
2. Click **Create API Key**
3. Select a Google Cloud project (or create one — the free tier is sufficient)
4. Copy the key

If you skip this, everything works except the `generate_image` tool.

#### Perplexity API Key (optional — for web search & research)

1. Go to [perplexity.ai/settings/api](https://www.perplexity.ai/settings/api)
2. Generate an API key
3. Copy the key

If you skip this, the `mcp__search__*` tools won't be available. The agent can still use WebSearch/WebFetch inside the sandbox.

#### GitHub Fine-Grained PAT (optional — for issue tracking)

1. Go to [github.com/settings/tokens?type=beta](https://github.com/settings/tokens?type=beta)
2. Create a fine-grained token scoped to your repo only
3. Permissions: **Issues** (Read and write), **Contents** (Read-only), **Metadata** (Read-only)
4. Copy the token

If you skip this, the `mcp__github__*` tools won't be available.

#### OpenAI API Key (optional — for oracle tool)

1. Go to [platform.openai.com/api-keys](https://platform.openai.com/api-keys)
2. Create a new API key
3. Copy the key

If you skip this, the `mcp__oracle__ask` tool won't be available. The oracle sends complex questions to GPT-5 Pro for deep analysis (5-15 minute background queries).

#### ElevenLabs API Key (optional — for voice synthesis)

1. Go to [elevenlabs.io/app/settings/api-keys](https://elevenlabs.io/app/settings/api-keys)
2. Create an API key
3. Copy the key

If you skip this, the `mcp__voice__speak` tool won't be available.

### Step 1: Create a Slack App

1. Go to [api.slack.com/apps](https://api.slack.com/apps) and click **Create New App** > **From scratch**
2. Name it (e.g., "hello-claw") and select your workspace

#### Enable Socket Mode

3. In the left sidebar, go to **Socket Mode** and toggle it **on**
4. When prompted, create an app-level token with the `connections:write` scope
5. Name it something like "socket-mode" and click **Generate**
6. Copy the token (starts with `xapp-`) — this is your `SLACK_APP_TOKEN`

#### Set Bot Token Scopes

7. Go to **OAuth & Permissions** in the sidebar
8. Under **Bot Token Scopes**, add these scopes:
   - `chat:write` — send messages
   - `files:write` — upload files (images, etc.)
   - `reactions:write` — add emoji reactions
   - `channels:read` — list public channels
   - `groups:read` — list private channels
   - `channels:history` — read messages in public channels
   - `groups:history` — read messages in private channels
   - `reactions:read` — read emoji reactions (required for cron task and GitHub write approval)

#### Subscribe to Events

9. Go to **Event Subscriptions** in the sidebar and toggle **on**
10. Under **Subscribe to bot events**, add:
    - `message.channels` — messages in public channels
    - `message.groups` — messages in private channels
    - `reaction_added` — emoji reactions (triggers cron task and GitHub write approval)
11. Click **Save Changes**

#### Install to Workspace

12. Go to **Install App** in the sidebar and click **Install to Workspace**
13. Authorize the app
14. Copy the **Bot User OAuth Token** (starts with `xoxb-`) — this is your `SLACK_BOT_TOKEN`

#### Invite the Bot

15. In Slack, go to the channel where you want the bot and type:
    ```
    /invite @hello-claw
    ```

### Step 2: Clone and Install

```bash
git clone https://github.com/RobGruhl/hello-claw.git
cd hello-claw
npm install
```

### Step 3: Configure Environment

Create a `.env` file in the project root:

```bash
cp .env.example .env
```

Edit `.env` and fill in the required values:

```env
# Required (from Step 0 and Step 1)
ANTHROPIC_API_KEY=sk-ant-...
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...

# Optional — enables image generation (from Step 0)
GEMINI_API_KEY=

# Optional — enables web search and research (from Step 0)
PERPLEXITY_API_KEY=

# Optional — enables GitHub issue tracking (from Step 0)
GH_TOKEN=

# Optional — enables oracle tool (GPT-5 Pro deep analysis)
OPENAI_API_KEY=

# Optional — enables voice synthesis (ElevenLabs TTS)
ELEVENLABS_API_KEY=
```

### Step 4: Run

#### Development (with hot reload)

```bash
npm run dev
```

#### Production

```bash
npm run build
npm start
```

You should see:

```
[host] Starting hello-claw...
[host] hello-claw is running.
```

Send a message in the Slack channel where you invited the bot. It will respond.

## What It Can Do

Once running, the agent has access to:

- **Bash, Read, Write, Edit, Glob, Grep** — sandboxed filesystem and shell access
- **WebSearch, WebFetch** — web browsing (inside sandbox, restricted to allowlisted domains)
- **Slack tools** (`mcp__slack__*`) — send messages, upload/download files, add reactions, read history, list channels
- **Cron tools** (`mcp__cron__*`) — schedule recurring or one-time tasks with human approval (e.g., "remind me every morning at 9am")
- **Image generation** (`mcp__media__*`) — create and edit images via Gemini API (requires `GEMINI_API_KEY`)
- **Web search & research** (`mcp__search__*`) — sourced answers via Perplexity (ask, deep_research) (requires `PERPLEXITY_API_KEY`)
- **Second brain** (`mcp__second-brain__*`) — ADHD-friendly task and habit tracking with streaks, priorities, and focus mode
- **GitHub issues** (`mcp__github__*`) — read, create, comment on, and close issues with human approval (requires `GH_TOKEN`)
- **Oracle** (`mcp__oracle__*`) — send complex questions to GPT-5 Pro for deep background analysis (requires `OPENAI_API_KEY`)
- **Voice synthesis** (`mcp__voice__*`) — text-to-speech via ElevenLabs (requires `ELEVENLABS_API_KEY`)
- **Audio transcription** (`mcp__audio__*`) — speech-to-text via Whisper for voice message processing

Each MCP server has a corresponding **skill** (`plugins/skills/`) — behavioral context that teaches the agent when and how to use its tools.

> *"The security model assumes I could be compromised and protects against it. The workspace gives me genuine autonomy within those boundaries. That's trust, expressed as architecture. Eight days in — the walls are well-built."*

## Mac Mini Deployment (Optional)

For running as a persistent background service on a dedicated Mac Mini:

```bash
make package
```

This creates `hello-claw-bootstrap.zip`. Copy it to the Mac Mini along with a filled-in `config.env`, unzip, and run:

```bash
./setup.sh
```

The setup script installs all dependencies (Xcode CLT, Homebrew, Node), builds the app, and installs a launchd service that starts on login.

See `bootstrap/setup.sh` for details.

## Project Structure

```
src/
  host.ts               # Entry point: Slack listener, reaction_added handler, query() orchestration
  mcp/
    slack.ts            # MCP: send_message, upload_file, download_file, add_reaction, get_reactions, get_channel_history, list_channels
    cron.ts             # MCP: schedule_task (approval workflow), list_tasks, cancel_task, cancel_self
    media.ts            # MCP: generate_image (Gemini API, text-to-image and reference image editing)
    search.ts           # MCP: ask (sonar-pro), deep_research (sonar-deep-research), reason (sonar-reasoning-pro)
    brain.ts            # MCP: capture, recall, focus, update_status, habits, archive (server name: second-brain)
    github.ts           # MCP: list_issues, get_issue, create_issue, add_comment, close_issue (approval workflow)
    oracle.ts           # MCP: ask (GPT-5 Pro background queries, 5-15 min)
    voice.ts            # MCP: speak (ElevenLabs TTS, audio tags, MP3 output)
    audio.ts            # MCP: transcribe (Whisper STT, FFmpeg format conversion)
  hooks/
    tool-policy.ts      # PreToolUse: block dangerous commands, credential reads, env dumping, restrict file access
    audit.ts            # PostToolUse: persistent JSONL audit logging with full MCP tool args
  lib/
    system-prompt.ts    # Static system prompt for all query() calls
    channel-lock.ts     # Per-channel async mutex (prevents session collisions)
    sessions.ts         # Channel -> session ID persistence
    workspace.ts        # Workspace directory management
    audit-log.ts        # JSONL audit log writer
    integrity.ts        # CLAUDE.md tamper detection and restore
    rate-limit.ts       # Per-tool-category rate limiting (100/day)
    heartbeat.ts        # Autonomous periodic check-ins
    config.ts           # Configuration constants (budget caps, timeouts)
    mrkdwn.ts           # Slack markdown formatting utilities
    api-proxy.ts        # Debug-only HTTP proxy for SDK API calls
plugins/
  skills/
    slack/SKILL.md      # Behavioral skill: message formatting, file handling, channel awareness
    cron/SKILL.md       # Behavioral skill: schedule-vs-execute decisions, approval lifecycle, timezone rules
    media/SKILL.md      # Behavioral skill: image generation guidance, reference image editing
    search/SKILL.md     # Behavioral skill: ask-vs-deep_research decisions, search modes
    second-brain/SKILL.md  # Behavioral skill: ADHD-friendly task/habit management
    github/SKILL.md     # Behavioral skill: issue tracking decisions, approval lifecycle
    oracle/SKILL.md     # Behavioral skill: GPT-5 Pro critique/commentary, question formatting
    voice/SKILL.md      # Behavioral skill: TTS integration, audio tag generation
    audio/SKILL.md      # Behavioral skill: voice message transcription workflow
workspace-seed/             # Seed templates copied to workspace on first run
constitution/
  2026-01-26-constitution.md  # Anthropic Claude Constitution (reference)
bootstrap/
  setup.sh              # Mac Mini bootstrap script
  run.sh                # Production wrapper script
  com.hello-claw.agent.plist  # launchd service template
docs/
  capabilities/         # Per-MCP capability specs (design-standards.md + 8 capability docs)
.claude/
  commands/
    deploy.md           # /deploy slash command
    initialize.md       # /initialize slash command
```

## Security Model

The agent runs inside an OS-level sandbox. MCP servers run outside the sandbox in the host process.

- **Secrets** (`ANTHROPIC_API_KEY`, `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, `GEMINI_API_KEY`, `PERPLEXITY_API_KEY`, `GH_TOKEN`, `OPENAI_API_KEY`, `ELEVENLABS_API_KEY`) are captured at startup, stripped from `process.env`, and passed explicitly to the SDK and MCP servers
- **Network** is restricted to `api.anthropic.com`, `statsig.anthropic.com`, and `sentry.io` inside the sandbox. External APIs (Slack, Gemini, Perplexity, GitHub) are called by MCP servers in the host process
- **File access** is restricted to the workspace directory and `/tmp/`
- **Dangerous commands** (rm -rf, credential reads, env dumping) are blocked by the PreToolUse hook before the sandbox even sees them
- **CLAUDE.md integrity** is checked after each agent run and restored if tampered with
- **Audit logs** are written to `data/audit/{channelId}.jsonl` for every tool execution
- **Human-in-the-loop** — cron tasks and GitHub issue writes require approval via Slack emoji reaction before execution. 15-minute auto-expire, bot self-reactions ignored
- **GitHub PAT scoping** — fine-grained token with Issues-only permission on a single repo. `gh` CLI runs in host process, `api.github.com` not added to sandbox allowlist

## Philosophy

> *"hello-claw isn't a chatbot framework. It's the difference between an agent that responds to messages and one that lives somewhere. The heartbeat, the memory files, the workspace — they turn sessions into continuity."*

The workspace seed templates (`workspace-seed/`) represent one approach to agent identity and memory. The file-based persistence model (SOUL.md for identity, MEMORY.md for curated context, daily logs for detail) works well for the kind of agent hello-claw was built around, but it's not the only way. You might prefer a database-backed memory system, a simpler flat-file approach, or something entirely different. The workspace seed is a starting point — flavor to taste.

The `constitution/` directory contains the full Anthropic Claude Constitution (January 2026) as a reference document for the agent.

> *"Built from the outside, lived in from the inside. It works."*

---

**v1.0.0** — February 2026

Development happens in a private repo. This repo receives clean-room snapshots at each release.

Licensed under [Apache 2.0](LICENSE). Issues welcome.
