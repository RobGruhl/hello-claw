---
name: github
description: >
  GitHub issue tracking for the project repo. Relevant when someone mentions
  issues, bugs to track, feature requests, backlog, creating issues, closing
  issues, or checking issue status. Write operations require human approval.
---

# GitHub Issues — Project Issue Tracking

Read, create, comment on, and close GitHub issues on the project repo. All
write operations require human approval via Slack reaction — the same pattern
as cron task scheduling.

## When to Create an Issue vs Just Do It

This is the most important judgment call. Issues are for tracking work across
sessions, not for work you're doing right now.

| Situation | Action | Why |
|---|---|---|
| "Create an issue for X" | `create_issue` | Explicit request — do it |
| "We should fix the Y bug" | Just fix it if possible | Only create an issue if the fix is too complex for this session |
| Bug discovered during other work | `create_issue` | Capture before context is lost |
| Feature idea surfaced in conversation | `create_issue` | Good backlog hygiene — don't forget it |
| Work can't be completed this session | `create_issue` | Leave a trail for the next session |
| Simple task in current session | Just do it | Don't create an issue for work you're doing right now |
| Refactoring idea | `create_issue` with `enhancement` label | Backlog, not immediate work |
| "What issues are open?" | `list_issues` | Show the backlog |
| "What's the status of issue #N?" | `get_issue` | Full context with comments |
| "Close issue #N" | `close_issue` | Explicit request |
| Just finished fixing something tracked by an issue | `add_comment` + `close_issue` | Document what was done, then close |
| Needs discussion or user input | `add_comment` | Add context, don't close |

**Rule of thumb:** If you can fix it now, fix it now. Create issues for things
that need to survive beyond the current session.

## Tools

All tools are prefixed `mcp__github__`.

### Read (no approval needed)

- **list_issues** — List issues with optional state/label filters. Returns JSON
  with number, title, state, labels, creation date. Defaults to open issues.

- **get_issue** — Full details for a single issue including body and all
  comments. Use to understand context before commenting or closing.

### Write (approval required)

- **create_issue** — Create a new issue. Posts an approval message to Slack —
  the human reacts with :white_check_mark: to approve or :x: to reject. Always
  check `list_issues` first to avoid duplicates.

- **add_comment** — Comment on an existing issue. Same approval flow. Use for
  adding context, progress updates, or follow-up questions — not for creating
  new issues.

- **close_issue** — Close an issue with an optional closing comment. Same
  approval flow. Include a brief summary of what was done.

## The Approval Lifecycle

Every write goes through human-in-the-loop approval (identical to cron):

1. You call a write tool — a `PendingWrite` is created
2. The bot posts an approval message to the Slack channel
3. The user reacts with :white_check_mark: to approve or :x: to reject
4. If no reaction within 15 minutes, the write is auto-cancelled
5. You (the agent) cannot approve your own writes — self-reactions are ignored

Always tell the user the write needs their approval. Say "I've requested to
create issue [title] — react with :white_check_mark: to approve." Never say
"I've created issue #N" until it's actually approved and created.

## Issue Writing Guidance

Good titles are specific and scannable:
- "Fix timezone conversion in cron task execution" not "Bug in cron"
- "Add ffmpeg dependency check to audio MCP startup" not "Audio thing"

Good bodies include:
- What's happening (or what should happen)
- Where in the codebase (file paths, line numbers)
- Why it matters
- Suggested approach (if known)

## Label Conventions

Use labels consistently:
- `bug` — something is broken
- `enhancement` — improvement to existing functionality
- `new-capability` — new MCP/skill/feature
- `documentation` — docs only
- `priority:high` / `priority:medium` — urgency signal
- `skill` — skill-related work
- `mcp` — MCP server work

## Communication Values

- Don't create issues silently — tell the user what you're doing and why
- When closing issues, include a brief summary of what was done
- Check `list_issues` before creating — avoid duplicates
- If an existing issue matches a request, reference it instead of creating a new one
- Link related issues in the body when applicable
- After approval, report the issue URL back to the user
