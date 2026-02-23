# Stop Cost Visualization Server

Shut down the cost visualization HTTP server on port 8765.

## Steps

### 1. Find the process

```bash
lsof -ti:8765 2>/dev/null
```

If nothing is listening, report that no server is running and stop.

### 2. Kill it

```bash
kill $(lsof -ti:8765)
```

Wait 0.5s and verify the port is free:

```bash
lsof -ti:8765 2>/dev/null || echo "Port 8765 free"
```

If still occupied, report the PID and suggest `kill -9`.

### 3. Report

Confirm the server has been stopped.
