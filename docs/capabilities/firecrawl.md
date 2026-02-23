# Firecrawl — Web Scraping & Content Extraction

**Status:** Implemented

Implements the firecrawl capability stack per [Design Standards](design-standards.md).

## Capability Stack

| Layer | Location | Notes |
|---|---|---|
| Skill | `plugins/skills/browse/SKILL.md` | Unified browse skill covering firecrawl, browser, and WebFetch. |
| Lib code | N/A | Stateless — single `firecrawlRequest()` helper inlined in MCP file. |
| MCP server | `src/mcp/firecrawl.ts` (~180 lines, 2 tools) | `scrape` and `search_and_scrape`. Rate-limited 100/day. |
| External | Firecrawl API (`/v1/scrape`, `/v1/search`) | `api.firecrawl.dev` |

**Availability:** host.ts and heartbeat.ts (`mcp__firecrawl__*`). Not available in cron.

## Tools

| Tool | Endpoint | Purpose |
|---|---|---|
| `mcp__firecrawl__scrape` | `POST /v1/scrape` | Extract markdown from a single URL. The default for "read this page." Supports format selection, main content extraction, and JS wait. 30s timeout. |
| `mcp__firecrawl__search_and_scrape` | `POST /v1/search` | Search web + scrape top results. Combines discovery with extraction. `scrape_limit: 0` for URL-only results. 60s timeout. |

## Design Decisions

### 2 tools, not 4

Dropped standalone `search` (low-value raw URL list; `search_and_scrape` with `scrape_limit: 0` covers it) and `batchScrape` (agent can call `scrape` multiple times). Two tools make the decision surface clean: "I have a URL" → `scrape`, "I need to find content" → `search_and_scrape`.

### Content truncation at 50K chars

Web pages can be enormous. The `truncateContent()` helper caps output at 50,000 characters with a truncation notice. This prevents context window exhaustion while keeping enough content for practical use.

### Inline HTTP client (no SDK dependency)

Uses raw `fetch()` with `firecrawlRequest()` helper, matching the `perplexityChat()` pattern in `search.ts`. No npm dependency on the Firecrawl SDK — keeps the dependency tree minimal.

## Security Properties

- API key captured at startup, stripped from `process.env`, passed via constructor closure
- Rate-limited: 100 calls/day shared across both tools (via `checkRateLimit('firecrawl', 100)`)
- Runs outside sandbox (host process) — Firecrawl API domain is NOT in sandbox `allowedDomains`
- Content from scraped pages is passed to the agent — potential prompt injection vector (accepted risk, same as search)
- `AbortSignal.timeout` prevents hung requests

## Checklist

- [x] SKILL.md in `plugins/skills/browse/` (unified browse skill)
- [x] Decision tree: 10 entries
- [x] Tool descriptions: brief, defer to skill
- [x] `allowedTools` in host.ts and heartbeat.ts
- [x] Rate limiting via `checkRateLimit()`
- [x] Content truncation at 50K chars
