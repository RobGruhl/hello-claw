/**
 * Audit Hook - PostToolUse structured logging
 * Logs all tool executions to persistent per-channel JSONL files
 */

import type { HookCallback } from '@anthropic-ai/claude-agent-sdk';
import { writeAuditEntry } from '../lib/audit-log.js';

export function createAuditHook(channelId: string): HookCallback {
  return async (input) => {
    if (input.hook_event_name !== 'PostToolUse') return {};

    const toolInput = input as {
      tool_name: string;
      tool_input: Record<string, unknown>;
      tool_response: unknown;
    } & typeof input;

    const response = toolInput.tool_response as { isError?: boolean } | undefined;
    const success = !response?.isError;

    writeAuditEntry({
      timestamp: new Date().toISOString(),
      channel: channelId,
      event: 'tool_use',
      tool: toolInput.tool_name,
      input: summarizeInput(toolInput.tool_name, toolInput.tool_input),
      success,
    });

    return {};
  };
}

/** Summarize tool input for logging (avoid logging full file contents) */
function summarizeInput(toolName: string, input: Record<string, unknown>): Record<string, unknown> {
  if (!input) return {};

  switch (toolName) {
    case 'Bash':
      return { command: String(input.command || '').slice(0, 500) };
    case 'Write':
      return {
        file_path: input.file_path,
        content_length: typeof input.content === 'string' ? input.content.length : 0,
      };
    case 'Edit':
      return { file_path: input.file_path };
    case 'Read':
      return { file_path: input.file_path };
    case 'Grep':
    case 'Glob':
      return { pattern: input.pattern, path: input.path };
    default:
      // For MCP tools, log all arguments (they're tool inputs, not file contents)
      return sanitizeForLog(input);
  }
}

/** Deep-copy input, truncating any string values over 1000 chars */
function sanitizeForLog(input: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === 'string') {
      result[key] = value.length > 1000 ? value.slice(0, 1000) + '...[truncated]' : value;
    } else {
      result[key] = value;
    }
  }
  return result;
}
