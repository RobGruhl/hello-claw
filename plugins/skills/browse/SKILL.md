---
name: browse
description: >
  Web browsing and content extraction. Relevant when someone shares a URL,
  asks to read a web page, needs to interact with a site, or wants content
  extracted from the web. Three tiers: firecrawl (default), browser (interactive),
  WebFetch (lightweight fallback).
allowed-tools: mcp__firecrawl__*, mcp__browser__*
---

# Browse — Web Reading & Interaction

Three tools for reading the web, each with different strengths. Start with firecrawl, escalate as needed.

## Tools

### Firecrawl (`mcp__firecrawl__*`) — Default

- **scrape** — Extract markdown from a URL. Best success rate, cleanest output, handles most JS. The default for all "read this page" tasks.
- **search_and_scrape** — Search the web and scrape top results. Set `scrape_limit: 0` for URL-only results.

### Browser (`mcp__browser__*`) — Interactive

- **navigate** — Open a URL in Playwright, return a structured index of headings, links, buttons, inputs.
- **snapshot** — Re-read the current page's index without navigating. Use after clicking or waiting.
- **click** — Click an element by ref number. For cookie banners, pagination, "show more" buttons.
- **screenshot** — Capture the page as PNG to workspace. For visual context.

### WebFetch (built-in) — Lightweight

- **WebFetch** — Simple HTTP fetch, HTML-to-markdown, processed by a small fast model. No JS rendering, no bot mitigation. Cheapest and fastest, but weakest.

## Decision Tree

Start from what you need, not which tool to use:

| Intent | Tool | Why |
|---|---|---|
| Read a URL — article, docs, reference | `firecrawl scrape` | Best quality, handles JS, beats most bot protection |
| Firecrawl returned empty/blocked | `browser navigate` then Read snapshot | Real browser bypasses some blocks firecrawl can't |
| Browser also blocked (Cloudflare challenge) | Note the block, try `WebFetch` as last resort | Some sites block all automated access |
| Click through a page (pagination, tabs, dropdowns) | `browser navigate` → `click` | Only browser can interact |
| Dismiss cookie/consent banners | `browser navigate` → `click` the banner | Use ref from the index |
| See what a page looks like visually | `browser screenshot` | PNG saved to workspace |
| Search + get actual page content (not AI synthesis) | `firecrawl search_and_scrape` | Raw content from multiple sources |
| Quick fetch of a known-simple page | `WebFetch` | Fine for static HTML pages you know will work |
| Page content loads after delay | `firecrawl scrape` with `wait_for` | Or browser navigate → wait → snapshot |
| Quick factual question (no specific URL) | See search skill — `ask` | Don't scrape when a search answers it |
| Need a synthesized research report | See search skill — `deep_research` | Perplexity synthesizes across sources |

**Default path:** firecrawl → browser → WebFetch. Escalate on failure, don't start heavy.

## Firecrawl Details

**`scrape` parameters:**
- `formats` — Default `["markdown"]`. Also `"html"`, `"links"`, `"screenshot"`.
- `only_main_content` — Strip chrome. Default `true`. Set `false` for full page.
- `wait_for` — Wait N ms for JS before scraping. For delayed-render content.

**`search_and_scrape` parameters:**
- `scrape_limit` — Results to scrape fully. Default `3`. Set `0` for URLs only.
- `num_results` — Total search results. Default `5`.

Content truncated at 50K chars. If a page is very long, note the truncation.

## Browser Details

**Snapshot index format:**
Navigate and snapshot return a structured index inline — headings, links (with URLs), buttons, inputs, tabs — not the full accessibility tree. The full tree is saved to `workspace/browser/snapshot.txt`.

```
Page: Example Page
URL: https://example.com
Snapshot: /path/to/browser/snapshot.txt (12345 chars, 42 interactive refs)

# Main Heading [ref=e1]
- link "About" → /about [ref=e6]
- button "Accept Cookies" [ref=e10]
```

**When the index is enough:** finding links, understanding structure, identifying what to click.

**When you need the full snapshot:** reading article body text, finding specific content, prices, descriptions. Use `Read` or `Grep` on the snapshot file.

**Refs are invalidated** after every navigate or click. If a click fails with "Unknown ref", take a new snapshot.

**Security:** Browser blocks private/local network addresses (localhost, *.local, private IPs). Only http/https URLs.

**Auto-close:** Browser closes after 5 minutes of inactivity.

## Workflow Patterns

**Simple read:**
1. `firecrawl scrape` the URL
2. Summarize or extract what's relevant

**Read with fallback:**
1. `firecrawl scrape` — if empty/error, continue
2. `browser navigate` — read the index, Read snapshot for body text

**Interactive browse:**
1. `browser navigate` to the URL
2. Scan index for cookie banners → `click` to dismiss
3. Find the content section → Read snapshot or `click` to navigate deeper
4. `screenshot` if visual context helps

**Search and read:**
1. `firecrawl search_and_scrape` for the topic
2. Read through results, follow up with `scrape` on the most relevant

## Cost-Aware Browsing

Browsing is expensive — each page fetch burns tokens on content extraction and analysis.

- **Delegate large fetches to `web-curator`.** When the raw page is going to be big (long docs, dense HTML) or you need to click through multiple pages, spawn the `web-curator` sub-agent via the Task tool. It fetches in an isolated Sonnet context and returns 2–15K chars of verbatim excerpts with URLs — not a summary, the actual chunks you need. See the delegation skill for the full decision tree.
- **Direct browsing is fine** for single-page quick lookups where you know the URL and want the whole thing.
- **Don't scrape speculatively.** Only fetch pages you're confident will have the answer.
- **Extract what's relevant.** Don't pass raw scraped content to the user.

## Communication Values

- Summarize or extract relevant parts — don't dump raw markdown
- When scraping for someone, mention what page was read and highlight key content
- If a page is blocked by all three tools, say so plainly
- Firecrawl and WebFetch return raw content; browser returns structural data — choose based on what you need to communicate
- Screenshots are saved to workspace — mention the file path
