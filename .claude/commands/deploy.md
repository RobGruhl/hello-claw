# Deploy to Mac Mini

Hot-deploy the locally-built app to the Mac Mini. No `tsc` on the Mini — always build locally.

## Important: Mini PATH quirk

The Mini's SSH login shell only gets `/usr/bin:/bin:/usr/sbin:/sbin`. Homebrew binaries (node, npm) are NOT in the default SSH PATH because `node@22` is keg-only (not symlinked into `/opt/homebrew/bin`). Any SSH command that needs node or npm must prefix:

```bash
export PATH="/opt/homebrew/opt/node@22/bin:$PATH"
```

`run.sh` handles this for the launchd service, but raw `ssh $MINI_HOST 'npm ...'` will fail with `command not found`.

## Steps

### 1. Read MINI_HOST from .env

Read the project root `.env` file and extract the `MINI_HOST` value. If the file doesn't exist or `MINI_HOST` is not set, ask the user for the Mini's hostname (e.g., `hue.local`).

Store it as `$MINI_HOST` for all subsequent commands.

### 2. Typecheck

Run `npm run typecheck`. If it fails, stop and show the errors. Do not continue.

### 2.5. Check dependencies

Run `npm outdated` and `npm audit`. Report findings:
- If `npm audit` shows vulnerabilities, run `npm audit fix` and include the updated lockfile in the deploy.
- If `npm outdated` shows significantly outdated packages (especially `@anthropic-ai/claude-agent-sdk`), report the available versions and ask whether to update before proceeding.
- Minor patch updates to dev dependencies (`@types/node`, `tsx`, `typescript`) are safe to include automatically.

### 3. Build

Run `npm run build`. If it fails, stop and show the errors. Do not continue.

### 4. Commit and push

Run `git status` and `git diff`. If there are uncommitted changes (staged or unstaged, including untracked files in `src/`, `.claude/`, `CLAUDE.md`, `README.md`, `package.json`, `tsconfig.json`, `Makefile`):

1. Stage the relevant changed files (not node_modules, dist, .env, workspace, data)
2. Auto-generate a commit message from the diff
3. Commit and push to origin

If there are no changes, skip this step.

### 5. Kill all host.js processes on Mini

```bash
ssh $MINI_HOST 'pkill -f "node dist/host.js" 2>/dev/null; sleep 2'
```

### 6. Verify no processes remain

```bash
ssh $MINI_HOST 'ps aux | grep "[h]ost.js"'
```

If processes remain, warn the user and ask if they want to force kill.

### 7. Clean stale dist/ on Mini

Remove old compiled output before copying new files. Without this, renamed or deleted source files leave orphaned `.js` files on the Mini that can cause confusing behavior.

```bash
ssh $MINI_HOST 'rm -rf ~/hello-claw/app/dist'
```

### 8. SCP compiled dist files

Copy ALL compiled output — not node_modules, not source:

```bash
scp -r dist $MINI_HOST:~/hello-claw/app/
```

### 9. Sync plugins, constitution, and source

Skills, constitution, and source must stay in sync. **Do NOT sync `workspace-seed/`** — it is only used during `/initialize` and should not exist on the Mini after initialization.

```bash
ssh $MINI_HOST 'rm -rf ~/hello-claw/app/plugins ~/hello-claw/app/constitution ~/hello-claw/app/src'
scp -r plugins constitution src $MINI_HOST:~/hello-claw/app/
```

### 10. Sync dependencies

Copy lockfile and install production dependencies on the Mini (SDK version must match):

```bash
scp package.json package-lock.json $MINI_HOST:~/hello-claw/app/
ssh $MINI_HOST 'export PATH="/opt/homebrew/opt/node@22/bin:$PATH" && cd ~/hello-claw/app && npm ci --ignore-scripts'
```

**Skip this step** if `package.json` and `package-lock.json` haven't changed since the last deploy (check with `git diff HEAD~1 -- package.json package-lock.json`). Running `npm ci` on every deploy is wasteful when only source code changed. **Do NOT skip** if you ran `npm audit fix` or `npm update` during this deploy — the lockfile must be synced to the Mini.

### 11. Clear sessions

```bash
ssh $MINI_HOST 'echo "{}" > ~/hello-claw/app/data/sessions.json'
```

### 12. Start the service

```bash
ssh $MINI_HOST 'launchctl start com.hello-claw.agent'
```

### 13. Verify

Wait a few seconds for the process to start, then check that exactly one process is running and show recent logs:

```bash
sleep 3
ssh $MINI_HOST 'ps aux | grep "[h]ost.js"'
ssh $MINI_HOST 'tail -5 ~/Library/Logs/hello-claw.out.log'
ssh $MINI_HOST 'tail -3 ~/Library/Logs/hello-claw.err.log'
```

Look for:
- Exactly **one** `node dist/host.js` process (multiple = zombie risk, see CLAUDE.md)
- `hello-claw is running.` in stdout
- No crash traces in stderr (a few npm warnings are fine)

Report success or failure.

### 14. Release notes

Print a brief release summary to the terminal. Include:

1. The commit hash and message from the deploy commit (or "no new commit" if step 4 was skipped)
2. A short bullet list of what changed (derived from the diff — e.g., "bumped deep_research timeout to 6 min", "fixed scp nesting in deploy docs")
3. Any verification notes (e.g., "sessions cleared — agent gets fresh sessions")
