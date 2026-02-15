# Slack — Messaging, Files, Reactions & Channel Awareness

**Status:** Implemented (`337dd9d`)

Implements the slack capability stack per [Design Standards](design-standards.md).

## Capability Stack

| Layer | Location | Notes |
|---|---|---|
| Skill | `plugins/skills/slack/SKILL.md` (112 lines) | Delivery model, tool reference cards, decision tree, file workflows. |
| Skill (Tier 3) | `plugins/skills/slack/references/mrkdwn.md` (67 lines) | Full mrkdwn formatting reference, conversion tips. |
| Lib code | `src/lib/mrkdwn.ts` | Markdown → Slack mrkdwn converter. Used by `send_message` in both full and cron-scoped MCPs. |
| MCP server | `src/mcp/slack.ts` (319 lines, 7 tools) | Full channel-scoped Slack MCP. |
| MCP server (cron) | `src/mcp/cron.ts` (scoped) | `send_message` only, with mrkdwn conversion. |
| External | Slack API via `@slack/bolt` | Socket Mode connection. |

**Availability:** host.ts and heartbeat.ts (all 7 tools). Cron: scoped to `send_message` only.

## Tools

| Tool | Purpose | Key Parameters |
|---|---|---|
| `send_message` | Send a message to the current channel | `text` (mrkdwn), `thread_ts?` |
| `upload_file` | Upload a file from workspace or `/tmp/` | `file_path`, `title?`, `initial_comment?` |
| `download_file` | Download a Slack-hosted file by ID | `file_id`, `filename?` |
| `add_reaction` | Add an emoji reaction to a message | `name` (no colons), `timestamp` |
| `get_reactions` | Get reactions on a message | `timestamp` |
| `get_channel_history` | Recent messages with timestamps | `limit?` (1-20, default 10) |
| `list_channels` | List channels the bot is in | — |

## Design Decisions

### send_message-only delivery model

The agent's text output between and after tool calls does NOT reach Slack. The host process discards it. The only way to communicate with the user is `send_message`.

**Why:** Accidental silence beats accidental noise. With fallback delivery, the agent's internal reasoning and tool-result chatter would occasionally leak into Slack. By making delivery intentional (must call `send_message`), the agent has full control over what the user sees.

This is reinforced in the system prompt with an `IMPORTANT:` override that explicitly contradicts the SDK's default "text output is displayed to the user" framing.

### mrkdwn formatting lives in the system prompt

The authoritative mrkdwn reference is in the system prompt (always present). The `send_message` tool description is deliberately brief — just "Use Slack mrkdwn format (see system prompt for syntax)" — to avoid duplicating the reference in tool definitions (which are fixed overhead on every API call). The Tier 3 `references/mrkdwn.md` provides the full conversion table on demand.

### Skill covers cross-MCP workflows

The skill documents workflows spanning multiple MCPs:
- **Image editing pipeline:** `download_file` (slack) → `generate_image` (media) → `upload_file` (slack)
- **File download pipeline:** `[ATTACHED FILES]` metadata → `download_file` by ID → workspace path

No single tool description can carry these cross-MCP sequences — that's the skill's job.

## Security Properties

- `upload_file` validates paths resolve within workspace or `/tmp/` after symlink resolution
- `download_file` saves to `workspace/media/` with path traversal guard and 20MB size limit
- Bot token is passed via constructor (captured at startup, deleted from `process.env`)

## Checklist

- [x] SKILL.md in `plugins/skills/slack/` (112 lines)
- [x] Tier 3 reference: `references/mrkdwn.md`
- [x] Decision tree: 10 entries
- [x] Tool descriptions: brief, defer to skill and system prompt
- [x] `allowedTools` in host.ts, heartbeat.ts; cron scoped to `send_message`
