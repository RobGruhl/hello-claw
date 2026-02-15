/**
 * Heartbeat runner — periodic agent check-ins
 * Runs every 30 minutes during active hours (08:00–23:00 Pacific).
 */

import fs from 'fs';
import path from 'path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { AGENT_MODEL, BETAS, MAX_BUDGET_USD } from './config.js';
import { acquireChannelLock } from './channel-lock.js';
import { buildSystemPrompt } from './system-prompt.js';
import { createToolPolicy } from '../hooks/tool-policy.js';
import { createAuditHook } from '../hooks/audit.js';
import { snapshotClaudeMd, checkClaudeMdIntegrity } from './integrity.js';
import type { HookCallback } from '@anthropic-ai/claude-agent-sdk';

const ACTIVE_START_HOUR = 7;  // 07:00 Pacific
const ACTIVE_END_HOUR = 24;   // midnight Pacific

let timer: ReturnType<typeof setTimeout> | undefined;

interface HeartbeatOptions {
  workDir: string;
  app: import('@slack/bolt').App;
  anthropicApiKey: string;
  channelId: string;
  userName?: string;
  mcpServers?: Record<string, unknown>;
}

function isActiveHour(): boolean {
  const now = new Date();
  // Get Pacific time hour
  const ptHour = parseInt(
    now.toLocaleString('en-US', { hour: 'numeric', hour12: false, timeZone: 'America/Los_Angeles' }),
    10,
  );
  return ptHour >= ACTIVE_START_HOUR && ptHour < ACTIVE_END_HOUR;
}

export function isHeartbeatContentEffectivelyEmpty(content: string): boolean {
  const stripped = content.replace(/\s+/g, ' ').trim().toLowerCase();
  return stripped.length <= 300 && /heartbeat.?ok/i.test(stripped);
}

function createHeartbeatFilter(): HookCallback {
  return async (input) => {
    if (input.hook_event_name !== 'PreToolUse') return {};

    const toolInput = input as { tool_name: string; tool_input: Record<string, unknown> } & typeof input;
    if (toolInput.tool_name === 'mcp__slack__send_message') {
      const text = String(toolInput.tool_input?.text || '');
      if (isHeartbeatContentEffectivelyEmpty(text)) {
        return {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse' as const,
            permissionDecision: 'deny' as const,
            permissionDecisionReason: 'Heartbeat ack suppressed — only send substantive content to Slack.',
          },
        };
      }
    }
    return {};
  };
}

function msUntilNextHalfHour(): number {
  const now = new Date();
  const min = now.getMinutes();
  const sec = now.getSeconds();
  const ms = now.getMilliseconds();
  const minutesUntil = min < 30 ? 30 - min : 60 - min;
  return (minutesUntil * 60 - sec) * 1000 - ms;
}

