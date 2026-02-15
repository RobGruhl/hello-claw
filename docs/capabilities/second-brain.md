# Second Brain — Task & Habit Tracking

**Status:** Implemented

Implements the second-brain capability stack per [Design Standards](design-standards.md). Cuts 11 tools to 6, renames the MCP server from `brain` to `second-brain`, and establishes a clear domain split: brain tools for tasks/habits, workspace files for memory/knowledge.

## Capability Stack

| Layer | Location | Notes |
|---|---|---|
| Skill | `plugins/skills/second-brain/SKILL.md` (99 lines) | Domain split guidance, tool reference, situational awareness, data format. |
| MCP server | `src/mcp/brain.ts` (6 tools, server name `second-brain`) | capture, recall, focus, update_status, habits, archive. |
| Data | `workspace/.second-brain/` | `captures.json`, `history.json`. |

**Availability:** host.ts, cron.ts, and heartbeat.ts (`mcp__second-brain__*`).

## Tools

| Tool | Purpose | Key Parameters |
|---|---|---|
| `capture` | Universal intake — tasks, thoughts, habits | `content`, `category`, `urgency`, `recurrence_pattern` |
| `recall` | Active captures, priority-sorted | `limit`, `context`, `status` |
| `focus` | Top N highest-priority items with scoring | `limit`, `context` |
| `update_status` | Mark complete/skip/pause, streak tracking | `id`, `status`, `quality`, `energy` |
| `habits` | Recurring tasks organized by urgency | `timeframe`, `context` |
| `archive` | Soft-delete completed/irrelevant items | `ids` or `old_completed_days` |

## Design Decisions

### Why 11 → 6: single source of truth

Removed: `subtask` (never used), `merge` (rare), `memory_get`/`memory_update` (duplicated workspace files), `summary` (agent can compute from JSON). Every remaining tool is genuinely used, and there's exactly one way to do each thing.

### Brain = tasks/habits, workspace = memory

Brain tools manage ephemeral-ish items with lifecycle (pending → completed → archived) and recurrence (habits with streaks). Workspace files store durable knowledge (preferences, patterns, context). The skill documents this so the agent doesn't reach for `capture` when it should `Write` to MEMORY.md.

### brain.ts filename stays despite server rename

Per [Design Standards](design-standards.md) hyphen exception: renaming to `second-brain.ts` would change import paths across 3 files for no functional gain. The server `name` field and tool prefix use the canonical name (`second-brain`, `mcp__second-brain__*`).

### Backwards compatibility

Existing `captures.json` may contain items from removed tools. `recall` filters out `category === 'subtask'`. `memory.json` remains on disk but is inert.

## Checklist

- [x] SKILL.md in `plugins/skills/second-brain/` (99 lines)
- [x] Situational awareness table: 9 entries
- [x] Domain split documented (brain = tasks/habits, workspace = memory)
- [x] `allowedTools` in host.ts, cron.ts, heartbeat.ts
