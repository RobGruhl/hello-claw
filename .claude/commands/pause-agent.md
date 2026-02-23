# Pause Agent on Mac Mini

Safely stop the agent and prevent launchd from auto-restarting it. Use this when you need the agent fully parked — no heartbeats, no cron, no message handling.

## Important: Mini PATH quirk

The Mini's SSH login shell only gets `/usr/bin:/bin:/usr/sbin:/sbin`. Homebrew binaries (node, npm) are NOT in the default SSH PATH because `node@22` is keg-only. Any SSH command that needs node must prefix:

```bash
export PATH="/opt/homebrew/opt/node@22/bin:$PATH"
```

## Steps

### 1. Read MINI_HOST from .env

Read the project root `.env` file and extract the `MINI_HOST` value. If the file doesn't exist or `MINI_HOST` is not set, ask the user for the Mini's hostname (e.g., `your-mini.local`).

Store it as `$MINI_HOST` for all subsequent commands.

### 2. Pre-flight: confirm current state

Before touching anything, capture the current state so we know what we're working with:

```bash
ssh $MINI_HOST 'ps aux | grep "[h]ost.js"'
ssh $MINI_HOST 'launchctl list | grep hello-claw'
```

Report:
- How many `host.js` processes are running (0, 1, or multiple)
- Whether the launchd job is loaded (present in `launchctl list`)
- If nothing is running and nothing is loaded, say so and confirm with the user whether to proceed (there may be nothing to pause)

### 3. Kill all host.js processes

Kill everything matching, not just the launchd-managed process. Zombie processes from manual launches or pre-SIGTERM-trap eras can hold the Slack socket.

```bash
ssh $MINI_HOST 'pkill -f "node dist/host.js" 2>/dev/null; sleep 2'
```

### 4. Verify no processes remain

```bash
ssh $MINI_HOST 'ps aux | grep "[h]ost.js"'
```

If processes remain, warn the user and offer to `kill -9` the specific PIDs. Do not proceed until all processes are confirmed dead.

### 5. Unload the launchd job

**This is the critical step.** `launchctl stop` only stops the current process — launchd will restart it on the next trigger. `launchctl unload` removes the job definition entirely so launchd cannot restart it.

```bash
ssh $MINI_HOST 'launchctl unload ~/Library/LaunchAgents/com.hello-claw.agent.plist 2>&1'
```

### 6. Verify launchd job is unloaded

```bash
ssh $MINI_HOST 'launchctl list | grep hello-claw'
```

This should return **nothing**. If the job still appears, report the error and stop.

### 7. Final verification

Confirm the full picture — no processes, no launchd job, no way for it to come back:

```bash
ssh $MINI_HOST 'ps aux | grep "[h]ost.js"'
ssh $MINI_HOST 'launchctl list | grep hello-claw'
ssh $MINI_HOST 'tail -3 ~/Library/Logs/hello-claw.out.log'
```

Report:
- **Processes:** none running
- **launchd:** job unloaded (will not auto-restart)
- **Last log line:** show it so we know the shutdown was clean

### 8. Summary

Print a clear status box:

```
Agent is PAUSED.
- All host.js processes killed
- launchd job unloaded (will NOT auto-restart on crash or reboot)
- To resume: ssh $MINI_HOST 'launchctl load ~/Library/LaunchAgents/com.hello-claw.agent.plist'
- Or just run /deploy which will re-register and start the service
```
