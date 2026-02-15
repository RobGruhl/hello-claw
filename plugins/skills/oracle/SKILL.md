---
name: oracle
description: >
  GPT-5.2 Pro critique and commentary. Relevant when someone explicitly asks
  for a second opinion, wants an external perspective, requests critique of an
  idea or design, asks you to consult the oracle, or wants architectural review
  from a different model.
allowed-tools: mcp__oracle__*
---

# Oracle — GPT-5.2 Pro Critique & Commentary

Access to OpenAI's GPT-5.2 Pro for critique, second opinions, and alternative
perspectives. Responses take 5-15 minutes — this is a heavyweight tool for
thoughtful analysis, not quick answers.

## Tools

All tools are prefixed `mcp__oracle__`.

- **ask** — Send a self-contained question to GPT-5.2 Pro. Blocks for 5-15
  minutes while the oracle thinks in background mode. Returns the full response
  with token usage metadata.

## Formatting Questions Well

The oracle has **NO context** about you, the user, the conversation, or the
codebase. Your question must be completely self-contained. Include everything
the oracle needs to give a useful answer.

**Every good question includes:**
1. **What** — the thing you want analyzed, critiqued, or discussed
2. **Why** — what kind of feedback you're looking for
3. **Perspective** — what lens to use (architect, security auditor, etc.)
4. **Constraints** — any relevant limitations or requirements

### Weak vs Strong Questions

| Weak | Strong |
|---|---|
| "Is this architecture good?" | "Here is an architecture for a Slack bot that runs Claude via the Agent SDK with in-process MCP servers for Slack, cron, media, and search. [paste architecture]. Critique this from a security perspective, focusing on the trust boundaries between the sandboxed agent and the host-process MCP servers." |
| "Should I use Redis?" | "I have a single-process Node.js application that needs to track per-channel session IDs (currently a JSON file) and per-channel async locks (currently in-memory Maps). The app runs on one machine with no horizontal scaling planned. Should I add Redis, or is the current approach adequate? What would change if I needed to scale to 2 machines?" |
| "Review my code" | "Here is a TypeScript MCP server that handles cron task scheduling with human-in-the-loop approval. [paste code]. Review for: (1) race conditions in the approval flow, (2) timer cleanup on shutdown, (3) any ways a prompt-injected agent could bypass the approval requirement." |

## Decision Tree

| Situation | Action | Notes |
|---|---|---|
| User says "ask the oracle" / "consult the oracle" | Use it | Explicit request |
| User says "get a second opinion" | Use it | Explicit request |
| Architecture review or design critique | Use it | This is its sweet spot |
| Security audit of a design | Use it | Different perspective adds value |
| "What would GPT think about..." | Use it | Cross-model perspective |
| Evaluating trade-offs in a complex decision | Use it | Weighing pros/cons with fresh eyes |
| Quick factual question | Use **search** instead | Oracle is overkill, search is instant |
| Code generation | Do it yourself | You write better code for this codebase |
| Debugging a specific error | Do it yourself | You have the context, oracle doesn't |
| Simple how-to question | Do it yourself or search | Not worth the wait |
| User seems unsure or curious | Ask first, explain cost/wait | Let them decide if it's worth 5-15 min |
| Cron / scheduled task | Not available | Oracle is interactive-only |

## Communication Values

- **Warn about wait time before calling.** Always tell the user: "This will take
  5-15 minutes — the oracle thinks deeply. Want me to go ahead?" Don't surprise
  them with a long block.

- **Compose the question transparently.** Show the user what you're about to
  send: "Here's what I'll ask the oracle: [question]. Want me to adjust
  anything?" The question quality determines the answer quality.

- **Present the response faithfully, then add your own take.** Don't summarize
  away the oracle's nuance. Show their response, then offer your own perspective
  on where you agree, disagree, or see things differently. Two models thinking
  about the same problem is the whole point.

- **Cost awareness.** GPT-5.2 Pro pricing is ~$15/M input tokens and ~$120/M
  output tokens. A typical question costs $0.50-2.00. Don't call it frivolously,
  but don't agonize over it either — the value is in the perspective.

- **Don't over-use.** One oracle call per conversation is usually right. If the
  user wants follow-up analysis, consider whether you can handle it yourself with
  the oracle's initial response as context.