async function runHeartbeat(opts: HeartbeatOptions): Promise<void> {
  console.log(`[heartbeat] Tick at ${new Date().toISOString()}`);

  if (!isActiveHour()) {
    const ptHour = parseInt(
      new Date().toLocaleString('en-US', { hour: 'numeric', hour12: false, timeZone: 'America/Los_Angeles' }),
      10,
    );
    console.log(`[heartbeat] Skipping — outside active hours (PT hour: ${ptHour})`);
    return;
  }

  // Check HEARTBEAT.md exists (agent can read it from disk if needed)
  const heartbeatMd = path.join(opts.workDir, 'HEARTBEAT.md');
  if (!fs.existsSync(heartbeatMd)) {
    console.log('[heartbeat] Skipping — no HEARTBEAT.md');
    return;
  }

  const release = await acquireChannelLock(opts.channelId);

  try {
    const claudeMdPath = `${opts.workDir}/CLAUDE.md`;
    const claudeMdSnapshot = snapshotClaudeMd(claudeMdPath);

    const name = opts.userName || 'the user';
    // Whim: random 000–999 injected as creative entropy. The agent's HEARTBEAT.md
    // maps ranges to behavioral suggestions (curiosity, reflection, playful, quiet, etc.)
    // so periodic check-ins feel varied rather than repetitive.
    const whim = String(Math.floor(Math.random() * 1000)).padStart(3, '0');

    // Compute wind-down status from Pacific time
    const ptHour = parseInt(
      new Date().toLocaleString('en-US', { hour: 'numeric', hour12: false, timeZone: 'America/Los_Angeles' }),
      10,
    );
    const ptMin = parseInt(
      new Date().toLocaleString('en-US', { minute: 'numeric', timeZone: 'America/Los_Angeles' }),
      10,
    );
    const isWindDown = (ptHour === 22 && ptMin >= 30) || ptHour >= 23;

    const nowTs = (Date.now() / 1000).toFixed(6);
    const friendly = new Date(parseFloat(nowTs) * 1000).toLocaleString('en-US', {
      timeZone: 'America/Los_Angeles', weekday: 'short', month: 'short', day: 'numeric',
      hour: 'numeric', minute: '2-digit', hour12: true, timeZoneName: 'short',
    });

    const prompt = `[SCHEDULED HEARTBEAT — Running automatically, not responding to ${name}. Use mcp__slack__send_message only if you have something substantive to share.]

Whim: ${whim}
Wind-down: ${isWindDown}
Use get_channel_history to check recent activity before deciding.
Full protocol in HEARTBEAT.md if needed.

[ts: ${nowTs} | ${friendly}]`;

    let result: string | null = null;

    // Ephemeral session — always fresh, never resumed or stored.
    // Each heartbeat starts clean; files provide continuity, not conversation history.
    for await (const msg of query({
      prompt,
      options: {
        model: AGENT_MODEL,
        thinking: { type: 'adaptive' },
        effort: 'max',
        betas: [...BETAS],
        maxBudgetUsd: MAX_BUDGET_USD,
        systemPrompt: buildSystemPrompt(opts.workDir, opts.userName),
        cwd: opts.workDir,
        resume: undefined,
        env: { ...process.env, ANTHROPIC_API_KEY: opts.anthropicApiKey },
        plugins: [{ type: 'local' as const, path: path.resolve('plugins') }],
        allowedTools: [
          'Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep',
          'WebSearch', 'WebFetch',
          'mcp__slack__*', 'mcp__media__*', 'mcp__search__*',
          'mcp__second-brain__*',
          'mcp__audio__*',
        ],
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        settingSources: ['project'],
        sandbox: {
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
        },
        mcpServers: opts.mcpServers as any,
        hooks: {
          PreToolUse: [{ hooks: [createToolPolicy(opts.workDir, opts.channelId), createHeartbeatFilter()] }],
          PostToolUse: [{ hooks: [createAuditHook(opts.channelId)] }],
        },
      },
    })) {
      const sub = 'subtype' in msg ? ` subtype=${(msg as any).subtype}` : '';
      console.log(`[heartbeat:sdk] type=${msg.type}${sub}`);
      if ('result' in msg && msg.result) {
        result = msg.result as string;
      }
    }

    // No session ID saved — heartbeat sessions are ephemeral
    checkClaudeMdIntegrity(claudeMdPath, claudeMdSnapshot, opts.channelId);

    if (result) {
      console.log(`[heartbeat] query() returned ${result.length} chars (discarded — agent must use send_message)`);
    }
  } catch (err) {
    console.error(`[heartbeat] Error:`, err);
  } finally {
    release();
  }
}

function scheduleNextTick(opts: HeartbeatOptions): void {
  const delay = msUntilNextHalfHour();
  console.log(`[heartbeat] Next tick in ${Math.round(delay / 1000)}s (at ${new Date(Date.now() + delay).toISOString()})`);
  timer = setTimeout(() => {
    runHeartbeat(opts);
    scheduleNextTick(opts); // re-align each time — eliminates drift
  }, delay);
}

export function startHeartbeat(opts: HeartbeatOptions): void {
  if (timer) return; // Already running
  console.log(`[heartbeat] Starting — at :00/:30, active hours ${ACTIVE_START_HOUR}:00–${ACTIVE_END_HOUR === 24 ? '0' : ACTIVE_END_HOUR}:00 PT`);

  // Fire immediately on startup
  runHeartbeat(opts);

  // Schedule next tick aligned to :00 or :30, re-aligning after each tick
  scheduleNextTick(opts);
}

export function stopHeartbeat(): void {
  if (timer) {
    clearTimeout(timer);
    timer = undefined;
    console.log('[heartbeat] Stopped');
  }
}
