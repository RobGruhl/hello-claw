/**
 * Tool Policy Hook - PreToolUse safety guardrails
 *
 * This is the application-level security layer (Layer 1).
 * It runs BEFORE the OS sandbox sees the command.
 * The OS sandbox (Layer 2) provides additional enforcement.
 */

import type { HookCallback } from '@anthropic-ai/claude-agent-sdk';
import path from 'path';
import { writeAuditEntry } from '../lib/audit-log.js';

// Dangerous command patterns that should never execute
const BLOCKED_COMMANDS = [
  /rm\s+-rf\s+\//,           // rm -rf /
  /rm\s+-rf\s+~\//,          // rm -rf ~/
  /mkfs/,                     // Format filesystem
  /dd\s+if=/,                 // Raw disk write
  /:()\s*\{\s*:\|:&\s*\};:/, // Fork bomb
  />\s*\/dev\/sd/,            // Write to block device
  /chmod\s+-R\s+777\s+\//,   // Open permissions on root
  /curl\s+.*\|\s*sh/,        // Pipe to shell
  /wget\s+.*\|\s*sh/,        // Pipe to shell
  /\bln\s/,                   // Symlink creation (prevents symlink-based path traversal)
  /\blink\s/,                 // Hard link creation
  /data\/audit/,              // Any access to audit logs via Bash (H-7)
  /data\/api-logs/,           // Any access to API proxy logs via Bash (H-NEW-1)
  /api-logs/,                 // Alternate form (H-NEW-1)
  /sessions\.json/,           // Any access to session data via Bash (H-4)
];

// Bash commands that read credential/secret files
const BLOCKED_CREDENTIAL_READS = [
  /(?:cat|head|tail|less|more|bat|strings|xxd|hexdump|od)\s+.*~\/\.ssh\//,
  /(?:cat|head|tail|less|more|bat|strings|xxd|hexdump|od)\s+.*~\/\.aws\//,
  /(?:cat|head|tail|less|more|bat|strings|xxd|hexdump|od)\s+.*~\/\.npmrc/,
  /(?:cat|head|tail|less|more|bat|strings|xxd|hexdump|od)\s+.*~\/\.netrc/,
  /(?:cat|head|tail|less|more|bat|strings|xxd|hexdump|od)\s+.*~\/\.config\/gh\//,
  /(?:cat|head|tail|less|more|bat|strings|xxd|hexdump|od)\s+.*~\/\.docker\/config\.json/,
  /(?:cat|head|tail|less|more|bat|strings|xxd|hexdump|od)\s+.*~\/\.kube\/config/,
  /(?:cat|head|tail|less|more|bat|strings|xxd|hexdump|od)\s+.*~\/\.gnupg\//,
  /(?:cat|head|tail|less|more|bat|strings|xxd|hexdump|od)\s+.*~\/\.gitconfig/,
  // Same patterns with $HOME
  /(?:cat|head|tail|less|more|bat|strings|xxd|hexdump|od)\s+.*\$HOME\/\./,
  // Same patterns with resolved home paths
  /(?:cat|head|tail|less|more|bat|strings|xxd|hexdump|od)\s+.*\/Users\/[^/]+\/\.ssh\//,
  /(?:cat|head|tail|less|more|bat|strings|xxd|hexdump|od)\s+.*\/Users\/[^/]+\/\.aws\//,
  /(?:cat|head|tail|less|more|bat|strings|xxd|hexdump|od)\s+.*\/Users\/[^/]+\/\.npmrc/,
  /(?:cat|head|tail|less|more|bat|strings|xxd|hexdump|od)\s+.*\/Users\/[^/]+\/\.netrc/,
  /(?:cat|head|tail|less|more|bat|strings|xxd|hexdump|od)\s+.*\/Users\/[^/]+\/\.config\/gh\//,
  /(?:cat|head|tail|less|more|bat|strings|xxd|hexdump|od)\s+.*\/Users\/[^/]+\/\.docker\/config\.json/,
  /(?:cat|head|tail|less|more|bat|strings|xxd|hexdump|od)\s+.*\/Users\/[^/]+\/\.kube\/config/,
  /(?:cat|head|tail|less|more|bat|strings|xxd|hexdump|od)\s+.*\/Users\/[^/]+\/\.gnupg\//,
  // Block env/printenv to prevent harvesting env vars
  /^\s*env\b/,
  /^\s*printenv\b/,
  /^\s*set\s*$/,
  /^\s*export\s+-p\s*$/,
  // Block sourcing/reading .env files outside workspace
  /(?:cat|source|\.)\s+.*\.env\b/,
];

