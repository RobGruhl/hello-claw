# Capability Stack: Design Standards

Formalizes the 4-layer "capability stack" pattern that defines how hello-claw exposes functionality to the agent. All capabilities follow this pattern so new MCPs ship with behavioral guidance from day one.

## Relationship to Official Spec

The [Agent Skills Specification](https://agentskills.io/specification) defines the canonical skill format: a directory with a `SKILL.md` file containing YAML frontmatter and a free-form body. Our 4-layer capability stack is our internal architecture pattern layered on top of that spec.

- **The spec defines the envelope** — frontmatter fields, directory structure, file naming
- **We define the coupling** — how skills relate to MCP servers, how tools are documented, how the agent learns when to use what

This document should be read alongside the spec. Where we differ (e.g., recommended body sections), the reasoning is explained.

## Usability Philosophy

This is fundamentally a usability problem. When an agent picks the wrong tool — calling `web_search` when it should call `ask`, or scheduling a task when it should just execute — the fix is better tool descriptions and clearer skill guidance. Not more rigid structure, not machine-readable templates, not SHOUTING IN CAPS.

**Tool descriptions should make the right choice obvious.** If the agent confuses `ask` with `web_search`, the description is the problem. Fix the description before adding another layer of routing logic.

**Tool descriptions should be brief; skills carry the detail.** Tool descriptions are baked into every API call as part of the tool definition — they're fixed overhead. Keep them to 2-4 lines summarizing purpose and pointing to the skill for reference tables, decision trees, and examples. Heavy content in tool descriptions wastes tokens on every call, even when the tool isn't used.

**Human-readable beats machine-computable.** The cron MCP accepts `"in 5m"` not epoch seconds. The media MCP has aspect ratio presets like `"16:9"` not pixel dimensions. Skills should reinforce this philosophy — describe tools in terms humans think in.

**Skills read like peer guidance, not protocol specs.** A good skill reads like a knowledgeable colleague explaining when to use what: "For quick factual questions, `ask` tends to work best — it's faster and cheaper than `deep_research`, which is worth the 30-60 second wait only when you need multi-source synthesis." Not: "ALWAYS USE ask FOR FACTUAL QUERIES. NEVER USE deep_research UNLESS COMPLEXITY SCORE > 7."

**When in doubt, write less.** An agent that reads a clear 200-line skill outperforms one that skims a dense 800-line skill. Move heavy reference material to `references/` files.

## The 4-Layer Stack

```
Layer 1: Skill       plugins/skills/{name}/SKILL.md     Behavioral context (when/how)
Layer 2: Lib code    src/lib/                            Helpers, formatters, validators
Layer 3: MCP server  src/mcp/{name}.ts                   Host-side tool definitions
Layer 4: External    third-party API or filesystem        The wrapped service
```

**Layer 1 (Skill)** is what makes tools usable. Without it, the agent reads inline tool descriptions and guesses — which works for simple tools but fails for multi-tool MCPs where the agent must choose between similar options (e.g., `ask` vs `deep_research`).

**Layer 2 (Lib code)** is shared infrastructure. Examples: `src/lib/mrkdwn.ts` (Slack formatting). Not every capability needs this layer.

**Layer 3 (MCP server)** defines the tools the agent can call. Runs in the host process (outside sandbox) with direct access to API keys and network. Tool descriptions should be brief (2-4 lines) and defer to the skill for detailed reference.

**Layer 4 (External)** is the upstream service: Perplexity API, Slack API, Gemini API, or the local filesystem.

## Skill Folder Structure

```
plugins/skills/{name}/
  SKILL.md              # Required — YAML frontmatter + behavioral context
  scripts/              # Executable code (sandbox-constrained)
  references/           # Additional documentation loaded on demand
  assets/               # Static files (templates, schemas, images)
```

**Scripts run inside the sandbox:**
- Python 3.9 stdlib (json, csv, sqlite3, re, pathlib, hashlib, etc.)
- Node 22, Bun 1.3, Bash 3.2, jq, git
- Write to workspace + `/tmp/claude/` only
- No network (pip/npm present but can't reach registries)
- No access to host process env vars or API keys

## Progressive Disclosure

The SDK loads skill content in tiers to manage context window budget:

| Tier | What loads | When | Token budget |
|---|---|---|---|
| **Tier 1** | Frontmatter `name` + `description` | Session start, ALL skills | ~100 tokens per skill |
| **Tier 2** | SKILL.md body | Skill activated | <5000 tokens, <500 lines |
| **Tier 3** | `scripts/`, `references/`, `assets/` | Agent explicitly requests | On demand, no fixed limit |

**Tier 1** is the trigger — the SDK reads every skill's frontmatter to decide which ones are relevant. Keep `description` tight and trigger-focused.

**Tier 2** is the working context. This is what the agent reads when it needs to use your tools. Keep SKILL.md under 500 lines. If you're writing more, move reference material to `references/` files.

**Tier 3** is the deep shelf. Put detailed schemas, long examples, prompt templates, and static data here. The agent can read these files when it needs them, but they don't consume context by default.

## SKILL.md Structure

### Frontmatter

```yaml
---
name: {name}
description: >
  Trigger text the SDK sees at session start. Describes when this
  skill is relevant — what user intents or keywords activate it.
---
```

**Spec constraints:**
- `name` must match the directory name
- `name`: 1-64 characters, lowercase letters, numbers, and hyphens only
- `description`: max 1024 characters

That's it for frontmatter. Available tools belong in the body where the agent can see them with context about when and how to use each one.

### Body

The spec says: "no format restrictions — write whatever helps agents perform the task effectively." We recommend these sections, but the real requirement is that it reads like thoughtful peer guidance:

1. **What This Is** — One paragraph explaining the capability and what it wraps.

2. **Tools Reference** — For each tool:
   - Name (e.g., `mcp__search__ask`)
   - Purpose (one line)
   - When to use — behavioral guidance, not just parameter docs
   - Key parameters with types and defaults

3. **Decision Tree** — Table mapping user situations to tool choices (5+ entries). This is the highest-value section for multi-tool MCPs:
   ```
   | User says / situation        | Tool              | Notes                    |
   |------------------------------|-------------------|--------------------------|
   | "What's the weather?"        | ask               | Quick factual question   |
   | "Find articles about..."     | deep_research     | Needs multi-source synthesis |
   ```

4. **Communication Values** — Tone and behavioral guidance specific to this domain. How should the agent communicate results? What mistakes should it avoid?

5. **Data Format Reference** (if applicable) — Schemas for structured data the tools consume or produce.

## MCP Architecture

The [Model Context Protocol](https://modelcontextprotocol.io) defines how tools are exposed to agents. In our system:

- **The Agent SDK is the MCP host.** It creates MCP clients internally for each server listed in `mcpServers`.
- **No internal MCP client code needed.** Our `{ slack: slackMcp, cron: cronMcp, ... }` pattern is sufficient — the SDK handles client-server communication.
- **MCP servers expose 3 primitives:** tools, resources, and prompts. We currently only use tools.
- **Skills and MCP are complementary layers:** MCP defines what tools exist and their schemas. Skills teach the agent when and how to use them effectively.

The MCP servers run in the host process (outside the sandbox) with direct access to API keys and network. The sandbox only constrains Bash commands and child processes.

## Naming Convention

All layers use the same name. This is non-negotiable — it's how the system stays navigable.

| Layer | Pattern | Example (search) |
|---|---|---|
| Skill directory | `plugins/skills/{name}/` | `plugins/skills/search/` |
| MCP source file | `src/mcp/{name}.ts` | `src/mcp/search.ts` |
| MCP server name | `'{name}'` in mcpServers | `'search'` |
| Tool prefix | `mcp__{name}__*` | `mcp__search__*` |
| Frontmatter name | `name: {name}` | `name: search` |

**Exception:** If the name contains a hyphen (e.g., `second-brain`), the MCP source file may keep its original name (`brain.ts`) to avoid import path churn — but the server `name` field, frontmatter `name`, and tool prefix must all use the canonical name (`second-brain`, `mcp__second-brain__*`).

## Path Model

```
process.cwd()  →  project root (both laptop and Mini)
  ├─ workspace.ts: path.resolve('workspace')  →  absolute workDir
  │   ├─ query({ cwd: workDir })       Agent's working directory
  │   ├─ MCP constructors({ workDir }) MCPs receive absolute path
  │   ├─ createToolPolicy(workDir)     Validates writes within workDir
  │   └─ Agent sees relative paths from workspace as "."
  └─ path.resolve('plugins')           Plugin/skill discovery (CWD-relative)
```

**Concrete paths:**
- Development: `{project-root}/workspace`
- Mini: `~/hello-claw/app/workspace`

**Rule for new code:** MCP constructors receive `workDir` as an absolute path. Never call `ensureWorkspace()` or `path.resolve('workspace')` inside MCP tool handlers — use the constructor arg.

## Completeness Checklist

Every capability must satisfy all items before shipping:

- [ ] SKILL.md in `plugins/skills/{name}/` with recommended sections (What This Is, Tools Reference, Decision Tree, Communication Values)
- [ ] SKILL.md under 500 lines
- [ ] Frontmatter `name` matches directory name and MCP server name
- [ ] `description` is trigger-focused and under 1024 characters
- [ ] Decision tree has 5+ entries mapping situations to tools
- [ ] Tool descriptions are brief (2-4 lines) and defer to skill for detail
- [ ] Tone check — reads like peer guidance, not robot-speak
- [ ] Shared lib code extracted for any helpers used by 2+ files
- [ ] Path handling uses `workDir` constructor arg (no re-resolving)
- [ ] `allowedTools` granted in host.ts (and cron.ts / heartbeat.ts if applicable)
- [ ] CLAUDE.md references updated (project root + workspace seed)

## Capabilities

| Capability | Spec | Status |
|---|---|---|
| Search | [search.md](search.md) | Implemented |
| Slack | [slack.md](slack.md) | Implemented |
| Media | [media.md](media.md) | Implemented |
| Cron | [cron.md](cron.md) | Implemented |
| Second Brain | [second-brain.md](second-brain.md) | Implemented |
| GitHub | [github.md](github.md) | Implemented |
| Audio | [audio.md](audio.md) | Implemented |
| Voice | [voice.md](voice.md) | Implemented |

## Reference Implementation

The `second-brain` skill (`plugins/skills/second-brain/SKILL.md`) is the canonical example. It demonstrates:
- YAML frontmatter with `name` and `description`
- Tool reference cards with behavioral guidance
- Decision tree via category-to-tool mapping
- Data format documentation (Capture, Memory schemas)
- Communication values (ADHD-friendly framing)

All new skills should read second-brain's SKILL.md before drafting their own.
