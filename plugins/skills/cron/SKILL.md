---
name: cron
description: >
  Scheduled and recurring task execution. Relevant when someone asks to do
  something later, on a schedule, periodically, at a specific time, or as
  a recurring reminder or automated routine.
allowed-tools: mcp__cron__*
---

# Cron — Scheduled Task Execution

Schedule one-time, interval, or cron-expression tasks that run automatically.
Every task requires human approval via Slack reaction before it activates.
Running tasks get a reduced tool set — no interactive conversation, but search
and media generation tools are available for autonomous research and content creation.

## When to Schedule vs Just Do It

This is the most important judgment call. Scheduling adds approval latency and
removes interactivity — don't use it when you can just do the thing now.

| Request pattern | Action | Why |
|---|---|---|
| "Do this now" / "Send a message" | Just execute | No delay needed |
| "What's the weather?" | Just execute | Immediate answer, no scheduling |
| Tasks needing back-and-forth | Do NOT schedule | Cron tasks can't interact with the user |
| "Research X and report back" | Schedule if future/recurring | Search + deep_research available |
| "Generate an image every morning" | Schedule (cron) | Image generation available |
| "Remind me at 3pm" | Schedule (once) | Delayed execution |
| "Do this in 10 minutes" | Schedule (once, relative) | Short delay |
| "Check X every hour" | Schedule (interval) | Recurring automation |
| "Daily standup summary at 9am" | Schedule (cron) | Recurring at specific time |

**Rule of thumb:** If the user wants something now, do it now. Only schedule when
there's a future time or recurrence involved.

## The Approval Lifecycle

Every task goes through human-in-the-loop approval:

1. You call `schedule_task` — task is created as `pending_approval`
2. The bot posts an approval message to the Slack channel
3. The user reacts with :white_check_mark: to approve or :x: to reject
4. If no reaction within 15 minutes, the task is auto-cancelled
5. You (the agent) cannot approve your own tasks — self-reactions are ignored

Cancellation of active tasks follows the same pattern: `cancel_task` posts an
approval message, and the human confirms or rejects. The task keeps running
until cancellation is confirmed. Tasks still awaiting creation approval can be
removed directly via `cancel_task` without a second approval round.

Always tell the user the task needs their approval. Say "I've requested to
schedule [task] — react with :white_check_mark: to activate it." Never say
"I've scheduled X" as if it's already running.

## Tools

All interactive tools are prefixed `mcp__cron__`.

- **schedule_task** — Create a new scheduled task. Specify `prompt` (what the
  agent does on each run), `schedule_type` (cron/interval/once), and
  `schedule_value` (expression, duration, or timestamp). Returns a pending task
  that needs human approval.

- **list_tasks** — Show all scheduled tasks in the current channel with their
  IDs, schedules, statuses, and next run times.

- **cancel_task** — Request cancellation of a task by ID. Active tasks require
  a second approval reaction. Pending-approval tasks are removed immediately.

### Scoped Tools (inside running tasks only)

- **cancel_self** — Stop this task from running again. No approval needed — the
  task cancels itself. Use when the task's goal is complete.

- **list_tasks** — Read-only view of scheduled tasks. Marks which one is "this
  task."

## Schedule Types & Timezone

| Type | Format | Timezone | Example |
|---|---|---|---|
| `cron` | 5-field expression | Always UTC | `"0 17 * * *"` (9am PT winter) |
| `interval` | Duration string | N/A | `"30m"`, `"2h"`, `"1h30m"` |
| `once` (relative) | `"in Xm"` / `"in Xh"` | N/A | `"in 15m"` |
| `once` (naive) | ISO without offset | Pacific | `"2026-03-15T09:00:00"` |
| `once` (explicit) | ISO with offset or Z | As specified | `"2026-03-15T09:00:00-07:00"` |

**Cron is UTC, not Pacific.** This is the most common mistake. To schedule
9am Pacific:
- PST (winter): `"0 17 * * *"` (9 + 8 = 17)
- PDT (summer): `"0 16 * * *"` (9 + 7 = 16)

Minimum interval: 1 minute. Maximum 10 tasks per channel.

Always communicate times to the user in Pacific. Never say "17:00 UTC" — say
"9am Pacific."

## Inside a Running Task

Running tasks have a reduced tool set. The task prompt is wrapped with context
about the schedule and a reminder to use `send_message` for communication.

**Available:**
- `mcp__slack__send_message` (scoped to the task's channel)
- `mcp__cron__cancel_self`, `mcp__cron__list_tasks` (read-only)
- `mcp__second-brain__*` (second-brain tools)
- `mcp__search__*` (Perplexity: ask, deep_research, reason, web_search)
- `mcp__media__*` (Gemini image generation)
- Standard file tools: Bash, Read, Write, Edit, Glob, Grep
- WebSearch, WebFetch

**NOT available:**
- Most Slack tools (upload, download, reactions, history, list_channels)
- `schedule_task`, `cancel_task` (can't create or cancel other tasks)

Text output from a running task goes nowhere — the agent must use
`send_message` to communicate with the user.

## Decision Tree

| User says / situation | Tool / Action | Notes |
|---|---|---|
| "Remind me at 3pm" | `schedule_task`, once, Pacific timestamp | Convert to ISO |
| "Do this in 5 minutes" | `schedule_task`, once, `"in 5m"` | Relative delay |
| "Check X every hour" | `schedule_task`, interval, `"1h"` | Explain what gets checked |
| "Daily report at 9am" | `schedule_task`, cron, `"0 17 * * *"` | UTC! Tell user "9am Pacific" |
| "Weekday mornings at 9" | `schedule_task`, cron, `"0 17 * * 1-5"` | Mon-Fri = 1-5 in cron |
| "Every 30 seconds" | Reject — explain minimum | Minimum interval is 1 minute |
| "Stop that scheduled task" | `list_tasks` then `cancel_task` | Find the ID first |
| "What's scheduled?" | `list_tasks` | Shows all tasks with status |
| "Do this now" | Just execute — don't schedule | No scheduling overhead needed |
| "Research X every day" | `schedule_task`, cron | Search + deep_research available |
| "Generate image every morning" | `schedule_task`, cron | Image generation available |
| Inside task: goal complete | `cancel_self` with reason | Stops future runs |
| Inside task: need to tell user | `send_message` | Text output goes nowhere |
| Inside task: overlapping tick | Automatic skip | Previous run still going |

## Communication Values

- Always tell the user what was scheduled and that it needs their approval
- Show human-readable times alongside any cron expression ("that's 9am Pacific
  on weekdays")
- Ask before scheduling if the recurrence is ambiguous ("did you mean every day
  or just weekdays?")
- Inside running tasks, use `send_message` — text output is discarded
- Don't over-schedule: use a one-time task for single reminders, not a recurring
  interval that immediately self-cancels
- When a cron expression involves UTC conversion, double-check your math and
  show the user the Pacific equivalent
