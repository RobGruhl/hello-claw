# Cost Management

Understanding, controlling, and monitoring the cost of running a hello-claw agent.

---

## Default Cost Profile

A fresh checkout with default settings (Sonnet, heartbeat off, $3/day cap) costs approximately nothing while idle and $0.10–$1.50 per interactive message depending on session length.

| Component | Default Setting | Default Cost |
|---|---|---|
| Heartbeat | `HEARTBEAT_MODE=off` | $0/day |
| Interactive | Sonnet, `effort: high` | ~$0.10–1.50/message |
| Cron tasks | None scheduled | $0/day |
| Daily cap | $3 | Auto-pauses when exceeded |

If you turn the heartbeat on and switch to Opus — which is the configuration the project was built around — you're looking at $5–15/day with light interactive use. The daily cap exists for a reason.

---

## Configuration

All settings are env-driven. Set them in `.env` (dev) or `~/hello-claw/.env` (Mini).

| Setting | Env Var | Default | Cost Impact |
|---|---|---|---|
| Daily budget | `MAX_DAILY_BUDGET_USD` | `3` | Hard ceiling — auto-pauses when hit |
| Per-session budget | `MAX_SESSION_BUDGET_USD` | `50` | SDK kills a single runaway `query()` |
| Primary model | `AGENT_MODEL` | `claude-sonnet-4-6` | Opus is roughly 5x Sonnet per token |
| Effort level | `AGENT_EFFORT` | `high` | Higher effort → more thinking tokens + context growth |
| Cron model | `CRON_MODEL` | same as `AGENT_MODEL` | Independent dial for scheduled tasks |
| Heartbeat schedule | `HEARTBEAT_MODE` | `off` | See heartbeat section |
| Agent timezone | `AGENT_TIMEZONE` | `America/Los_Angeles` | Affects when the 4am cost-day rolls over |

---

## Budget Enforcement

Two layers.

### Per-Session Cap (`MAX_SESSION_BUDGET_USD`)

Passed to the SDK as `maxBudgetUsd` on every `query()` call. If a single interactive message, heartbeat, or cron task burns through this, the SDK halts the session. Default $50 is a safety net, not a daily control — most sessions use under $2.

### Daily Cap (`MAX_DAILY_BUDGET_USD`)

`cost-tracker.ts` accumulates `total_cost_usd` from every `query()` result across all sources (interactive, heartbeat, cron). The cost day rolls over at **4am in `AGENT_TIMEZONE`** — the same boundary that resets sessions.

1. Every `query()` result reports `total_cost_usd`
2. `recordCost()` adds it to `data/costs/daily.json`
3. After each interactive message, a summary is posted to Slack: `$0.42 (3 turns) | today: $1.38`
4. At 50% of budget, a warning is posted
5. At 100%, `setPaused(true)` is called and an auto-pause message is posted
6. Agent stops responding to messages, heartbeats, and cron
7. User sends `!unpause` to resume (shows current daily total)

Pause state lives in `data/pause-state.json` and survives restarts.

---

## Heartbeat Cost

Heartbeats are ephemeral — each beat starts a fresh session with no conversation history. Default is `off`. When you turn it on, beats are **tiered**.

### Tiers

| Tier | When | Model | Effort | Turn Cap |
|---|---|---|---|---|
| `flagship` | Wakeup beat + wind-down beats | `AGENT_MODEL` | `AGENT_EFFORT` | 50 |
| `economy` | Midday beats | `claude-sonnet-4-6` | `medium` | 15 |

The reasoning: the wakeup beat is the agent's first look at the day — worth the good model. The wind-down beats are when it reflects on what happened and consolidates memory — also worth it. The midday beats are mostly "anything urgent? no? ok" — Sonnet at medium effort with a 15-turn leash is plenty for that.

### Schedules

| Mode | Beats | Tier Layout (in `AGENT_TIMEZONE`) |
|---|---|---|
| `off` | 0/day | — |
| `conservative` | 4/day | 8:00 flagship · 12:00 economy · 18:00 economy · 22:00 flagship |
| `standard` | 8/day | 7:00 flagship · 10/13/16/19:00 economy · 22/22:30/23:00 flagship (wind-down trilogy) |

