---
name: search
description: >
  Perplexity-powered web search and research. Relevant when someone asks a
  question requiring current information, wants a sourced answer, needs a
  research report, or asks you to look something up.
allowed-tools: mcp__search__*
---

# Search — Web Search & Research

Perplexity-powered search with two tools: a fast default and a deep mode.

## Tools

All tools are prefixed `mcp__search__`.

- **ask** — Search the web and get a sourced answer. The default for everything. Returns a synthesized response with citation URLs. Supports `search_mode` for academic or SEC sources.
- **deep_research** — Deep multi-source investigation. Takes 1-5 minutes. Dozens of searches, hundreds of sources. Use when the question justifies a thorough report.

## Decision Tree

| User says / situation | Tool | Notes |
|---|---|---|
| Quick factual question | `ask` | Default for all questions |
| "What is X?" / "How do I..." | `ask` | How-tos, explainers, summaries |
| Current events / breaking news | `ask` | Synthesized answer with source URLs |
| "Find me a link to..." | `ask` | Citations include URLs |
| Academic / scientific sources | `ask` with `search_mode: 'academic'` | Targets scholarly content |
| SEC filings / financial data | `ask` with `search_mode: 'sec'` | Targets SEC EDGAR |
| Specific site content | `ask` with `domain_filter` | Lock to one domain |
| Exclude forums / noise | Add `["-reddit.com"]` to `domain_filter` | Works on both tools |
| Complex comparison (X vs Y) | `deep_research` | Multi-source synthesis worth the wait |
| Research report / deep dive | `deep_research` | Only when depth justifies 30-60s |
| "Write me a briefing on..." | `deep_research` | This is what it's designed for |

**Rule of thumb:** `ask` is the default. Only reach for `deep_research` when the user explicitly wants depth, comparison, or due diligence — and the 30-60s wait is justified.

## Key Parameters

**`ask` search modes:**
- `web` (default) — general web search
- `academic` — academic/scientific sources (papers, journals)
- `sec` — SEC filings and financial documents (EDGAR)

**Domain filter syntax (both tools):**
- Positive: `["nytimes.com", "bbc.com"]` — only these domains
- Negative: `["-reddit.com", "-quora.com"]` — exclude these domains
- Mixed: `["nytimes.com", "-reddit.com"]`

## When NOT to Search

- You already know the answer (general knowledge within training data)
- Information is in the workspace (use Read/Grep instead)
- User is asking about their own codebase (use file tools)
- Cron task context (search tools are not available in scheduled tasks)

## Communication Values

- Both tools return AI-synthesized answers — note this when citing
- `ask` includes citations — always surface them to the user
- If using `deep_research`, acknowledge the wait: "Let me do a thorough search — this takes 30-60 seconds"
- Don't over-search — if `ask` gave a good answer, don't follow up with `deep_research` for marginal improvement
- Citations include source URLs — use WebFetch on individual citations when you need full article text, primary source verification, or deeper context
