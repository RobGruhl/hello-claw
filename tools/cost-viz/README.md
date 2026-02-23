# API Cost Visualization

Stacked column chart showing per-call token breakdown and costs from API proxy logs.

## Quick Start

```bash
make cost-viz          # rsync logs from Mini, extract, report
/start-viz             # serve + open browser (Claude Code slash command)
/stop-viz              # kill the server
```

Or manually:

```bash
# 1. Get logs
mkdir -p tools/cost-viz/data/raw
rsync -avz $MINI_HOST:~/hello-claw/app/data/api-logs/ tools/cost-viz/data/raw/

# 2. Extract
bun tools/cost-viz/extract.ts tools/cost-viz/data/raw/ > tools/cost-viz/data/sessions.json

# 3. Serve (index.html needs fetch(), can't use file://)
python3 -m http.server 8765 -d tools/cost-viz
open http://localhost:8765/
```

## Features

- **Session dropdown** — pick any session, see call count and total cost
- **Tokens / Cost toggle** — switch Y-axis between raw tokens and USD
- **Stacked bars** — 8 input categories + output, all in one column per call
- **Stripe pattern** — diagonal stripes = cached tokens (prefix cache hit)
- **Cache mutation detection** — red diamond markers above bars where the prefix changed between consecutive calls; tooltip and detail panel show exactly what string changed (e.g., UUID in a temp file path, SDK block added/removed)
- **Click detail** — click any bar for actual API token breakdown, cost, cache hit %, and cache mutation diffs with red/green colorized context
- **Data quality notice** — clearly labels what's actual vs estimated

## What's Actual vs Estimated

| Data | Source | Status |
|------|--------|--------|
| `input_tokens`, `cache_*_input_tokens`, `output_tokens` | API SSE response | **ACTUAL** |
| Cost per call | Computed from actual tokens × Opus pricing | **ACTUAL** |
| Long-context flag (>200K = 2× pricing) | Computed from actual token totals | **ACTUAL** |
| Per-category token breakdown | `request_body` char counts ÷ 4 | **ESTIMATED** |
| Which categories are cached vs uncached | Prefix-waterfall heuristic | **ESTIMATED** |
| Output token split (thinking vs response) | Not available (proxy doesn't log response body) | **MISSING** |

## Input Log Format

The extract script reads JSONL files produced by the API proxy (`src/lib/api-proxy.ts`). Each line is a JSON object representing one API call. Drop any conforming `.jsonl` files into `tools/cost-viz/data/raw/` and re-run extraction.

### Required Fields

These must be present and non-null for the visualizer to compute costs:

```json
{
  "input_tokens": 3,
  "cache_creation_input_tokens": 32449,
  "cache_read_input_tokens": 0,
  "output_tokens": 185
}
```

All four come from the Anthropic API's SSE response stream:
- `input_tokens` — `message_start` event → `message.usage.input_tokens`
- `cache_creation_input_tokens` — `message_start` event → `message.usage.cache_creation_input_tokens`
- `cache_read_input_tokens` — `message_start` event → `message.usage.cache_read_input_tokens`
- `output_tokens` — `message_delta` event → `usage.output_tokens`

If any are `null`, the call will show 0 cost and an empty bar. See `src/lib/api-proxy.ts:76-98` (`extractUsageFromSSE`) for a working implementation.

### Required Fields for Category Classification

These are used to break down each call into content categories:

```json
{
  "ts": "2026-02-17T07:00:08.701Z",
  "session_id": "c726b7b8",
  "call_num": 1,
  "message_count": 1,
  "tool_count": 37,
  "tool_names": ["Task", "Bash", "Read", "..."],
  "duration_ms": 4668,
  "request_body": { ... }
}
```

### `request_body` Structure

The full API request body as sent to `POST /v1/messages`. The extract script parses these keys:

```json
{
  "model": "claude-opus-4-6",
  "system": [
    { "type": "text", "text": "..." }
  ],
  "tools": [
    { "name": "Bash", "description": "...", "input_schema": { ... } }
  ],
  "messages": [
    {
      "role": "user",
      "content": [
        { "type": "text", "text": "<system-reminder>...</system-reminder>" },
        { "type": "text", "text": "USD budget: $0/$50..." },
        { "type": "text", "text": "actual user message" }
      ]
    },
    {
      "role": "assistant",
      "content": [
        { "type": "thinking", "thinking": "..." },
        { "type": "text", "text": "response" },
        { "type": "tool_use", "name": "Bash", "input": { ... } }
      ]
    },
    {
      "role": "user",
      "content": [
        { "type": "tool_result", "tool_use_id": "...", "content": "..." }
      ]
    }
  ]
}
```

### Content Category Classification

The extract script classifies `request_body` content into 8 input categories:

| # | Category | Source | Color |
|---|----------|--------|-------|
| 1 | System Prompt | `system[]` blocks | Blue `#2563eb` |
| 2 | Tool Schemas | `tools[]` (JSON.stringify length) | Purple `#7c3aed` |
| 3 | SDK Injected | `messages[0]` text blocks with `<system-reminder>` or `USD budget:` | Cyan `#0891b2` |
| 4 | User Messages | Remaining text blocks in user messages | Green `#059669` |
| 5 | Thinking | `thinking` blocks in assistant messages | Amber `#d97706` |
| 6 | Response Text | `text` blocks in assistant messages | Red `#dc2626` |
| 7 | Tool Calls | `tool_use` blocks in assistant messages | Violet `#9333ea` |
| 8 | Tool Results | `tool_result` blocks in user messages | Orange `#ea580c` |
| 9 | Output | `output_tokens` from API (not decomposable) | Dark `#111827` |

### Cache Waterfall Attribution

Categories are ordered by their position in the serialized request (system → tools → SDK → history). The actual `cache_read` and `cache_creation` totals from the API are attributed across categories in prefix order — system+tools are always at the top and always cached after call 1.

### Cache Mutation Detection

The Anthropic API caches by exact byte-prefix match. When any byte in the prefix changes between consecutive calls, the cache breaks from that point forward. The extractor diffs consecutive main-agent calls' prefix content (system prompt, tools JSON, SDK-injected blocks) to detect and describe exactly what changed.

Each call gets a `prefix_mutations` field:
- `null` — first call in session or subagent call (no previous call to diff against)
- `[]` — prefix is identical to previous call (cache should hit)
- `[{section, context, ...}]` — one or more sections changed; `context` shows the diff

Context strings use a compact format: `...surrounding{old → new}surrounding...` for mutations, `+[text]` for additions, `-[text]` for removals. The most common cache killer observed is a UUID in a temp file path embedded in tool schemas (`/T/claude-settings-{uuid}`), which changes on every call.

### Pricing (Opus)

```
Standard (≤200K):  input=$5/MTok  cache_write=$6.25/MTok  cache_read=$0.50/MTok  output=$25/MTok
Long ctx (>200K):  input=$10/MTok  cache_write=$12.50/MTok  cache_read=$1.00/MTok  output=$37.50/MTok
```

## File Structure

```
tools/cost-viz/
  extract.ts          # Bun script: JSONL → JSON with prefix mutation diffing
  index.html          # Chart.js 4.x visualization (standalone, no build)
  README.md           # This file
  data/               # gitignored
    raw/              # JSONL files (rsync from Mini or drop manually)
    sessions.json     # Extracted compact data (output of extract.ts)
```
