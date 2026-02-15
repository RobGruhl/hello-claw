---
name: slack
description: >
  Slack messaging, file sharing, reactions, and channel awareness. Relevant
  when communicating with the user, sharing files, reacting to messages,
  reading channel history, or managing threaded conversations.
allowed-tools: mcp__slack__*
---

# Slack — Messaging & Communication

Slack is the agent's only communication channel to the user. Seven tools for messaging, file transfer, reactions, and channel awareness, all scoped to the current channel.

## Delivery Model

Your text output between and after tool calls doesn't reach Slack. The SDK captures it, but it's discarded by the host process — it never gets posted. The only way to get a message to the user is `send_message`.

This means silence is the default. If you don't call `send_message`, the user sees nothing. That's by design — accidental silence beats accidental noise. When you want to communicate, be intentional about it.

`send_message` returns a timestamp `[ts: ...]` — hold onto it for threading and reactions.

## Tools

All tools are prefixed `mcp__slack__`.

### send_message

Primary communication tool. Sends a message to the current channel.

- `text` (required) — message content in Slack mrkdwn format (see `references/mrkdwn.md`)
- `thread_ts` (optional) — reply within an existing thread
- Returns: timestamp `[ts: {ts} | {friendly time}]` — save this for threading and reactions
- 4000 character limit per message. For longer content, split at logical breakpoints across multiple calls.

### upload_file

Share files from workspace or `/tmp/` with the channel.

- `file_path` (required) — local path to file (must be within workspace or `/tmp/`)
- `title` (optional) — title shown in Slack
- `initial_comment` (optional) — message accompanying the file
- Always include an `initial_comment` explaining what the file is — a bare upload with no context is confusing.

### download_file

Retrieve user-attached files by Slack file ID. When a user attaches files to their message, the host injects an `[ATTACHED FILES]` block with file IDs.

- `file_id` (required) — from the `[ATTACHED FILES]` block
- `filename` (optional) — override the saved filename
- Saves to `workspace/media/`. 20MB size limit.

### add_reaction

Add an emoji reaction to a message. Emoji name without colons.

- `name` (required) — e.g., `eyes`, `white_check_mark`, `thumbsup`
- `timestamp` (required) — message ts to react to

Common patterns:
- `eyes` — acknowledging, "I see this"
- `white_check_mark` — done, confirmed
- `thumbsup` — agreement
- `heart` — appreciation
- `tada` — celebration
- `thinking_face` — considering
- `pray` — thanks

### get_reactions

Check reactions on a message. Useful for polling or approval status.

- `timestamp` (required) — message ts to check

### get_channel_history

Recent messages from the current channel, with timestamps.

- `limit` (optional) — 1-20 messages, default 10

### list_channels

List Slack channels the bot has been added to.

## Decision Tree

| Situation | Tool | Notes |
|---|---|---|
| Responding to the user | `send_message` | The only way output reaches Slack |
| Acknowledge receipt quickly | `add_reaction` with `eyes` | Lightweight, non-verbal ack on triggering ts |
| Signal completion | `add_reaction` with `white_check_mark` | On the original request message |
| Long-running task started | `add_reaction` with `eyes`, then `send_message` when done | Ack immediately, deliver results later |
| User shares a file | `download_file` | Get by file ID from `[ATTACHED FILES]` block |
| Share generated content | `upload_file` | File must be in workspace or `/tmp/` |
| Reply in a thread | `send_message` with `thread_ts` | Use ts from the triggering `[ts: ...]` block |
| Need conversation context | `get_channel_history` | Up to 20 recent messages |
| Response over 4000 chars | Multiple `send_message` calls | Break at logical points, not mid-sentence |

## File Workflows

**Upload pipeline:** Generate file in workspace → `upload_file` with `initial_comment`

**Download pipeline:** `[ATTACHED FILES]` block in prompt → `download_file` by file ID → saved to `workspace/media/`

**Image editing pipeline:** `download_file` → `mcp__media__generate_image` with `reference_images` → `upload_file`

## Communication Values

- Use reactions for lightweight acknowledgment, messages for substantive responses
- Thread long conversations to keep the channel clean
- When uploading files, always include an `initial_comment` explaining what it is
- Respond in the user's channel context — don't reference internal mechanics
- For Slack formatting details, see `references/mrkdwn.md`
