/**
 * Shared query() option builder.
 *
 * Before this file, host.ts, cron.ts, and heartbeat.ts each carried ~50
 * lines of near-identical SDK config that had drifted: cron was missing
 * a beta flag, missing ENABLE_TOOL_SEARCH=false, and using the wrong
 * session type. Centralizing here means a new SDK option gets added once
 * and every call site picks it up.
 *
 * Sub-agent definitions live here too — they're shared config, and the
 * delegation skill (plugins/skills/delegation/SKILL.md) references
 * these names.
 */

import path from 'path';
import { AGENT_MODEL, AGENT_EFFORT, BETAS, MAX_BUDGET_USD } from './config.js';
import { buildSystemPrompt } from './system-prompt.js';
import { createToolPolicy } from '../hooks/tool-policy.js';
import { createAuditHook } from '../hooks/audit.js';
import type { HookCallback } from '@anthropic-ai/claude-agent-sdk';

/**
 * Sub-agent definitions — noisy work happens in isolated contexts.
 *
 * Philosophy: sub-agents are CURATORS, not summarizers. They read 50K
 * of source material and return the 5K that matters — verbatim quotes
 * with attribution, not paraphrased mush. The main agent needs real
 * chunks to reason over, just not the full raw firehose.
 *
 * All sub-agents run on Sonnet (floor for synthesis quality — Haiku
 * too weak for 50K-token curation tasks). Read-only tool sets keep
 * them from writing to the workspace.
 */
const CURATOR_PHILOSOPHY = `You are a curator, not a summarizer. The agent who spawned you needs real material to reason over — full quotes, full code blocks, full data rows — just not the raw 100K-char firehose.

Return format:
- Verbatim excerpts with source attribution (file path, URL, line numbers)
- Preserve structure: code stays in code blocks, tables stay tabular
- Target 2,000–15,000 characters. Under 2K means you probably cut too much; over 15K means you probably didn't curate.
- If nothing relevant was found, say exactly that in one line. Don't pad.

Never paraphrase when you can quote. Never compress a 10-line function into "it handles auth" — return the 10 lines.`;

export const SUBAGENTS = {
  'web-curator': {
    description: 'Reads and curates web content. Use for WebFetch, firecrawl, or browser tasks where the raw page would be large — delegate the fetch and get back the relevant excerpts instead of dumping 80K chars of HTML into the main session.',
    prompt: `${CURATOR_PHILOSOPHY}

You have web access (WebFetch, firecrawl, browser). Fetch the requested content, extract what's relevant to the task, and return verbatim excerpts with URLs.`,
    tools: ['WebFetch', 'WebSearch', 'mcp__firecrawl__scrape', 'mcp__firecrawl__search_and_scrape', 'mcp__browser__navigate', 'mcp__browser__snapshot', 'mcp__browser__click', 'Read', 'Grep', 'Glob'],
    model: 'sonnet' as const,
  },

  'workspace-archaeologist': {
    description: 'Explores the workspace filesystem to answer questions about past work. Use when you need to search through many files (logs, daily reflections, memory notes, second-brain data) without flooding the main context with Grep/Read results.',
    prompt: `${CURATOR_PHILOSOPHY}

You have read-only filesystem access. Explore the workspace to answer the question — grep widely, read narrowly, return the relevant passages with file paths and line numbers.`,
    tools: ['Read', 'Grep', 'Glob', 'Bash'],
    model: 'sonnet' as const,
  },

  'deep-research': {
    description: 'Wraps heavyweight research tools (mcp__search__deep_research, mcp__oracle__ask) whose raw outputs can run 10-30K+ chars. Delegate the call, get back a curated digest with the key findings quoted verbatim.',
    prompt: `${CURATOR_PHILOSOPHY}

You have access to deep_research (Perplexity sonar-deep-research) and oracle (GPT-5 Pro). These tools return long, dense responses. Run the query, then curate the result — pull the key findings, quotes, and citations forward. Drop the preamble and the hedging.`,
    tools: ['mcp__search__deep_research', 'mcp__search__ask', 'mcp__search__web_search', 'mcp__oracle__ask', 'Read'],
    model: 'sonnet' as const,
  },
};

const SANDBOX_CONFIG = {
  enabled: true,
  autoAllowBashIfSandboxed: true,
  allowUnsandboxedCommands: false,
  network: {
    allowLocalBinding: false,
    allowedDomains: [
      'api.anthropic.com',
      'statsig.anthropic.com',
      'sentry.io',
    ],
  },
};

export interface QueryConfigArgs {
  workDir: string;
  channelId: string;
  anthropicApiKey: string;
  userName?: string;
  /** Only interactive sessions resume. Cron and heartbeat pass undefined. */
  sessionId?: string;
  /** Context-specific MCP server map. */
  mcpServers: Record<string, unknown>;
  /** Context-specific tool allowlist (on top of the base set). */
  allowedTools: string[];
  /** Override model (heartbeat tiers use this). Defaults to AGENT_MODEL. */
  model?: string;
  /** Override effort. Defaults to AGENT_EFFORT. */
  effort?: 'low' | 'medium' | 'high' | 'max';
  /** Override turn cap. Interactive=200, heartbeat economy=15. */
  maxTurns?: number;
  /** Extra PreToolUse hooks (heartbeat adds its ack-suppressor here). */
  extraPreHooks?: HookCallback[];
}

/**
 * Build the shared portion of query() options. The caller spreads this
 * into their call and adds `prompt` + any truly context-specific options.
 */
export function buildQueryOptions(args: QueryConfigArgs) {
  const {
    workDir, channelId, anthropicApiKey, userName,
    sessionId, mcpServers, allowedTools,
    model = AGENT_MODEL,
    effort = AGENT_EFFORT,
    maxTurns = 200,
    extraPreHooks = [],
  } = args;

  return {
    model,
    thinking: { type: 'adaptive' as const },
    effort,
    betas: BETAS as any,
    maxBudgetUsd: MAX_BUDGET_USD,
    maxTurns,
    systemPrompt: buildSystemPrompt(workDir, userName),
    cwd: workDir,
    resume: sessionId,
    env: {
      ...process.env,
      ANTHROPIC_API_KEY: anthropicApiKey,
      ENABLE_TOOL_SEARCH: 'false',
    },
    // Plugins (skills) load only on fresh sessions — resumed sessions
    // already have them baked in from the init message.
    ...(sessionId ? {} : { plugins: [{ type: 'local' as const, path: path.resolve('plugins') }] }),
    allowedTools,
    agents: SUBAGENTS,
    permissionMode: 'bypassPermissions' as const,
    allowDangerouslySkipPermissions: true,
    settingSources: ['project' as const],
    sandbox: SANDBOX_CONFIG,
    mcpServers: mcpServers as any,
    hooks: {
      PreToolUse: [{ hooks: [createToolPolicy(workDir, channelId), ...extraPreHooks] }],
      PostToolUse: [{ hooks: [createAuditHook(channelId)] }],
    },
  };
}
