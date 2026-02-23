# Cost Management

Guide to understanding, controlling, and monitoring the cost of running a hello-claw agent.

---

## Default Cost Profile

A fresh deployment with default settings costs approximately **$3-8/day** with light interactive use:

| Component | Default | Estimated Cost |
|-----------|---------|---------------|
| Heartbeat (8 beats/day, Opus) | Fixed schedule | ~$2-4/day |
| Interactive messages | Varies with usage | ~$0.10-0.50/message |
| Cron tasks | None by default | $0/day |
| Daily budget cap | $20/day | Auto-pauses at limit |

Costs scale with usage — heavy interactive sessions (many turns, large tool results) can consume $5-15 per session. The daily budget cap prevents runaway spending.

---

## Configuration Options

| Setting | Env Var / File | Default | Description | Cost Impact |
|---------|---------------|---------|-------------|-------------|
| Daily budget | `MAX_DAILY_BUDGET_USD` in `config.ts` | $20 | Auto-pauses agent when exceeded | Hard ceiling on daily spend |
| Per-session budget | `MAX_BUDGET_USD` in `config.ts` | $50 | SDK `maxBudgetUsd` per `query()` call | Limits individual runaway sessions |
| Agent model | `AGENT_MODEL` in `config.ts` | `claude-opus-4-6` | Model for all query() calls | Opus is 5x more expensive than Haiku |
| Heartbeat schedule | `HEARTBEAT_SCHEDULE` in `heartbeat.ts` | 8 beats/day | Fixed Pacific Time schedule | Each beat costs approximately $0.20-0.50 |
| Long-context beta | `BETAS` in `config.ts` | Disabled (empty) | Enables 1M token context window | Triggers 2x pricing above 200K tokens |
| ToolSearch | `ENABLE_TOOL_SEARCH` in env | `true` | Defers tool schema loading | Reduces tool schema tokens by approximately 85% |
| Effort level | Set in `query()` options | `max` | Controls thinking depth | Higher effort = more output tokens + context growth |
| API proxy | `API_LOG_PROXY` in env | Disabled | Intercepts API traffic for logging | Enables cache stabilization (saves money) |

---

## Budget Enforcement

The budget system has two layers:

### Per-Session Cap (`MAX_BUDGET_USD`)

The SDK's `maxBudgetUsd` option limits each `query()` call. If a single interactive message, heartbeat, or cron task exceeds this, the SDK stops the session. Default: $50.

### Daily Cap (`MAX_DAILY_BUDGET_USD`)

`cost-tracker.ts` accumulates costs from every `query()` result across all sources (interactive, heartbeat, cron). The cost day boundary is **4:00 AM Pacific Time** — costs reset at that point.

**Flow:**

1. Every `query()` result reports `total_cost_usd`
2. `recordCost()` adds it to `data/costs/daily.json`
3. After each interactive message, a cost summary is posted to Slack: `$0.42 (3 turns) | today: $12.38`
4. At 50% of daily budget, a warning is posted
5. At 100% of daily budget, `setPaused(true)` is called and an auto-pause message is posted
6. The agent stops responding to messages, heartbeats, and cron tasks
7. User sends `!unpause` to resume (shows current daily total)

**Persistence:** Pause state is saved to `data/pause-state.json` and survives process restarts.

---

## Heartbeat Cost

Heartbeats are ephemeral sessions — each beat starts fresh with no conversation history. The cost per beat depends on the system prompt size, tool count, and model.

### Estimated Cost Per Beat

| Model | Estimated Input Tokens | Estimated Cost/Beat |
|-------|----------------------|-------------------|
| Opus 4.6 | ~30-45K | ~$0.20-0.50 |
| Sonnet 4.6 | ~30-45K | ~$0.12-0.30 |
| Haiku 4.5 | ~30-45K | ~$0.04-0.10 |

### Daily Heartbeat Cost (8 beats/day)

| Model | Estimated Daily Cost |
|-------|---------------------|
| Opus 4.6 | ~$1.60-4.00 |
| Sonnet 4.6 | ~$0.96-2.40 |
| Haiku 4.5 | ~$0.32-0.80 |

The default configuration uses Opus for heartbeats. Switching to a lighter model for heartbeats is a significant cost reduction. The fixed 8-beat schedule (reduced from the original 32 beats/day at 30-min intervals) already represents a 75% reduction.

