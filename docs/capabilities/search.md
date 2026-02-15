# Search — Web Search & Research

**Status:** Implemented (`0a35506`)

Implements the search capability stack per [Design Standards](design-standards.md).

## Capability Stack

| Layer | Location | Notes |
|---|---|---|
| Skill | `plugins/skills/search/SKILL.md` | 65 lines. Decision tree, search modes, domain filters, when NOT to search. |
| Lib code | N/A | Stateless — no shared helpers needed. |
| MCP server | `src/mcp/search.ts` (163 lines, 2 tools) | Simplified from 4 tools to 2. Single `perplexityChat()` helper. |
| External | Perplexity API (`/chat/completions`) | `sonar-pro` and `sonar-deep-research` models. |

**Availability:** host.ts and heartbeat.ts (`mcp__search__*`). Not available in cron.

## Tools

| Tool | Model | Purpose |
|---|---|---|
| `mcp__search__ask` | `sonar-pro` | AI-synthesized answer with citation URLs. The default for all search. Supports `search_mode` (`web`, `academic`, `sec`) and `domain_filter`. |
| `mcp__search__deep_research` | `sonar-deep-research` | Deep multi-source investigation (1-5 min). Dozens of searches, hundreds of sources. Supports `domain_filter`. 360s timeout. |

### Key Parameters

**`ask` search modes:**
- `web` (default) — general web search
- `academic` — academic/scientific sources (papers, journals)
- `sec` — SEC filings and financial documents (EDGAR)

**Domain filter syntax (both tools):**
- Positive: `["nytimes.com", "bbc.com"]` — only these domains
- Negative: `["-reddit.com", "-quora.com"]` — exclude these domains
- Mixed: `["nytimes.com", "-reddit.com"]`

## Design Decisions

### Simplified to 2 tools from 4

The original MCP exposed 4 tools (`web_search`, `ask`, `deep_research`, `reason`) mapping to raw Perplexity API endpoints. The agent routinely picked the wrong tool because `web_search` and `ask` overlapped almost completely.

**Removed:**
- `web_search` (raw `/search` endpoint) — `ask` subsumes it entirely. Synthesized answer + citation URLs covers every use case that raw ranked links did.
- `reason` (`sonar-reasoning-pro`) — Claude's native reasoning is equivalent.

**Result:** With 2 tools, the decision becomes self-evident: "quick answer → `ask`, deep report → `deep_research`."

### Skill is compact by design

At 65 lines, search is the shortest skill — appropriate for a 2-tool MCP with no data schemas. The tool descriptions carry the parameter docs. The skill's unique value is: decision tree, search modes, domain filter syntax, when NOT to search, and communication values around citation handling.

## Checklist

- [x] SKILL.md in `plugins/skills/search/` (65 lines)
- [x] Decision tree: 11 entries
- [x] Tool descriptions: brief, defer to skill
- [x] `allowedTools` in host.ts and heartbeat.ts
