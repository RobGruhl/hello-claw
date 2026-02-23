/**
 * Heartbeat runner — periodic agent check-ins
 * Configurable schedule presets via HEARTBEAT_MODE: conservative (4/day), standard (8/day), off.
 */

import fs from 'fs';
import path from 'path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { AGENT_MODEL, BETAS, MAX_BUDGET_USD, MAX_DAILY_BUDGET_USD, HEARTBEAT_MODE } from './config.js';
import { acquireChannelLock } from './channel-lock.js';
import { buildSystemPrompt } from './system-prompt.js';
import { createToolPolicy } from '../hooks/tool-policy.js';
import { createAuditHook } from '../hooks/audit.js';
import { snapshotClaudeMd, checkClaudeMdIntegrity } from './integrity.js';
import { isPaused, setPaused } from './pause.js';
import { recordCost, formatCostSummary } from './cost-tracker.js';
import type { HookCallback } from '@anthropic-ai/claude-agent-sdk';

// Heartbeat schedule presets (Pacific Time)
const SCHEDULES: Record<string, { hour: number; minute: number }[]> = {
  conservative: [
    { hour: 8, minute: 0 },   // Morning
    { hour: 12, minute: 0 },  // Midday
    { hour: 18, minute: 0 },  // Evening
    { hour: 22, minute: 0 },  // Night
  ],
  standard: [
    { hour: 7, minute: 0 },   // Morning check-in
    { hour: 10, minute: 0 },  // Mid-morning
    { hour: 13, minute: 0 },  // After lunch
    { hour: 16, minute: 0 },  // Afternoon
    { hour: 19, minute: 0 },  // Evening
    { hour: 22, minute: 0 },  // Wind-down start
    { hour: 22, minute: 30 }, // Wind-down middle
    { hour: 23, minute: 0 },  // Wind-down end / go to bed
  ],
};

const HEARTBEAT_SCHEDULE = SCHEDULES[HEARTBEAT_MODE] || SCHEDULES.conservative;

let timer: ReturnType<typeof setTimeout> | undefined;

interface HeartbeatOptions {
  workDir: string;
  app: import('@slack/bolt').App;
  anthropicApiKey: string;
  channelId: string;
  userName?: string;
  mcpServers?: Record<string, unknown>;
}

