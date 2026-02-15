/**
 * Oracle MCP Server - GPT-5.2 Pro critique and commentary
 * Runs in the host process (OUTSIDE the sandbox) so it has network access for API calls
 *
 * Uses OpenAI Responses API with background mode (async long-running requests).
 * Raw fetch — no openai npm dependency (matches search.ts/media.ts pattern).
 */

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { checkRateLimit } from '../lib/rate-limit.js';

interface OracleMcpOptions {
  openaiApiKey: string;
}

// --- Constants ---

const MODEL = 'gpt-5.2-pro';
const MAX_OUTPUT_TOKENS = 16_000;
const POLL_INTERVAL_MS = 5_000;
const MAX_WAIT_MS = 20 * 60 * 1000; // 20 min hard timeout
const OPENAI_BASE = 'https://api.openai.com/v1';

// --- Internal helpers ---

interface OracleUsage {
  input_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
  total_tokens: number;
}

interface OracleResponse {
  id: string;
  status: string;
  output: string;
  usage: OracleUsage;
}

async function submitQuestion(apiKey: string, question: string): Promise<OracleResponse> {
  const response = await fetch(`${OPENAI_BASE}/responses`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      background: true,
      max_output_tokens: MAX_OUTPUT_TOKENS,
      input: [
        {
          type: 'message',
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: question,
            },
          ],
        },
      ],
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`OpenAI API error (${response.status}): ${errText}`);
  }

  const data = await response.json();
  return normalizeResponse(data);
}

async function pollForCompletion(apiKey: string, responseId: string): Promise<OracleResponse> {
  const startTime = Date.now();
  let delay = POLL_INTERVAL_MS;
  let lastLogTime = startTime;

  while (Date.now() - startTime < MAX_WAIT_MS) {
    await sleep(delay);

    // Log poll status every 60s
    if (Date.now() - lastLogTime >= 60_000) {
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      console.log(`[oracle] Still polling ${responseId} (${elapsed}s elapsed)`);
      lastLogTime = Date.now();
    }

    let result: OracleResponse;
    try {
      const response = await fetch(`${OPENAI_BASE}/responses/${responseId}`, {
        headers: { 'Authorization': `Bearer ${apiKey}` },
      });

      if (response.status === 429 || response.status >= 500) {
        // Exponential backoff on rate limit / server error, capped at 30s
        delay = Math.min(delay * 2, 30_000);
        console.log(`[oracle] Got ${response.status}, backing off to ${delay}ms`);
        continue;
      }

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`OpenAI poll error (${response.status}): ${errText}`);
      }

      result = normalizeResponse(await response.json());
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('OpenAI poll error')) throw err;
      // Network errors — backoff and retry
      delay = Math.min(delay * 2, 30_000);
      console.log(`[oracle] Network error during poll, backing off to ${delay}ms: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }

    // Reset delay on successful poll
    delay = POLL_INTERVAL_MS;

    if (result.status === 'completed') {
      return result;
    }

    if (result.status === 'failed' || result.status === 'cancelled') {
      throw new Error(`Oracle request ${result.status}: ${responseId}`);
    }

    // Still in_progress or queued — keep polling
  }

  // Hard timeout — attempt cancel
  console.log(`[oracle] Hard timeout (${MAX_WAIT_MS / 1000}s) reached for ${responseId}, attempting cancel`);
  try {
    await fetch(`${OPENAI_BASE}/responses/${responseId}/cancel`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}` },
    });
  } catch { /* best-effort cancel */ }

  throw new Error(`Oracle request timed out after ${MAX_WAIT_MS / 60_000} minutes`);
}

function normalizeResponse(raw: Record<string, any>): OracleResponse {
  const usage: OracleUsage = {
    input_tokens: raw.usage?.input_tokens || 0,
    output_tokens: raw.usage?.output_tokens || 0,
    reasoning_tokens: raw.usage?.reasoning_tokens || 0,
    total_tokens: raw.usage?.total_tokens || 0,
  };

  // Extract output text from Responses API structure
  let output = '';
  if (raw.output && Array.isArray(raw.output)) {
    const message = raw.output.find((item: any) => item.type === 'message');
    if (message?.content && Array.isArray(message.content)) {
      const textItems = message.content.filter(
        (item: any) => item.type === 'output_text' || item.type === 'text',
      );
      output = textItems.map((item: any) => item.text).join('\n');
    } else {
      const textOutput = raw.output.find((item: any) => item.type === 'text');
      output = textOutput?.text || '';
    }
  } else if (raw.output?.text) {
    output = raw.output.text;
  }

  return {
    id: raw.id,
    status: raw.status,
    output,
    usage,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// --- MCP Server ---

export function createOracleMcp({ openaiApiKey }: OracleMcpOptions) {
  return createSdkMcpServer({
    name: 'oracle',
    version: '1.0.0',
    tools: [
      tool(
        'ask',
        `Consult GPT-5.2 Pro for critique, commentary, or a second opinion. Blocks for 5-15 minutes while the oracle thinks. The oracle has NO context about you, the user, or this conversation — your question must be completely self-contained. See oracle skill for when to use this and how to write good questions.`,
        {
          question: z.string().describe('The complete, self-contained question to send to the oracle'),
        },
        async (args) => {
          if (!openaiApiKey) {
            return {
              content: [{ type: 'text' as const, text: 'OPENAI_API_KEY not set. Cannot consult the oracle.' }],
              isError: true,
            };
          }

          const limit = checkRateLimit('oracle', 100);
          if (!limit.allowed) {
            return { content: [{ type: 'text' as const, text: limit.message }], isError: true };
          }

          const startTime = Date.now();

          try {
            console.log(`[oracle] Submitting question (${args.question.length} chars)`);
            const submitted = await submitQuestion(openaiApiKey, args.question);
            console.log(`[oracle] Submitted: id=${submitted.id} status=${submitted.status}`);

            let result: OracleResponse;
            if (submitted.status === 'completed') {
              result = submitted;
            } else {
              console.log(`[oracle] Polling for completion...`);
              result = await pollForCompletion(openaiApiKey, submitted.id);
            }

            const elapsedMs = Date.now() - startTime;
            const elapsedMin = (elapsedMs / 60_000).toFixed(1);
            console.log(`[oracle] Complete: ${elapsedMin}m, ${result.usage.input_tokens} in / ${result.usage.output_tokens} out`);

            const header = `[Oracle — ${MODEL} | ${elapsedMin}m | ${result.usage.input_tokens.toLocaleString()} in / ${result.usage.output_tokens.toLocaleString()} out]`;
            const text = `${header}\n\n${result.output}`;

            return {
              content: [{ type: 'text' as const, text }],
            };
          } catch (err) {
            const elapsedMs = Date.now() - startTime;
            const elapsedSec = Math.round(elapsedMs / 1000);
            console.error(`[oracle] Failed after ${elapsedSec}s:`, err instanceof Error ? err.message : String(err));

            return {
              content: [{ type: 'text' as const, text: `Oracle request failed after ${elapsedSec}s: ${err instanceof Error ? err.message : String(err)}` }],
              isError: true,
            };
          }
        },
      ),
    ],
  });
}
