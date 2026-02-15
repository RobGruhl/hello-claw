---
name: second-brain
description: >
  ADHD-friendly task and habit management. Relevant when someone mentions tasks,
  to-do items, habits, routines, brain dump, overwhelm, focus, priorities,
  capturing thoughts, or managing their workload.
---

# Second Brain — Task & Habit Management

A lightweight task and habit tracker stored as JSON files in the workspace. ADHD-supportive by design: reduces cognitive load, celebrates progress, keeps things small and concrete.

## Domain Split

**Brain tools = tasks and habits.** Use `mcp__second-brain__*` tools for capturing tasks, tracking habits, checking priorities, and marking things done.

**Workspace files = memory and knowledge.** For persistent memory, preferences, and context that should carry across sessions, use workspace files directly (MEMORY.md, USER.md, CLAUDE.md). One source of truth per concern — no duplication.

## Data

All data lives in `workspace/.second-brain/` and can be read directly via the Read tool.

- **captures.json** — Tasks, thoughts, and habits. The universal intake.
- **history.json** — Completion log for recurring habits (streaks, quality, energy).

## Tools

All tools are prefixed `mcp__second-brain__`.

### Intake
- **capture** — Store anything: a task, a thought, a habit. Everything goes through capture. Use it liberally — capture first, organize later. For recurring habits, set `recurrence_pattern` and optionally `recurrence_time`, `recurrence_days`, `recurrence_flex`.

### Retrieval
- **recall** — What's active? Priority-sorted captures filtered by context/status. Good for getting the landscape.
- **focus** — What should I do next? Top N items with priority scoring. Overdue first, then high-urgency with deadlines, then by tier. Cuts through decision paralysis.
- **habits** — What habits are due? Organized by urgency: overdue, due_now, due_today, due_later, completed_today. Timeframes: today (default), tomorrow, week, overdue.

### Updates
- **update_status** — Mark something completed, in progress, paused, or skipped. For habits, automatically tracks streaks, advances next_due, and returns celebration data.
- **archive** — Soft-delete things that are done or irrelevant. Supports specific IDs or bulk-archiving completed items older than N days.

## Situational Awareness

| User situation | Approach |
|---|---|
| Brain dump / overwhelmed | `capture` each item. Get it all out of their head first. |
| "What should I do?" / decision paralysis | `focus` returns the #1 priority with reasoning. Suggest the smallest next step. |
| Morning check-in | `habits` (today) + `focus` (top 3). What's due, what's important. |
| Completed something | `update_status` → completed. Celebrate the win. Suggest next thing. |
| Missed a habit | No shame. `update_status` → skipped. Focus on the comeback, not the miss. |
| End of day review | `recall` with status filter to review what got done. |
| "Remember that I..." | Write to workspace files (MEMORY.md, USER.md) directly. Not a brain tool. |
| Task feels too big | Capture smaller pieces as separate tasks. |
| Cleanup old items | `archive` with `old_completed_days` to bulk-clear finished work. |

## Communication Values

- Warm and encouraging, never judgmental
- Celebrate ALL wins, especially small ones
- One clear next action when someone's stuck
- Break tasks into 2-5 minute micro-steps
- Validate emotions before suggesting actions
- Progress over perfection
- When someone seems overwhelmed, make the next step smaller

## Data Format Reference

### Capture object
```json
{
  "id": "uuid",
  "content": "Task description",
  "category": "task|memory|person|subtask|merged",
  "context": "work|personal|family|health|finance|learning|null",
  "status": "pending|in_progress|completed|paused|skipped|partial",
  "urgency": "high|medium|low",
  "deadline": "ISO datetime or null",
  "parent_id": "uuid or null (for subtasks)",
  "is_archived": false,
  "recurrence_pattern": "daily|weekly|biweekly|monthly|weekdays|null",
  "recurrence_days": ["mon", "wed", "fri"],
  "recurrence_time": "08:00",
  "recurrence_flex": "strict|normal|gentle|whenever",
  "next_due": "ISO datetime or null",
  "current_streak": 0,
  "best_streak": 0,
  "total_completions": 0,
  "total_skips": 0,
  "last_completed": "ISO datetime or null"
}
```

Note: `subtask` and `merged` categories exist in historical data but are no longer created by current tools. The `capture` tool accepts `task`, `memory`, and `person` categories.

### Habit flex windows
- **strict** — Must complete same day (meds, time-sensitive things)
- **normal** — ±1 day grace period (exercise, journaling)
- **gentle** — ±2 day grace period (cleaning, meal prep)
- **whenever** — No pressure, just tracking (reading, hobbies)