/** Get current Pacific time components. */
function getPacificTime(): { hour: number; minute: number } {
  const now = new Date();
  const ptHour = parseInt(
    now.toLocaleString('en-US', { hour: 'numeric', hour12: false, timeZone: 'America/Los_Angeles' }),
    10,
  );
  const ptMin = parseInt(
    now.toLocaleString('en-US', { minute: 'numeric', timeZone: 'America/Los_Angeles' }),
    10,
  );
  return { hour: ptHour, minute: ptMin };
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

/** Calculate ms until the next scheduled beat. Returns { delayMs, beat }. */
function msUntilNextScheduledBeat(): { delayMs: number; beat: { hour: number; minute: number } } {
  const { hour: ptHour, minute: ptMin } = getPacificTime();
  const nowTotalMin = ptHour * 60 + ptMin;

  // Find the next beat after current time
  for (const beat of HEARTBEAT_SCHEDULE) {
    const beatTotalMin = beat.hour * 60 + beat.minute;
    if (beatTotalMin > nowTotalMin) {
      const diffMin = beatTotalMin - nowTotalMin;
      // Subtract current seconds/ms for precision
      const now = new Date();
      const sec = now.getSeconds();
      const ms = now.getMilliseconds();
      const delayMs = (diffMin * 60 - sec) * 1000 - ms;
      return { delayMs: Math.max(delayMs, 1000), beat };
    }
  }

  // No more beats today — next beat is tomorrow's first
  const firstBeat = HEARTBEAT_SCHEDULE[0];
  const firstBeatTotalMin = firstBeat.hour * 60 + firstBeat.minute;
  const diffMin = (24 * 60 - nowTotalMin) + firstBeatTotalMin;
  const now = new Date();
  const sec = now.getSeconds();
  const ms = now.getMilliseconds();
  const delayMs = (diffMin * 60 - sec) * 1000 - ms;
  return { delayMs: Math.max(delayMs, 1000), beat: firstBeat };
}

async function runHeartbeat(opts: HeartbeatOptions): Promise<void> {
  console.log(`[heartbeat] Tick at ${new Date().toISOString()}`);

  if (isPaused()) {
    console.log('[heartbeat] Skipping — agent is paused');
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

    // Compute wind-down status from Pacific time (10pm+ beats)
    const { hour: ptHour, minute: ptMin } = getPacificTime();
    const isWindDown = ptHour >= 22;

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
    let totalCostUsd = 0;
    let numTurns = 0;

    // Ephemeral session — always fresh, never resumed or stored.
    // Each heartbeat starts clean; files provide continuity, not conversation history.
    for await (const msg of query({
      prompt,
      options: {
        model: AGENT_MODEL,
        thinking: { type: 'adaptive' },
        effort: 'max',
        betas: ['code-execution-web-tools-2026-02-09' as any, ...BETAS],
        maxBudgetUsd: MAX_BUDGET_USD,
        systemPrompt: buildSystemPrompt(opts.workDir, opts.userName),
        cwd: opts.workDir,
        resume: undefined,
        env: { ...process.env, ANTHROPIC_API_KEY: opts.anthropicApiKey, ENABLE_TOOL_SEARCH: 'true' },
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
      if (msg.type === 'result') {
        const resultMsg = msg as any;
        totalCostUsd = resultMsg.total_cost_usd || 0;
        numTurns = resultMsg.num_turns || 0;
        if ('result' in resultMsg && resultMsg.result) {
          result = resultMsg.result as string;
        }
      }
    }

    // No session ID saved — heartbeat sessions are ephemeral
    checkClaudeMdIntegrity(claudeMdPath, claudeMdSnapshot, opts.channelId);

    if (totalCostUsd > 0) {
      const daily = recordCost({
        timestamp: new Date().toISOString(),
        source: 'heartbeat',
        channelId: opts.channelId,
        costUsd: totalCostUsd,
        numTurns,
      });
      console.log(`[heartbeat] Cost: $${totalCostUsd.toFixed(2)} (${numTurns} turns)`);

      // Post cost summary to Slack
      const summary = formatCostSummary(totalCostUsd, numTurns, daily.totalUsd);
      try {
        await opts.app.client.chat.postMessage({
          channel: opts.channelId,
          text: `_:heartpulse: ${summary}_`,
        });
      } catch { /* best-effort */ }

      // Budget alerts
      const halfBudget = MAX_DAILY_BUDGET_USD / 2;
      const prevTotal = daily.totalUsd - totalCostUsd;
      if (prevTotal < halfBudget && daily.totalUsd >= halfBudget) {
        try {
          await opts.app.client.chat.postMessage({
            channel: opts.channelId,
            text: `:warning: Daily cost at $${daily.totalUsd.toFixed(2)} — 50% of $${MAX_DAILY_BUDGET_USD} budget.`,
          });
        } catch { /* best-effort */ }
      }

      if (daily.totalUsd >= MAX_DAILY_BUDGET_USD) {
        setPaused(true, `daily budget exceeded ($${daily.totalUsd.toFixed(2)})`);
        try {
          await opts.app.client.chat.postMessage({
            channel: opts.channelId,
            text: `:octagonal_sign: *Auto-paused* — daily cost $${daily.totalUsd.toFixed(2)} exceeded $${MAX_DAILY_BUDGET_USD} budget. Send \`!unpause\` to resume.`,
          });
        } catch { /* best-effort */ }
      }
    }

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
  const { delayMs, beat } = msUntilNextScheduledBeat();
  const beatTime = `${beat.hour}:${String(beat.minute).padStart(2, '0')} PT`;
  console.log(`[heartbeat] Next beat: ${beatTime} (in ${Math.round(delayMs / 1000)}s)`);
  timer = setTimeout(() => {
    runHeartbeat(opts);
    scheduleNextTick(opts); // re-align each time — eliminates drift
  }, delayMs);
}

export function startHeartbeat(opts: HeartbeatOptions): void {
  if (timer) return; // Already running

  if (HEARTBEAT_MODE === 'off') {
    console.log('[heartbeat] Disabled (HEARTBEAT_MODE=off)');
    return;
  }

  const times = HEARTBEAT_SCHEDULE.map(b => `${b.hour}:${String(b.minute).padStart(2, '0')}`).join(', ');
  console.log(`[heartbeat] Starting — ${HEARTBEAT_MODE} schedule: ${times} PT (${HEARTBEAT_SCHEDULE.length} beats/day)`);

  // Don't fire immediately — just schedule the next beat.
  // Firing on startup causes heartbeat spam during rapid deploys.

  // Schedule next beat
  scheduleNextTick(opts);
}

export function stopHeartbeat(): void {
  if (timer) {
    clearTimeout(timer);
    timer = undefined;
    console.log('[heartbeat] Stopped');
  }
}
