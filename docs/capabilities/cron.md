# Cron — Scheduled Task Execution

**Status:** Implemented (`c34608a`)

Implements the cron capability stack per [Design Standards](design-standards.md).

## Capability Stack

| Layer | Location | Notes |
|---|---|---|
| Skill | `plugins/skills/cron/SKILL.md` (148 lines) | Schedule-vs-execute decision, approval lifecycle, timezone rules, scoped tool availability. |
| Lib code | Inline in `src/mcp/cron.ts` | `parseDuration`, `formatPacificTime`, `parseOnceSchedule`. Deferred extraction — single consumer. |
| MCP server | `src/mcp/cron.ts` (888 lines, 3 interactive + 2 scoped tools) | Two MCP server factories: full (interactive) and scoped (inside running tasks). |
| External | Claude Agent SDK `query()` | Recursive — scheduled tasks call `query()` to run the agent with the task prompt. |

**Availability:** host.ts (`mcp__cron__*`). Not available in heartbeat (intentional). Inside running tasks: scoped to `cancel_self` + read-only `list_tasks` only.

## Tools

### Interactive (during normal conversation)

| Tool | Purpose | Key Parameters |
|---|---|---|
| `schedule_task` | Create a scheduled task (pending approval) | `prompt`, `schedule_type` (cron/interval/once), `schedule_value` |
| `list_tasks` | List all tasks with status, schedule, next run | — |
| `cancel_task` | Request cancellation (approval required for active tasks) | `task_id` |

### Scoped (inside running tasks)

| Tool | Purpose |
|---|---|
| `cancel_self` | Stop this task immediately, no approval needed |
| `list_tasks` | Read-only task list, marks "this task" |

Running tasks also get a scoped Slack MCP with only `send_message` (mrkdwn-aware).

### Schedule Types & Timezone

| Type | Format | Timezone | Example |
|---|---|---|---|
| `cron` | 5-field expression | Always UTC | `"0 17 * * *"` (9am PT winter) |
| `interval` | Duration string | N/A | `"30m"`, `"2h"`, `"1h30m"` |
| `once` (relative) | `"in Xm"` / `"in Xh"` | N/A | `"in 15m"` |
| `once` (naive ISO) | ISO without offset | Pacific | `"2026-03-15T09:00:00"` |
| `once` (explicit) | ISO with offset or Z | As specified | `"2026-03-15T09:00:00-07:00"` |

## Design Decisions

### Skill's highest value is the schedule-vs-execute meta-decision

The agent's most common cron mistake isn't syntax — it's scheduling things it should just do immediately. The skill leads with a "When to Schedule vs Just Do It" table that frontloads this judgment call. Tool descriptions are kept brief (3 lines, pointing to the skill for format details).

### Two MCP server factories for scope isolation

`createCronMcp()` builds the full interactive MCP (3 tools). `createCronMcpForTask()` builds the scoped MCP for running tasks (2 tools). This prevents running tasks from scheduling new tasks or cancelling others.

### Approval lifecycle is a trust mechanism

Every scheduled task requires human approval via Slack reaction. No `--force` or admin override. 15-minute timeout. Self-reactions filtered. Cancellation of active tasks requires a second approval round. Same pattern as [GitHub](github.md) writes.

## Security Properties

- Same hooks and integrity checks as interactive messages
- Per-channel lock prevents session collisions between cron and interactive
- Sandbox applies to all Bash commands inside running tasks
- Scoped Slack MCP only exposes `send_message`
- Max 10 tasks per channel, minimum 1-minute interval, overlapping tick skip

## Checklist

- [x] SKILL.md in `plugins/skills/cron/` (148 lines)
- [x] Decision tree: 12 entries
- [x] Tool descriptions: brief (3 lines), defer to skill
- [x] `allowedTools` in host.ts (`mcp__cron__*`)
