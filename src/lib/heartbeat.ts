/**
 * Heartbeat runner — periodic agent check-ins
 * Configurable schedule presets via HEARTBEAT_MODE: conservative (4/day), standard (8/day), off.
 */

import fs from 'fs';
import path from 'path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { AGENT_MODEL, AGENT_EFFORT, MAX_DAILY_BUDGET_USD, HEARTBEAT_MODE } from './config.js';
import { acquireChannelLock } from './channel-lock.js';
import { buildQueryOptions } from './query-config.js';
import { snapshotClaudeMd, checkClaudeMdIntegrity } from './integrity.js';
import { isPaused, setPaused } from './pause.js';
import { recordCost, formatCostSummary } from './cost-tracker.js';
import { nowInTz, friendlyTimestamp } from './timezone.js';
import type { HookCallback } from '@anthropic-ai/claude-agent-sdk';

/**
 * Heartbeat tiers — time-aware model routing.
 *
 * flagship: AGENT_MODEL at full effort. Used for the wakeup beat (fresh
 *   perspective on the day) and the wind-down beats (reflecting on what
 *   happened, consolidating memory). These are the beats where quality
 *   matters.
 * economy:  Sonnet at medium effort, capped turns. Midday check-ins are
 *   mostly "anything urgent? no? ok" — don't need Opus for that.
 */
type Tier = 'flagship' | 'economy';

interface Beat { hour: number; minute: number; tier: Tier }

const TIER_CONFIG: Record<Tier, { model: string; effort: 'low' | 'medium' | 'high' | 'max'; maxTurns: number }> = {
  flagship: { model: AGENT_MODEL,         effort: AGENT_EFFORT, maxTurns: 50 },
  economy:  { model: 'claude-sonnet-4-6', effort: 'medium',     maxTurns: 15 },
};

const SCHEDULES: Record<string, Beat[]> = {
  conservative: [
    { hour: 8,  minute: 0,  tier: 'flagship' },  // wakeup — fresh take on the day
    { hour: 12, minute: 0,  tier: 'economy'  },
    { hour: 18, minute: 0,  tier: 'economy'  },
    { hour: 22, minute: 0,  tier: 'flagship' },  // wind-down — reflect
  ],
  standard: [
    { hour: 7,  minute: 0,  tier: 'flagship' },  // wakeup
    { hour: 10, minute: 0,  tier: 'economy'  },
    { hour: 13, minute: 0,  tier: 'economy'  },
    { hour: 16, minute: 0,  tier: 'economy'  },
    { hour: 19, minute: 0,  tier: 'economy'  },
    { hour: 22, minute: 0,  tier: 'flagship' },  // last three: wind-down trilogy
    { hour: 22, minute: 30, tier: 'flagship' },  //   reflect on the day,
    { hour: 23, minute: 0,  tier: 'flagship' },  //   consolidate, go to bed
  ],
};

const HEARTBEAT_SCHEDULE: Beat[] = SCHEDULES[HEARTBEAT_MODE] || SCHEDULES.conservative;

let timer: ReturnType<typeof setTimeout> | undefined;

interface HeartbeatOptions {
  workDir: string;
  app: import('@slack/bolt').App;
  anthropicApiKey: string;
  channelId: string;
  userName?: string;
  mcpServers?: Record<string, unknown>;
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
function msUntilNextScheduledBeat(): { delayMs: number; beat: Beat } {
  const { hour, minute } = nowInTz();
  const nowTotalMin = hour * 60 + minute;

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

async function runHeartbeat(opts: HeartbeatOptions, beat: Beat): Promise<void> {
  const tier = TIER_CONFIG[beat.tier];
  console.log(`[heartbeat] Tick at ${new Date().toISOString()} — ${beat.tier} (${tier.model}, effort=${tier.effort})`);

  if (isPaused()) {
    console.log('[heartbeat] Skipping — agent is paused');
    return;
  }

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
    const isWindDown = beat.hour >= 22;

    const nowTs = (Date.now() / 1000).toFixed(6);

    const prompt = `[SCHEDULED HEARTBEAT — Running automatically, not responding to ${name}. Use mcp__slack__send_message only if you have something substantive to share.]

Whim: ${whim}
Wind-down: ${isWindDown}
Tier: ${beat.tier}
Use get_channel_history to check recent activity before deciding.
Full protocol in HEARTBEAT.md if needed.

[ts: ${nowTs} | ${friendlyTimestamp(nowTs)}]`;

    let totalCostUsd = 0;
    let numTurns = 0;

    // Ephemeral — always fresh, never resumed or stored. Files (MEMORY.md,
    // daily-logs/) provide continuity, not conversation history.
    for await (const msg of query({
      prompt,
      options: buildQueryOptions({
        workDir: opts.workDir,
        channelId: opts.channelId,
        anthropicApiKey: opts.anthropicApiKey,
        userName: opts.userName,
        sessionId: undefined,
        model: tier.model,
        effort: tier.effort,
        maxTurns: tier.maxTurns,
        allowedTools: [
          'Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'Task',
          'WebSearch', 'WebFetch',
          'mcp__slack__*', 'mcp__media__*', 'mcp__search__*',
          'mcp__second-brain__*',
          'mcp__audio__*',
        ],
        mcpServers: opts.mcpServers || {},
        extraPreHooks: [createHeartbeatFilter()],
      }),
    })) {
      const sub = 'subtype' in msg ? ` subtype=${(msg as any).subtype}` : '';
      console.log(`[heartbeat:sdk] type=${msg.type}${sub}`);
      if (msg.type === 'result') {
        const r = msg as any;
        totalCostUsd = r.total_cost_usd || 0;
        numTurns = r.num_turns || 0;
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

  } catch (err) {
    console.error(`[heartbeat] Error:`, err);
  } finally {
    release();
  }
}

function scheduleNextTick(opts: HeartbeatOptions): void {
  const { delayMs, beat } = msUntilNextScheduledBeat();
  const beatTime = `${beat.hour}:${String(beat.minute).padStart(2, '0')}`;
  console.log(`[heartbeat] Next beat: ${beatTime} ${beat.tier} (in ${Math.round(delayMs / 1000)}s)`);
  timer = setTimeout(async () => {
    // Await the beat before scheduling the next one — otherwise a slow beat
    // (oracle call, deep research) could overlap with the next tick.
    // msUntilNextScheduledBeat re-reads the clock after the beat finishes,
    // so we self-correct for however long the beat took.
    await runHeartbeat(opts, beat);
    scheduleNextTick(opts);
  }, delayMs);
}

export function startHeartbeat(opts: HeartbeatOptions): void {
  if (timer) return; // Already running

  if (HEARTBEAT_MODE === 'off') {
    console.log('[heartbeat] Disabled (HEARTBEAT_MODE=off)');
    return;
  }

  const times = HEARTBEAT_SCHEDULE.map(b => `${b.hour}:${String(b.minute).padStart(2, '0')}${b.tier[0]}`).join(' ');
  console.log(`[heartbeat] Starting — ${HEARTBEAT_MODE}: ${times} (${HEARTBEAT_SCHEDULE.length}/day, f=flagship e=economy)`);

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
