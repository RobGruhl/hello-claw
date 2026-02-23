# Start Cost Visualization Server

Serve the API cost visualization locally and open it in the browser.

## Steps

### 1. Check port availability

Check if port 8765 is already in use:

```bash
lsof -ti:8765 2>/dev/null
```

If a process is listening:
- Check if it's already our `http.server` serving `tools/cost-viz/` (look at the command). If so, just open the browser and report it's already running.
- If it's something else, report what's using the port and ask the user before killing it.

### 2. Verify data exists

Check that `tools/cost-viz/data/sessions.json` exists and is non-empty. If missing:

1. Check if raw JSONL files exist in `tools/cost-viz/data/raw/`
2. If raw files exist, run extraction: `bun tools/cost-viz/extract.ts tools/cost-viz/data/raw/ > tools/cost-viz/data/sessions.json`
3. If no raw files either, rsync from Mini: `rsync -avz $MINI_HOST:~/hello-claw/app/data/api-logs/ tools/cost-viz/data/raw/` then extract
4. If rsync finds no files, report that API logging data has been cleaned up (24h retention) and stop

### 3. Start server

```bash
python3 -m http.server 8765 -d tools/cost-viz &
```

Wait 0.5s, then verify it's responding:

```bash
curl -s -o /dev/null -w "%{http_code}" http://localhost:8765/
```

If not 200, report the error.

### 4. Open browser

```bash
open http://localhost:8765/
```

### 5. Report

Tell the user the server is running and remind them to use `/stop-viz` when done.
