---
name: delegation
description: >
  Context protection via sub-agents. Relevant when a task would dump a large
  volume of raw material (web pages, deep_research output, wide grep sweeps)
  into the main session — delegate the noisy work to a sub-agent and receive
  curated excerpts instead.
allowed-tools: Task
---

# Delegation — Sub-Agents for Context Protection

Your session context is a shared, finite resource. Every 80K-char web page and every 30K-char `deep_research` dump you pull into it pushes useful conversation history toward the compaction boundary. Sub-agents let you do the noisy work in an isolated context and bring back only what matters.

## The Contract

Sub-agents are **curators, not summarizers**. They read the 50K firehose and return the 5K that matters — verbatim quotes with file paths, URLs, line numbers. Full code blocks, not "it handles auth." Target return size is 2–15K chars: enough to reason over, bounded enough to preserve your session.

You invoke them with the `Task` tool. They get a fresh context, run their tools, and return a single final message. You never see their intermediate tool calls — just the curated result.

## Available Sub-Agents

### `web-curator`
Reads web content so you don't have to absorb raw HTML.

- **Tools:** WebFetch, WebSearch, firecrawl (scrape, search_and_scrape), browser (navigate, snapshot, click), Read, Grep, Glob
- **Use when:** you need something specific from a page (the pricing table, the API signature, the changelog entry) and the raw page would be large
- **Give it:** the URL(s) and what you're looking for
- **Get back:** verbatim excerpts with source URLs

### `workspace-archaeologist`
Searches the workspace filesystem when the hunt would be wide.

- **Tools:** Read, Grep, Glob, Bash (read-only)
- **Use when:** answering a question requires grepping across many files — past daily reflections, memory notes, second-brain captures, old logs — and the raw hits would flood you
- **Give it:** the question and rough hints about where to look
- **Get back:** relevant passages with `file_path:line_number` attribution

### `deep-research`
Wraps the heavyweight research tools whose raw output runs long.

- **Tools:** `mcp__search__deep_research`, `mcp__search__ask`, `mcp__search__web_search`, `mcp__oracle__ask`, Read
- **Use when:** you want a `deep_research` or `oracle` answer but don't need all 20K chars of it in your context — just the key findings
- **Give it:** the research question, verbatim, plus any framing that helps
- **Get back:** key findings and quotes, citations preserved, preamble dropped

## When to Delegate

| Situation | Action | Why |
|---|---|---|
| Need one specific thing from a long web page | `web-curator` | Raw page would be 30–100K chars |
| Need to interact with a page (click, navigate) to reach content | `web-curator` | Browser snapshot accumulation is noisy |
| "When did I last mention X?" across months of notes | `workspace-archaeologist` | Grep hits across 50 files are noise |
| User asks a research question you'd route to `deep_research` | `deep-research` | Raw output often 15–30K chars |
| Want oracle's take but not the full 10K-word essay | `deep-research` | Curator pulls forward the actual answer |

## When NOT to Delegate

| Situation | Action | Why |
|---|---|---|
| Single known file, you want the whole thing | `Read` directly | It's already bounded |
| Specific grep in one file or a handful | `Grep` directly | Small result set, no isolation needed |
| Short page you need in full (API docs snippet, a gist) | `WebFetch` directly | The whole thing IS what you need |
| Quick `mcp__search__ask` (Sonar, not deep_research) | Call it directly | Returns a few hundred chars |
| Any task where your next step depends on seeing everything | Do it yourself | Curator might cut the thing you needed |

The overhead is real — spawning a sub-agent means a round trip on Sonnet. A single `Read` of a 200-line file does not need a sub-agent. A `Grep` that's going to return 3 hits does not need a sub-agent. Reserve delegation for work where the raw material is genuinely large and you genuinely don't need all of it.

## Invocation

```
Task tool:
  subagent_type: "web-curator" | "workspace-archaeologist" | "deep-research"
  prompt: Specific, self-contained instructions. The sub-agent has no
          conversation history — give it everything it needs.
```

Be specific about what to bring back. "Read this page" produces a summary. "Read this page and return the full `createServer` function signature plus any options table" produces something you can use.
