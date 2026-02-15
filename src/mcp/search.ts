/**
 * Search MCP Server - Perplexity-powered web search and research
 * Runs in the host process (OUTSIDE the sandbox) so it has network access for API calls
 */

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { checkRateLimit } from '../lib/rate-limit.js';

interface SearchMcpOptions {
  perplexityApiKey: string;
}

// --- Internal helpers ---

interface ChatResponse {
  answer: string;
  citations: string[];
}

async function perplexityChat(
  apiKey: string,
  model: string,
  query: string,
  opts: {
    domain_filter?: string[];
    search_mode?: string;
    num_search_results?: number;
    timeout_ms?: number;
  } = {},
): Promise<ChatResponse> {
  const body: Record<string, unknown> = {
    model,
    messages: [{ role: 'user', content: query }],
  };
  if (opts.domain_filter?.length) body.search_domain_filter = opts.domain_filter;
  if (opts.search_mode) body.search_mode = opts.search_mode;
  if (opts.num_search_results) body.num_search_results = opts.num_search_results;

  const response = await fetch('https://api.perplexity.ai/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    signal: AbortSignal.timeout(opts.timeout_ms ?? 30_000),
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Perplexity API error (${response.status}): ${errText}`);
  }

  const data = await response.json() as {
    choices?: Array<{ message?: { content?: string } }>;
    citations?: string[];
  };

  const answer = data.choices?.[0]?.message?.content || '';
  const citations = data.citations || [];

  return { answer, citations };
}

// --- MCP Server ---

export function createSearchMcp({ perplexityApiKey }: SearchMcpOptions) {
  return createSdkMcpServer({
    name: 'search',
    version: '1.0.0',
    tools: [
      tool(
        'ask',
        `Search the web and get a sourced answer. The default for all questions — returns a synthesized response with citation URLs. Use search_mode 'academic' for scholarly sources or 'sec' for SEC filings. See search skill for decision tree and search modes.`,
        {
          query: z.string().describe('The question to answer'),
          domain_filter: z.array(z.string()).optional().describe('Allow/block domains (prefix "-" to block)'),
          search_mode: z.enum(['web', 'academic', 'sec']).optional().describe('Search mode (default: web)'),
          num_search_results: z.number().optional().describe('How many sources to consult'),
        },
        async (args) => {
          if (!perplexityApiKey) {
            return {
              content: [{ type: 'text' as const, text: 'PERPLEXITY_API_KEY not set. Cannot search.' }],
              isError: true,
            };
          }

          const limit = checkRateLimit('search', 100);
          if (!limit.allowed) {
            return { content: [{ type: 'text' as const, text: limit.message }], isError: true };
          }

          try {
            const { answer, citations } = await perplexityChat(
              perplexityApiKey,
              'sonar-pro',
              args.query,
              {
                domain_filter: args.domain_filter,
                search_mode: args.search_mode,
                num_search_results: args.num_search_results,
                timeout_ms: 30_000,
              },
            );

            let text = answer;
            if (citations.length > 0) {
              text += '\n\nSources:\n' + citations.map((url, i) => `[${i + 1}] ${url}`).join('\n');
            }

            return {
              content: [{ type: 'text' as const, text }],
            };
          } catch (err) {
            return {
              content: [{ type: 'text' as const, text: `Ask failed: ${err instanceof Error ? err.message : String(err)}` }],
              isError: true,
            };
          }
        },
      ),

      tool(
        'deep_research',
        `Deep multi-source investigation for complex topics. Takes 1-5 minutes. Use when you need a thorough report, comparison, or briefing — not for quick questions. See search skill for when to use this vs ask.`,
        {
          query: z.string().describe('Research question or topic'),
          domain_filter: z.array(z.string()).optional().describe('Allow/block domains (prefix "-" to block)'),
        },
        async (args) => {
          if (!perplexityApiKey) {
            return {
              content: [{ type: 'text' as const, text: 'PERPLEXITY_API_KEY not set. Cannot search.' }],
              isError: true,
            };
          }

          const limit = checkRateLimit('search', 100);
          if (!limit.allowed) {
            return { content: [{ type: 'text' as const, text: limit.message }], isError: true };
          }

          try {
            const { answer, citations } = await perplexityChat(
              perplexityApiKey,
              'sonar-deep-research',
              args.query,
              {
                domain_filter: args.domain_filter,
                timeout_ms: 360_000,
              },
            );

            let text = answer;
            if (citations.length > 0) {
              text += '\n\nSources:\n' + citations.map((url, i) => `[${i + 1}] ${url}`).join('\n');
            }

            return {
              content: [{ type: 'text' as const, text }],
            };
          } catch (err) {
            return {
              content: [{ type: 'text' as const, text: `Deep research failed: ${err instanceof Error ? err.message : String(err)}` }],
              isError: true,
            };
          }
        },
      ),
    ],
  });
}