**Schedule (Pacific Time):** 7:00, 10:00, 13:00, 16:00, 19:00, 22:00, 22:30, 23:00

---

## Cache Stabilization

The API proxy (`src/lib/api-proxy.ts`) intercepts SDK-to-Anthropic traffic and applies two cache stabilization techniques:

### UUID Replacement

The SDK embeds a random `crypto.randomUUID()` in Bash tool descriptions (sandbox path). A new UUID per `query()` call breaks the prefix cache — the first approximately 17K tokens of system prompt + tool schemas must be re-written to cache on every call.

The proxy replaces random UUIDs with a deterministic UUID derived from `SHA-256("bash-uuid-" + sessionId)`. Same session = same UUID = cache hit. This saves approximately $0.10-0.20 per cache write that would otherwise be a miss.

### WebFetch Auth Warning Stripping

The WebFetch tool description conditionally includes an auth warning paragraph that flickers on/off between calls. The proxy strips this to keep the tool description stable.

### Impact

Without stabilization, the system prompt + tools prefix changes on every API call, forcing a full cache write (approximately $0.10-0.25 at Opus rates). With stabilization, the prefix stays identical across calls within a session, allowing cache reads at 10x lower cost.

---

## Monitoring

### Real-Time (Slack)

After every interactive response, the agent posts a cost summary:

```
$0.42 (3 turns) | today: $12.38
```

Heartbeats post their own cost summaries with a heartbeat emoji.

### Cost Data Files

| File | Format | Contents |
|------|--------|----------|
| `data/costs/daily.json` | JSON | Current day's accumulated cost, entry count |
| `data/costs/costs.jsonl` | JSONL | Append-only log of every query() cost (timestamp, source, channel, cost, turns, tokens) |

### Cost Visualization (cost-viz)

The API proxy logs full request/response metadata to `data/api-logs/` as hourly JSONL files (24-hour retention). The `tools/cost-viz/` tooling extracts, analyzes, and visualizes these logs:

```bash
make cost-viz         # Rsync logs from host, extract, report
/start-viz            # Serve + open browser
/stop-viz             # Kill the server
```

Features:
- Per-session stacked bar charts showing 8 input categories + output
- Tokens vs. USD toggle
- Cache mutation detection — shows exactly what string change broke the prefix cache
- Click any bar for detailed actual/estimated breakdown
- Subagent call detection

See `tools/cost-viz/README.md` for data format details and the full feature list.

---

## Cost Optimization Tips

### High Impact

1. **Stay under 200K tokens.** The long-context surcharge doubles all input pricing when total input exceeds 200K tokens. The default configuration disables the 1M context beta, so autocompact triggers at approximately 167K tokens — safely below the threshold.

2. **Use session lifecycle controls.** Daily reset (4am PT) prevents unbounded context growth. Idle compaction (>2h) triggers autocompact on the next message. Manual `!clear` and `!compact` commands give direct control.

3. **Enable the API proxy for cache stabilization.** Set `API_LOG_PROXY=1` in `.env` to activate UUID replacement and WebFetch flicker stripping.

### Medium Impact

4. **Consider model routing for heartbeats.** Heartbeats rarely need Opus-level reasoning. Using a lighter model for heartbeats can reduce daily baseline cost by 60-80%.

5. **Keep sessions short.** Long sessions accumulate thinking blocks, tool results, and conversation history that compound in cost. Each turn re-reads the entire context. A session that grows from 30K to 150K tokens over 10 turns costs approximately 900K total input tokens, not 150K.

6. **Use ToolSearch.** Enabled by default (`ENABLE_TOOL_SEARCH=true`). Reduces tool schema tokens from approximately 10K+ to approximately 1.5K by deferring tool loading.

### Lower Impact

7. **Minimize large tool results early in sessions.** A 50K-char firecrawl result added at turn 3 of a 10-turn session is re-read 7 more times — effectively costing 350K input tokens instead of 50K.

8. **Use subagents for browsing.** The browse skill encourages delegating multi-page reading to cheaper subagents via the Task tool.

9. **Monitor cache hit rate.** Healthy sessions should have >85% cache hit rate. Low rates indicate prefix instability (check for system prompt changes between calls) or >5 minute gaps between messages (cache TTL expiration).
