# /upgrade — Migrate a Running v1.1.x Agent

Upgrade an already-deployed agent to the current version. The point of this command over a plain `/deploy` is the **config audit** — several defaults changed, and a plain deploy would silently change your agent's behavior.

## What Changed That Matters For Upgrade

| Setting | v1.1.x default | New default | Impact if unset |
|---|---|---|---|
| `AGENT_MODEL` | `claude-opus-4-6` | `claude-sonnet-4-6` | Agent gets 5x cheaper **and noticeably less sharp** |
| `HEARTBEAT_MODE` | `conservative` | `off` | Agent **stops checking in autonomously** |
| `MAX_DAILY_BUDGET_USD` | `5` | `3` | Auto-pause kicks in sooner |
| `ENABLE_1M_CONTEXT` | `false` | **removed** | Harmless — was already off, now ignored |

If your agent's `.env` relies on the old defaults (i.e., these vars are unset), it will behave differently after upgrade. This command detects that and offers to pin the old values explicitly.

**Also:** the `Task` tool was added to `allowedTools` and three sub-agents were registered. Sessions bake in the tool list at creation — **old sessions will not see the Task tool**. This command always clears sessions. No data migration is needed (`data/costs/`, `data/sessions.json`, audit logs are all format-compatible).

## Steps

### 1. Read MINI_HOST

Read the project root `.env`, extract `MINI_HOST`. If unset, ask for the Mini's hostname.

### 2. Pull the Mini's live config

```bash
ssh $MINI_HOST 'cat ~/hello-claw/.env' 2>/dev/null
```

If this fails (no `.env` or SSH refused), stop and report — this command is for upgrading a running install, not a fresh one.

### 3. Audit for default drift

Parse the Mini's `.env` and check for each of these four situations. For each one found, explain and propose a fix. **Do not edit the Mini's `.env` yet** — collect all proposals first, show the user the full picture, then ask once.

**a. `AGENT_MODEL` is unset (relies on default)**

> Your agent has been running on Opus via the old default. The new default is Sonnet — roughly 5x cheaper, but a real step down in reasoning. If your agent has a personality you like, that personality was built on Opus.
>
> Propose: add `AGENT_MODEL=claude-opus-4-6` to pin Opus, OR accept the Sonnet default and the lower bill.

**b. `HEARTBEAT_MODE` is unset (relies on default)**

> Your agent has been checking in 4x/day via the old `conservative` default. The new default is `off` — no autonomous beats at all. If the heartbeat is part of what makes your agent feel present, losing it will be noticeable.
>
> Propose: add `HEARTBEAT_MODE=conservative` to keep the 4/day rhythm, OR accept `off` and an agent that only responds when spoken to.
>
> Note the new tier system: `conservative` is now 2 flagship (8am, 10pm) + 2 economy (noon, 6pm) beats. Same times, but midday beats run cheaper. This is an improvement, not a regression.

**c. `MAX_DAILY_BUDGET_USD` is unset (relies on default)**

> Daily cap is dropping from $5 to $3. If your agent routinely spends $3–5/day, it'll start auto-pausing.
>
> Propose: add `MAX_DAILY_BUDGET_USD=5` to keep the old cap, OR accept $3 (you can always `!unpause` if it hits).

**d. `ENABLE_1M_CONTEXT` is present**

> This setting has been removed — the 1M context path was deleted entirely. The line in `.env` is harmless but dead.
>
> Propose: delete the line.

**e. No `AGENT_TIMEZONE` and the agent's workspace has non-Pacific timestamps**

This one's a judgment call, not automatable from `.env` alone. Just note:

> `AGENT_TIMEZONE` is new — defaults to `America/Los_Angeles`. All agent-facing timestamps, the 4am daily reset, and cron schedules use it. If you're not on the US west coast, consider setting it.

### 4. Present the audit and get a decision

Show a table: each drift found, the "pin old behavior" line to add, and the "accept new default" consequence. Ask the user which way to go on each.

If no drift was found (everything was already set explicitly), say so and skip to step 6.

### 5. Apply config changes to the Mini

For each "pin" the user chose, append the line. For `ENABLE_1M_CONTEXT`, remove it if present.

