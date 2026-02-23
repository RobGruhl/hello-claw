# Browser — Web Page Interaction

**Status:** Implemented

Implements the browser capability stack per [Design Standards](design-standards.md).

## Capability Stack

| Layer | Location | Notes |
|---|---|---|
| Skill | `plugins/skills/browse/SKILL.md` | Unified browse skill covering firecrawl, browser, and WebFetch. |
| Lib code | N/A | URL validation and browser lifecycle inlined in MCP file. |
| MCP server | `src/mcp/browser.ts` (~260 lines, 4 tools) | `navigate`, `snapshot`, `click`, `screenshot`. Rate-limited 100/day. |
| External | Playwright (Chromium) | Optional runtime dependency — graceful degradation if not installed. |

**Availability:** host.ts only (`mcp__browser__*`). NOT in heartbeat or cron (too heavy/interactive for autonomous use).

## Tools

| Tool | Purpose |
|---|---|
| `mcp__browser__navigate` | Open URL, return accessibility tree with interactive element refs. Entry point for all browser interaction. |
| `mcp__browser__snapshot` | Get current page accessibility tree. Use after click or wait. |
| `mcp__browser__click` | Click element by ref number from snapshot. Returns updated tree. |
| `mcp__browser__screenshot` | Capture page as PNG to workspace media directory. |

## Design Decisions

### 4-tool read-heavy subset (not full Playwright)

Deliberately excluded from v1:
- `fill`, `type`, `press`, `select` — form interaction is the highest-risk capability
- `evaluate` — arbitrary JS execution
- `pdf`, tabs, network mocking, auth state

Click is included because many pages need it for cookie banners, pagination, and "show more" buttons. This is the minimum viable subset for read-oriented browsing.

### Ref system for element interaction

The accessibility tree assigns numeric `ref` values to interactive elements (links, buttons, textboxes, etc.). The agent reads the tree, identifies the ref it wants, and calls `click` with that ref. Internally, refs map to `{role, name}` pairs used with Playwright's `getByRole()` locator.

Refs are invalidated on every navigate or click since the tree changes. If a ref lookup fails, the agent must take a new snapshot.

### URL validation: block private networks, allow public internet

A strict domain allowlist would make the tool useless. Instead, defense-in-depth:

1. **MCP handler** (`validateUrl()`) — parse URL, reject non-http(s), DNS-resolve hostname, reject private IPs (RFC1918, loopback, link-local, `.local`, `.internal`)
2. **PreToolUse hook** (`tool-policy.ts`) — fast sync regex on hostname patterns as a second layer
3. **Rate limiting** — 100 browser ops/day

### Browser as optional dependency

Playwright is loaded via dynamic import. If not installed, all tools return a helpful error message with install instructions. This means:
- The project compiles without playwright
- Deployment without playwright still works (browser tools gracefully degrade)
- Installing playwright is a separate opt-in step

### Singleton browser with idle timeout

One browser instance shared across all tool calls. Auto-closes after 5 minutes of inactivity. Re-launched on next navigate. This avoids the overhead of launching a new browser per tool call while preventing resource leaks.

## Security Properties

- **No API key** — Playwright is local software, not an API service
- **Private network blocking** — async DNS resolution catches rebinding attacks; sync hostname regex provides defense-in-depth
- **Rate-limited** — 100 calls/day shared across all tools
- **Screenshot path validation** — output must resolve within `workDir` or `/tmp/`
- **No form filling** — reduces attack surface (no credential entry, no XSS via input)
- **No JS evaluation** — agent cannot execute arbitrary JavaScript in pages
- **Runs outside sandbox** — browser process is in host, not constrained by Seatbelt
- **Headless Chromium** — no GUI, no user-visible browser window

### Attack surface

The browser can load arbitrary public web pages, which means:
- Malicious pages could attempt to exploit Chromium vulnerabilities
- Page content (accessibility tree) is passed to the agent — prompt injection vector
- Screenshots capture visual content — could include misleading information
- The browser has full network access from the host process

Mitigations: keep Playwright/Chromium updated, rate limiting, private network blocking, no form filling or JS eval.

## Checklist

- [x] SKILL.md in `plugins/skills/browse/` (unified browse skill)
- [x] Decision tree: 10 entries
- [x] Tool descriptions: brief, defer to skill
- [x] `allowedTools` in host.ts (NOT heartbeat or cron)
- [x] Rate limiting via `checkRateLimit()`
- [x] URL validation with DNS resolution
- [x] PreToolUse hook for navigate URLs
- [x] Screenshot path validation
- [x] Browser idle timeout (5 min)