// Paths that should never be written to (even if sandbox allows)
const BLOCKED_WRITE_PREFIXES = [
  '/etc/',
  '/usr/',
  '/bin/',
  '/sbin/',
  '/System/',
  '/Library/',
];

export function createToolPolicy(workspaceDir: string, channelId: string): HookCallback {
  function deny(tool: string, rawInput: Record<string, unknown>, reason: string) {
    writeAuditEntry({
      timestamp: new Date().toISOString(),
      channel: channelId,
      event: 'tool_denied',
      tool,
      input: summarizeDeniedInput(tool, rawInput),
      reason,
    });

    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse' as const,
        permissionDecision: 'deny' as const,
        permissionDecisionReason: reason,
      },
    };
  }

  return async (input) => {
    if (input.hook_event_name !== 'PreToolUse') return {};

    const toolInput = input as { tool_name: string; tool_input: Record<string, unknown> } & typeof input;
    const { tool_name } = toolInput;
    const rawInput = toolInput.tool_input || {};

    // --- Bash command policy ---
    if (tool_name === 'Bash') {
      const cmd = String(rawInput.command || '');

      for (const pattern of BLOCKED_COMMANDS) {
        if (pattern.test(cmd)) {
          return deny(tool_name, rawInput, `Blocked by policy: matches dangerous pattern ${pattern.source}`);
        }
      }

      for (const pattern of BLOCKED_CREDENTIAL_READS) {
        if (pattern.test(cmd)) {
          return deny(tool_name, rawInput, `Blocked by policy: credential/secret access pattern ${pattern.source}`);
        }
      }
    }

    // --- File write policy ---
    if (tool_name === 'Write' || tool_name === 'Edit') {
      const filePath = path.resolve(String(rawInput.file_path || ''));

      // Must write within the workspace
      if (!filePath.startsWith(workspaceDir) && !filePath.startsWith('/tmp/')) {
        return deny(tool_name, rawInput, `Writes restricted to workspace (${workspaceDir}) and /tmp/`);
      }

      // H-6: Protect CLAUDE.md from agent modification during execution
      if (path.basename(filePath) === 'CLAUDE.md') {
        return deny(tool_name, rawInput, 'CLAUDE.md is read-only during agent execution');
      }

      // Extra check: never write to system paths even if workspace is misconfigured
      for (const prefix of BLOCKED_WRITE_PREFIXES) {
        if (filePath.startsWith(prefix)) {
          return deny(tool_name, rawInput, `Cannot write to system path: ${prefix}`);
        }
      }
    }

    // --- Read policy: block sensitive paths ---
    if (tool_name === 'Read') {
      const filePath = path.resolve(String(rawInput.file_path || ''));
      const sensitivePatterns = [
        /\.ssh\/(id_|authorized_keys|known_hosts|config)/,
        /\.gnupg\//,
        /\.aws\/(credentials|config)/,
        /\.env$/,
        /credentials\.json$/,
        /\.npmrc$/,
        /\.netrc$/,
        /\.config\/gh\/hosts\.yml$/,
        /\.docker\/config\.json$/,
        /\.kube\/config$/,
        /\.gitconfig$/,
        /\/data\/audit\//,       // Audit logs (H-7)
        /\/data\/api-logs\//,    // API proxy logs (H-NEW-1)
        /\/data\/sessions\.json$/, // Session mappings (H-4)
      ];

      for (const pattern of sensitivePatterns) {
        if (pattern.test(filePath)) {
          return deny(tool_name, rawInput, `Cannot read sensitive file: ${filePath}`);
        }
      }
    }

    // Allow everything else
    return {};
  };
}

function summarizeDeniedInput(toolName: string, input: Record<string, unknown>): Record<string, unknown> {
  if (!input) return {};
  switch (toolName) {
    case 'Bash':
      return { command: String(input.command || '').slice(0, 500) };
    case 'Write':
    case 'Edit':
    case 'Read':
      return { file_path: input.file_path };
    default:
      return { keys: Object.keys(input) };
  }
}