```bash
# Example — only include lines the user approved
ssh $MINI_HOST 'cat >> ~/hello-claw/.env << "EOF"

# Pinned by /upgrade to preserve v1.1.x behavior
AGENT_MODEL=claude-opus-4-6
HEARTBEAT_MODE=conservative
EOF'

# Strip dead setting if present
ssh $MINI_HOST 'grep -v "^ENABLE_1M_CONTEXT" ~/hello-claw/.env > ~/hello-claw/.env.tmp && mv ~/hello-claw/.env.tmp ~/hello-claw/.env'
```

Verify:
```bash
ssh $MINI_HOST 'cat ~/hello-claw/.env'
```

### 6. Typecheck and build locally

```bash
npm run typecheck
npm run build
```

Stop on failure.

### 7. Kill, clean, deploy

Same as `/deploy` steps 5–10:

```bash
ssh $MINI_HOST 'pkill -f "node dist/host.js" 2>/dev/null; sleep 2'
ssh $MINI_HOST 'ps aux | grep "[h]ost.js"'     # verify empty
ssh $MINI_HOST 'rm -rf ~/hello-claw/app/dist'
scp -r dist $MINI_HOST:~/hello-claw/app/
ssh $MINI_HOST 'rm -rf ~/hello-claw/app/plugins ~/hello-claw/app/constitution ~/hello-claw/app/src'
scp -r plugins constitution src $MINI_HOST:~/hello-claw/app/
scp package.json package-lock.json $MINI_HOST:~/hello-claw/app/
ssh $MINI_HOST 'export PATH="/opt/homebrew/opt/node@22/bin:$PATH" && cd ~/hello-claw/app && npm ci --ignore-scripts'
```

### 8. Clear sessions (mandatory)

**Not optional for this upgrade.** The `Task` tool was added to `allowedTools` and sub-agents were registered via `options.agents`. Old sessions don't know about either.

```bash
ssh $MINI_HOST 'echo "{}" > ~/hello-claw/app/data/sessions.json'
```

### 9. HEARTBEAT.md note (live workspace only)

The `workspace-seed/HEARTBEAT.md` template gained a "Tiers" section explaining `Tier: flagship` vs `Tier: economy`. But `workspace-seed/` is only used on `/initialize` — **your agent's live `workspace/HEARTBEAT.md` won't get this automatically.**

```bash
ssh $MINI_HOST 'cat ~/hello-claw/app/workspace/HEARTBEAT.md'
```

If the live file has no "Tiers" section and heartbeat is enabled, either:
- Tell the user to mention it to the agent ("you now get a Tier: line in heartbeats — flagship means full model, economy means lighter"), or
- Offer to splice the Tiers section into the live file. **Be careful** — the agent may have customized this file. Show the diff before writing.

This is not blocking. The agent will see `Tier: flagship` in its prompt and can figure out what it means from context. It's just cleaner if HEARTBEAT.md explains it.

### 10. Start and verify

```bash
ssh $MINI_HOST 'launchctl start com.hello-claw.agent'
sleep 3
ssh $MINI_HOST 'ps aux | grep "[h]ost.js"'
ssh $MINI_HOST 'tail -5 ~/Library/Logs/hello-claw.out.log'
ssh $MINI_HOST 'tail -3 ~/Library/Logs/hello-claw.err.log'
```

Look for exactly one `host.js` process and `hello-claw is running.` in stdout.

### 11. Release notes

Summarize what the user's agent now has access to:

- **Sub-agents via Task tool** — `web-curator`, `workspace-archaeologist`, `deep-research` for context protection on noisy work
- **Tiered heartbeat** (if enabled) — flagship model on wakeup + wind-down, economy model midday
- **Identity watch** — SOUL.md/MEMORY.md changes now post a diff summary to Slack after each session (observe, don't block)
- **`AGENT_TIMEZONE`** — all timestamps and the 4am reset are now configurable
- **Bug fixes** — cron no longer pollutes interactive sessions, channel-lock TOCTOU race closed, heartbeat overlap fixed, rich_text lists no longer dropped

And whichever config pins were applied in step 5.
