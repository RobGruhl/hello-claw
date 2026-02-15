# Initialize New Agent on Mac Mini

Perform a fresh agent initialization on the Mac Mini. This seeds the workspace from `workspace-seed/` and copies the constitution. **This is a destructive first-run operation — it will NOT proceed if an agent already exists on the target machine.**

## Prerequisites

- The Mini must already be bootstrapped (`setup.sh` has been run, launchd service is registered, node/npm are installed)
- The app code must already be deployed (use `/deploy` first)
- `workspace-seed/` and `constitution/` must exist locally in the repo

## Steps

### 1. Read MINI_HOST from .env

Read the project root `.env` file and extract the `MINI_HOST` value. If the file doesn't exist or `MINI_HOST` is not set, ask the user for the Mini's hostname (e.g., `hue.local`).

### 2. Check for existing agent (CRITICAL — do not skip)

Check whether an agent workspace already exists on the Mini:

```bash
ssh $MINI_HOST 'ls ~/hello-claw/app/workspace/CLAUDE.md 2>/dev/null && echo "AGENT_EXISTS" || echo "NO_AGENT"'
```

**If `AGENT_EXISTS`:** STOP immediately. Print:

```
An agent workspace already exists on $MINI_HOST.

Initialization would overwrite the existing agent's identity, memory, and history.
This is not supported in v1 — there is one deployment namespace per machine.

If you truly want to start fresh:
1. Back up the existing workspace: ssh $MINI_HOST 'tar czf ~/agent-backup-$(date +%Y%m%d).tar.gz -C ~/hello-claw/app workspace'
2. Manually remove it: ssh $MINI_HOST 'rm -rf ~/hello-claw/app/workspace'
3. Run /initialize again
```

Do NOT offer to do this automatically. Do NOT continue. The user must perform the manual deletion themselves.

**If `NO_AGENT`:** Continue to step 3.

### 3. Verify seed and constitution exist locally

```bash
ls workspace-seed/CLAUDE.md workspace-seed/SOUL.md
ls constitution/
```

If either is missing, stop and tell the user what's missing.

### 4. Copy workspace seed to Mini

```bash
scp -r workspace-seed $MINI_HOST:~/hello-claw/app/
```

This places the seed templates on the Mini. On next startup, `workspace.ts` will copy them into `workspace/` (only files that don't already exist).

### 5. Copy constitution to Mini

```bash
scp -r constitution $MINI_HOST:~/hello-claw/app/
```

### 6. Trigger workspace initialization

Restart the service so `ensureWorkspace()` runs and populates `workspace/` from the seed:

```bash
ssh $MINI_HOST 'launchctl stop com.hello-claw.agent; sleep 1; launchctl start com.hello-claw.agent'
```

### 7. Verify

Wait for the service to start, then confirm the workspace was created:

```bash
sleep 3
ssh $MINI_HOST 'ls ~/hello-claw/app/workspace/CLAUDE.md ~/hello-claw/app/workspace/SOUL.md ~/hello-claw/app/workspace/MEMORY.md 2>/dev/null && echo "WORKSPACE_OK" || echo "WORKSPACE_MISSING"'
ssh $MINI_HOST 'ps aux | grep "[h]ost.js"'
ssh $MINI_HOST 'tail -5 ~/Library/Logs/hello-claw.out.log'
```

Report:
- Whether the workspace files were created
- Whether the service is running (exactly one process)
- Any errors in the logs

### 8. Clean up seed from Mini

The seed's job is done — remove it from the Mini so it doesn't accumulate stale data:

```bash
ssh $MINI_HOST 'rm -rf ~/hello-claw/app/workspace-seed'
```

The seed stays in the laptop repo as the canonical template. It only needs to exist on the Mini transiently during initialization.

### 9. Summary

Print what was initialized:
- Which seed files were copied
- The agent's starting identity files (CLAUDE.md, SOUL.md)
- Reminder: the agent will develop its own identity from these starting points
- Reminder: use `/deploy` for subsequent code updates (workspace is never overwritten by deploys)