### Estimated Daily Heartbeat Cost

Rough numbers — actuals depend on system prompt size, tool count, what the agent decides to do.

| Mode | With `AGENT_MODEL=sonnet` | With `AGENT_MODEL=opus` |
|---|---|---|
| `conservative` (2 flagship + 2 economy) | ~$0.50–1.50/day | ~$1.00–2.50/day |
| `standard` (4 flagship + 4 economy) | ~$1.00–3.00/day | ~$2.00–5.00/day |

With `AGENT_MODEL=sonnet`, flagship and economy tiers are the same model — the difference is effort and turn cap, which still saves on output tokens.

---

## Sub-Agents and Context Protection

Three curator sub-agents (`web-curator`, `workspace-archaeologist`, `deep-research`) are registered on every `query()` call via `options.agents`. They run on Sonnet in isolated contexts.

The cost argument: a 50K-char `deep_research` result pulled into the main session at turn 3 of a 10-turn conversation gets re-read 7 more times — effectively 350K input tokens, not 50K. Delegate the call to the `deep-research` sub-agent, it absorbs the 50K in its own context, returns the curated 5K, and only that 5K compounds across subsequent turns.

Sub-agents aren't free — spawning one is a Sonnet round-trip. But for genuinely large raw material (web pages, research dumps, wide grep sweeps), the isolation math works out well. See `plugins/skills/delegation/SKILL.md` for the agent-facing guidance on when to delegate vs. call directly.

---

## Monitoring

### Real-Time (Slack)

After every interactive response:
```
$0.42 (3 turns) | today: $1.38
```

Heartbeats post their own summaries with a heartbeat emoji.

### Data Files

| File | Format | Contents |
|---|---|---|
| `data/costs/daily.json` | JSON | Current agent-day's accumulated cost, entry count |
| `data/costs/costs.jsonl` | JSONL | Append-only log of every `query()` cost (timestamp, source, channel, cost, turns, tokens) |

### cost-viz

The API proxy (when enabled via `API_LOG_PROXY`) logs full request/response metadata to `data/api-logs/` as hourly JSONL files. The `tools/cost-viz/` tool extracts and visualizes these:

```bash
make cost-viz         # rsync logs from host, extract, report
/start-viz            # serve + open browser
/stop-viz             # kill the server
```

Per-session stacked bar charts, tokens-vs-USD toggle, cache mutation detection (shows what string change broke the prefix cache), subagent call detection. See `tools/cost-viz/README.md` for details.

---

## Optimization

### High Impact

1. **Keep sessions short.** Each turn re-reads the entire context. A session that grows from 30K to 150K tokens over 10 turns costs ~900K total input tokens, not 150K. Use `!clear` between unrelated conversations. The 4am daily reset forces a clean slate once a day.

2. **Delegate noisy work.** A single firecrawl scrape that returns 80K chars compounds across every subsequent turn. The `web-curator` sub-agent absorbs it in an isolated Sonnet context and returns the 5K that matters. Same for `deep_research` and wide workspace greps.

3. **Tier your heartbeat.** The default tier split already routes the cheap model to midday beats. If `AGENT_MODEL=opus`, that's a real saving. If you need heartbeats but not the wind-down trilogy, `conservative` has half the flagship beats of `standard`.

### Medium Impact

4. **`CRON_MODEL`.** Scheduled tasks often don't need the same model as interactive. A cron job that pulls a daily summary doesn't need Opus.

5. **`AGENT_EFFORT`.** Dropping from `max` to `high` (the default) cuts thinking output substantially with a small quality cost for most tasks. `medium` is fine for routine work.

6. **Monitor cache hit rate.** Healthy sessions show >85% cache-read. Low rates mean prefix instability (check cost-viz for what's mutating) or >5 minute gaps between messages (cache TTL).

### Low Impact

7. **Position large results late.** A 50K tool result at turn 8 of a 10-turn session is re-read twice. The same result at turn 2 is re-read eight times.
