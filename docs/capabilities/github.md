# GitHub — Issue Tracking with Approval Gate

**Status:** Implemented

Implements the GitHub issues capability stack per [Design Standards](design-standards.md). All write operations require human approval via Slack reaction, reusing the cron approval pattern.

## Capability Stack

| Layer | Location | Notes |
|---|---|---|
| Skill | `plugins/skills/github/SKILL.md` (~110 lines) | Decision tree, approval lifecycle, issue writing guidance, label conventions. |
| MCP server | `src/mcp/github.ts` (5 tools, server name `github`) | list_issues, get_issue, create_issue, add_comment, close_issue. |
| External | `gh` CLI with fine-grained PAT | Scoped to single repo, Issues-only permissions. Runs in host process. |

**Availability:** host.ts (`mcp__github__*`). Not available in cron or heartbeat (interactive sessions only).

## Tools

| Tool | Purpose | Approval | Key Parameters |
|---|---|---|---|
| `list_issues` | List issues with optional filters | No (read) | `state?`, `labels?`, `limit?` |
| `get_issue` | Full issue details with comments | No (read) | `issue_number` |
| `create_issue` | Create a new issue | **Yes** | `title`, `body`, `labels?` |
| `add_comment` | Comment on an existing issue | **Yes** | `issue_number`, `body` |
| `close_issue` | Close with optional comment | **Yes** | `issue_number`, `comment?` |

## Design Decisions

### Slack reaction approval for all writes

All write operations require human approval via Slack reaction, regardless of repo visibility. Same pattern as [Cron](cron.md): pending item → Slack message → reaction → execute or discard → 15-minute auto-expire.

### `gh` CLI instead of direct API calls

The `gh` CLI handles auth, pagination, rate limiting, and output formatting. Zero auth code — just `execFile('gh', [...args], { env: { GH_TOKEN } })`.

### Repo scoping

Repo derived from `git config --get remote.origin.url` at construction time. Tools hardcoded to one repo — agent can't pivot to other repos.

### PendingWrite stores complete ghArgs

The pending write stores the fully-built `gh` CLI args array. When approval fires, it calls `exec('gh', write.ghArgs)` — no domain logic in host.ts.

## Security Properties

- **Fine-grained PAT** with Issues-only permission on a single repo
- **Human-in-the-loop** for every write. 15-minute timeout, bot self-reaction filtering.
- **No new network exposure.** `api.github.com` NOT in `allowedDomains` — `gh` runs in host process.
- **Token isolation.** `GH_TOKEN` through SECRETS capture/strip. Passed to `gh` via `execFile` env option.

## Prerequisites

- `GH_TOKEN`: Fine-grained PAT at `github.com/settings/tokens?type=beta`. Repository: `hello-claw` only. Permission: Issues (read/write).
- `gh` CLI on Mini: `brew install gh` if not present.

## Checklist

- [x] SKILL.md in `plugins/skills/github/` (~110 lines)
- [x] Decision tree: 12 entries
- [x] Approval pattern consistent with cron
- [x] `allowedTools` in host.ts (`mcp__github__*`)
