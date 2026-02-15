/**
 * Cron MCP Server - In-process task scheduling
 * Runs in the host process (OUTSIDE the sandbox)
 *
 * When a scheduled task fires, it calls query() to run the agent with the task prompt.
 * Tasks require human approval via Slack reaction before they become active.
 */

import path from 'path';
import { createSdkMcpServer, tool, query } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { CronExpressionParser } from 'cron-parser';
import type { App } from '@slack/bolt';
import { getSessionId, saveSessionId } from '../lib/sessions.js';
import { createToolPolicy } from '../hooks/tool-policy.js';
import { createAuditHook } from '../hooks/audit.js';
import { snapshotClaudeMd, checkClaudeMdIntegrity } from '../lib/integrity.js';
import { acquireChannelLock } from '../lib/channel-lock.js';
import { writeAuditEntry } from '../lib/audit-log.js';
import { buildSystemPrompt } from '../lib/system-prompt.js';
import { AGENT_MODEL, BETAS, MAX_BUDGET_USD } from '../lib/config.js';
import { markdownToMrkdwn } from '../lib/mrkdwn.js';
import { createBrainMcp } from './brain.js';
import { createMediaMcp } from './media.js';
import { createSearchMcp } from './search.js';

const MAX_TASKS_PER_CHANNEL = 10;
const APPROVAL_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes
const PACIFIC_TZ = 'America/Los_Angeles';

export interface ScheduledTask {
  id: string;
  prompt: string;
  scheduleType: 'cron' | 'interval' | 'once';
  scheduleValue: string;
  channelId: string;
  workDir: string;
  createdAt: string;
  status: 'pending_approval' | 'active' | 'paused' | 'pending_cancellation';
  isRunning: boolean;
  timer?: ReturnType<typeof setTimeout> | ReturnType<typeof setInterval>;
  approvalMessageTs?: string;
  approvalTimeout?: ReturnType<typeof setTimeout>;
  cancellationMessageTs?: string;
  cancellationTimeout?: ReturnType<typeof setTimeout>;
  nextRun?: string;
}

/**
 * Parse human-readable duration strings into milliseconds.
 * Accepts "5m", "2h", "1h30m", "90s", or raw milliseconds ("300000").
 * Returns null if unparseable.
 */
export function parseDuration(input: string): number | null {
  const trimmed = input.trim();

  // Raw milliseconds
  if (/^\d+$/.test(trimmed)) {
    return parseInt(trimmed, 10);
  }

  const pattern = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/i;
  const match = trimmed.match(pattern);
  if (!match || (!match[1] && !match[2] && !match[3])) return null;

  const hours = parseInt(match[1] || '0', 10);
  const minutes = parseInt(match[2] || '0', 10);
  const seconds = parseInt(match[3] || '0', 10);

  return (hours * 3_600_000) + (minutes * 60_000) + (seconds * 1_000);
}

/**
 * Format milliseconds as a human-readable duration.
 */
function formatDuration(ms: number): string {
  if (ms >= 3_600_000) {
    const h = ms / 3_600_000;
    if (h === Math.floor(h)) return `${h} hour${h === 1 ? '' : 's'}`;
    // e.g. 1h30m
    const hours = Math.floor(h);
    const mins = Math.round((ms - hours * 3_600_000) / 60_000);
    return mins > 0 ? `${hours}h${mins}m` : `${hours} hour${hours === 1 ? '' : 's'}`;
  }
  if (ms >= 60_000) {
    const m = Math.round(ms / 60_000);
    return `${m} minute${m === 1 ? '' : 's'}`;
  }
  const s = Math.round(ms / 1_000);
  return `${s} second${s === 1 ? '' : 's'}`;
}

/**
 * Parse a `once` schedule value into a UTC ISO string.
 * - Relative: "in 5m", "in 2h", "in 1h30m" → computed from Date.now()
 * - Naive ISO (no offset/Z): interpreted as Pacific time
 * - Explicit offset or Z: used as-is
 * Returns { utcIso, error } — one will be set.
 */
export function parseOnceSchedule(input: string): { utcIso?: string; error?: string } {
  const trimmed = input.trim();

  // Relative delay: "in 5m", "in 2h30m"
  const relativeMatch = trimmed.match(/^in\s+(.+)$/i);
  if (relativeMatch) {
    const ms = parseDuration(relativeMatch[1]);
    if (!ms || ms < 60_000) {
      return { error: `Invalid relative delay: "${trimmed}". Use "in 5m", "in 2h", "in 1h30m" (minimum 1 minute).` };
    }
    return { utcIso: new Date(Date.now() + ms).toISOString() };
  }

  // Check if it's a valid date string at all
  const hasExplicitOffset = /Z$|[+-]\d{2}:\d{2}$/.test(trimmed);

  if (hasExplicitOffset) {
    const date = new Date(trimmed);
    if (isNaN(date.getTime())) {
      return { error: `Invalid timestamp: "${trimmed}".` };
    }
    return { utcIso: date.toISOString() };
  }

  // Naive ISO — interpret as Pacific time
  // Use Intl to find the current UTC offset for Pacific on the target date
  // Force UTC interpretation — prevent system timezone from
  // double-converting when we apply the Pacific offset below
  const naiveDate = new Date(trimmed + 'Z');
  if (isNaN(naiveDate.getTime())) {
    return { error: `Invalid timestamp: "${trimmed}". Use ISO format like "2026-02-08T15:30:00" or relative like "in 5m".` };
  }

  // Get the Pacific offset for this date (handles PST/PDT automatically)
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: PACIFIC_TZ,
    timeZoneName: 'shortOffset',
  });
  const parts = formatter.formatToParts(naiveDate);
  const offsetPart = parts.find(p => p.type === 'timeZoneName');
  // offsetPart.value is like "GMT-8" or "GMT-7"
  const offsetMatch = offsetPart?.value?.match(/GMT([+-]?\d+)/);
  const offsetHours = offsetMatch ? parseInt(offsetMatch[1], 10) : -8; // fallback PST

  // Construct the date with offset: naive time is Pacific, so subtract the offset to get UTC
  const offsetMs = offsetHours * 3_600_000;
  const utcMs = naiveDate.getTime() - offsetMs;
  return { utcIso: new Date(utcMs).toISOString() };
}

/** Format a time in Pacific for display. */
function formatPacificTime(date: Date): string {
  return date.toLocaleTimeString('en-US', {
    timeZone: PACIFIC_TZ,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZoneName: 'short',
  });
}

/** Human-friendly schedule description for Slack messages. */
export function formatScheduleDescription(scheduleType: string, scheduleValue: string): string {
  if (scheduleType === 'interval') {
    const ms = parseDuration(scheduleValue);
    if (!ms) return `interval ${scheduleValue}`;
    return `every ${formatDuration(ms)}`;
  }

  if (scheduleType === 'once') {
    const date = new Date(scheduleValue);
    if (isNaN(date.getTime())) return `once at ${scheduleValue}`;

    const now = new Date();
    // Compare dates in Pacific
    const dateInPacific = date.toLocaleDateString('en-US', { timeZone: PACIFIC_TZ });
    const nowInPacific = now.toLocaleDateString('en-US', { timeZone: PACIFIC_TZ });

    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const tomorrowInPacific = tomorrow.toLocaleDateString('en-US', { timeZone: PACIFIC_TZ });

    const time = formatPacificTime(date);

    if (dateInPacific === nowInPacific) return `later today at ${time}`;
    if (dateInPacific === tomorrowInPacific) return `tomorrow at ${time}`;

    const dayStr = date.toLocaleDateString('en-US', {
      timeZone: PACIFIC_TZ,
      weekday: 'short',
      month: 'short',
      day: 'numeric',
    });
    return `${dayStr} at ${time}`;
  }

  // cron — keep the expression but try to add a hint
  return `cron \`${scheduleValue}\``;
}

const tasks = new Map<string, ScheduledTask>();
let taskCounter = 0;

export interface CronSecrets {
  geminiApiKey?: string;
  perplexityApiKey?: string;
}

interface CronMcpOptions {
  channelId: string;
  app: App;
  anthropicApiKey: string;
  userName?: string;
  workDir: string;
}

function generateId(): string {
  return `task-${++taskCounter}`;
}

async function executeTask(task: ScheduledTask, app: App, anthropicApiKey: string, userName?: string, secrets?: CronSecrets): Promise<void> {
  // Skip if already running (prevents overlapping executions from interval/cron ticks)
  if (task.isRunning) {
    console.warn(`[cron] Skipping task ${task.id}: still running from previous tick`);
    return;
  }

  task.isRunning = true;
  console.log(`[cron] Executing task ${task.id}: ${task.prompt.slice(0, 50)}...`);

  // Acquire per-channel lock (shared with host.ts) to prevent session collisions
  const release = await acquireChannelLock(task.channelId);

  try {
    const workDir = task.workDir;
    const sessionId = getSessionId(task.channelId);

    // Snapshot CLAUDE.md before the scheduled agent runs
    const claudeMdPath = `${workDir}/CLAUDE.md`;
    const claudeMdSnapshot = snapshotClaudeMd(claudeMdPath);

    let result: string | null = null;
    let newSessionId: string | undefined;

    const nowTs = (Date.now() / 1000).toFixed(6);
    const friendly = new Date(parseFloat(nowTs) * 1000).toLocaleString('en-US', {
      timeZone: 'America/Los_Angeles', weekday: 'short', month: 'short', day: 'numeric',
      hour: 'numeric', minute: '2-digit', hour12: true, timeZoneName: 'short',
    });
    const scheduleDesc = formatScheduleDescription(task.scheduleType, task.scheduleValue);
    const name = userName || 'the user';
    const scheduledPrompt = `[SCHEDULED TASK ${task.id} - You are running automatically, not in response to a message from ${name}. Use mcp__slack__send_message to communicate with ${name}.]\n[TASK_ID: ${task.id}]\n[SCHEDULE: ${scheduleDesc}]\n[ts: ${nowTs} | ${friendly}]\nIf this task's goal is complete, use mcp__cron__cancel_self to stop it from running again.\n\n${task.prompt}`;

    for await (const msg of query({
      prompt: scheduledPrompt,
      options: {
        model: AGENT_MODEL,
        thinking: { type: 'adaptive' },
        effort: 'max',
        betas: [...BETAS],
        maxBudgetUsd: MAX_BUDGET_USD,
        systemPrompt: buildSystemPrompt(workDir, userName),
        cwd: workDir,
        resume: sessionId,
        env: { ...process.env, ANTHROPIC_API_KEY: anthropicApiKey },
        ...(sessionId ? {} : { plugins: [{ type: 'local' as const, path: path.resolve('plugins') }] }),
        allowedTools: [
          'Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep',
          'WebSearch', 'WebFetch',
          'mcp__slack__*',
          'mcp__cron__cancel_self',
          'mcp__cron__list_tasks',
          'mcp__second-brain__*',
          ...(secrets?.geminiApiKey ? ['mcp__media__*'] : []),
          ...(secrets?.perplexityApiKey ? ['mcp__search__*'] : []),
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
        mcpServers: {
          slack: createSlackMcpForTask(app, task.channelId),
          cron: createCronMcpForTask(task.id, task.channelId, app),
          'second-brain': createBrainMcp({ workDir, userName }),
          ...(secrets?.geminiApiKey ? { media: createMediaMcp({ geminiApiKey: secrets.geminiApiKey, workDir }) } : {}),
          ...(secrets?.perplexityApiKey ? { search: createSearchMcp({ perplexityApiKey: secrets.perplexityApiKey }) } : {}),
        },
        hooks: {
          PreToolUse: [{ hooks: [createToolPolicy(workDir, task.channelId)] }],
          PostToolUse: [{ hooks: [createAuditHook(task.channelId)] }],
        },
      },
    })) {
      if (msg.type === 'system' && msg.subtype === 'init') {
        newSessionId = msg.session_id;
      }
      if ('result' in msg && msg.result) {
        result = msg.result as string;
      }
    }

    if (newSessionId) saveSessionId(task.channelId, newSessionId);

    // Check CLAUDE.md integrity — restore if tampered
    checkClaudeMdIntegrity(claudeMdPath, claudeMdSnapshot, task.channelId);

    if (result) {
      console.log(`[cron] Task ${task.id} query() returned ${result.length} chars (discarded — agent must use send_message)`);
    }
  } catch (err) {
    console.error(`[cron] Task ${task.id} failed:`, err);
    // Notify the user in Slack so failures aren't invisible
    try {
      await app.client.chat.postMessage({
        channel: task.channelId,
        text: `Scheduled task "${task.id}" failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    } catch { /* best-effort notification */ }
  } finally {
    release();
    task.isRunning = false;

    // Remove one-time tasks after execution (guard: may have been self-cancelled during run)
    if (task.scheduleType === 'once' && tasks.has(task.id)) {
      tasks.delete(task.id);
    }
  }
}

// Minimal Slack MCP for scheduled task execution (avoids circular dep on full cron MCP)
function createSlackMcpForTask(app: App, channelId: string) {
  return createSdkMcpServer({
    name: 'slack',
    version: '1.0.0',
    tools: [
      tool('send_message', 'Send a message to the current Slack channel. Use Slack mrkdwn: *bold* _italic_ ~strike~ `code`. Not Markdown — no **bold**, [links](url), or # headings.', {
        text: z.string(),
      }, async (args) => {
        try {
          await app.client.chat.postMessage({
            channel: channelId,
            text: markdownToMrkdwn(args.text),
          });
          return { content: [{ type: 'text' as const, text: 'Message sent' }] };
        } catch (err) {
          return {
            content: [{ type: 'text' as const, text: `Failed to send message: ${err instanceof Error ? err.message : String(err)}` }],
            isError: true,
          };
        }
      }),
    ],
  });
}

// Scoped cron MCP for scheduled task execution — cancel_self + read-only list_tasks
function createCronMcpForTask(taskId: string, channelId: string, app: App) {
  return createSdkMcpServer({
    name: 'cron',
    version: '1.0.0',
    tools: [
      tool(
        'cancel_self',
        'Cancel this scheduled task immediately. Use when the task goal is complete and no further runs are needed. No approval required — the task stops itself.',
        {
          reason: z.string().optional().describe('Why the task is cancelling itself'),
        },
        async (args) => {
          const task = tasks.get(taskId);
          if (!task) {
            return { content: [{ type: 'text' as const, text: `Task ${taskId} already removed.` }] };
          }

          // Clear all timers
          if (task.timer) {
            clearTimeout(task.timer as ReturnType<typeof setTimeout>);
            clearInterval(task.timer as ReturnType<typeof setInterval>);
          }
          if (task.approvalTimeout) {
            clearTimeout(task.approvalTimeout);
          }
          if (task.cancellationTimeout) {
            clearTimeout(task.cancellationTimeout);
          }

          tasks.delete(taskId);
          console.log(`[cron] Task ${taskId} self-cancelled${args.reason ? `: ${args.reason}` : ''}`);

          // Audit
          writeAuditEntry({
            timestamp: new Date().toISOString(),
            channel: channelId,
            event: 'cron_task_self_cancelled',
            tool: 'cron__cancel_self',
            input: { task_id: taskId, reason: args.reason ?? null },
          });

          // Notify in Slack
          const reasonSuffix = args.reason ? ` — ${args.reason}` : '';
          try {
            await app.client.chat.postMessage({
              channel: channelId,
              text: `Task ${taskId} self-cancelled${reasonSuffix}.`,
            });
          } catch { /* best-effort */ }

          return { content: [{ type: 'text' as const, text: `Task ${taskId} cancelled. It will not run again.` }] };
        }
      ),

      tool(
        'list_tasks',
        'List scheduled tasks in this channel (read-only).',
        {},
        async () => {
          const channelTasks = Array.from(tasks.values()).filter(t => t.channelId === channelId);
          if (channelTasks.length === 0) {
            return { content: [{ type: 'text' as const, text: 'No scheduled tasks in this channel.' }] };
          }

          const statusLabel = (t: ScheduledTask): string => {
            if (t.status === 'pending_approval') return 'awaiting approval';
            if (t.status === 'pending_cancellation') return 'cancelling (awaiting approval)';
            return t.status;
          };

          const nextRunLabel = (t: ScheduledTask): string => {
            if (!t.nextRun) return '';
            const date = new Date(t.nextRun);
            if (isNaN(date.getTime())) return '';
            return ` | next: ${formatPacificTime(date)}`;
          };

          const lines = channelTasks.map(t => {
            const schedule = formatScheduleDescription(t.scheduleType, t.scheduleValue);
            const self = t.id === taskId ? ' ← this task' : '';
            return `- ${t.id} | ${schedule} | ${statusLabel(t)}${nextRunLabel(t)}${self}`;
          });

          return { content: [{ type: 'text' as const, text: `Scheduled tasks:\n${lines.join('\n')}` }] };
        }
      ),
    ],
  });
}

function startSchedule(task: ScheduledTask, app: App, anthropicApiKey: string, userName?: string, secrets?: CronSecrets): void {
  if (task.scheduleType === 'interval') {
    const ms = parseInt(task.scheduleValue, 10);
    task.timer = setInterval(() => {
      if (task.status === 'active' || task.status === 'pending_cancellation') executeTask(task, app, anthropicApiKey, userName, secrets);
    }, ms);
    task.nextRun = new Date(Date.now() + ms).toISOString();
  } else if (task.scheduleType === 'cron') {
    // Simple cron: check every minute if we should run
    const checkInterval = setInterval(() => {
      if (task.status !== 'active' && task.status !== 'pending_cancellation') return;
      try {
        const interval = CronExpressionParser.parse(task.scheduleValue);
        const next = interval.next().toDate();
        const now = new Date();
        // If next run is within the check window (60s), execute
        if (Math.abs(next.getTime() - now.getTime()) < 60_000) {
          executeTask(task, app, anthropicApiKey, userName, secrets);
        }
        task.nextRun = next.toISOString();
      } catch {
        // Invalid cron, skip
      }
    }, 60_000);
    task.timer = checkInterval;

    // Compute initial next run
    try {
      const interval = CronExpressionParser.parse(task.scheduleValue);
      task.nextRun = interval.next().toDate().toISOString();
    } catch {
      // will be caught on creation
    }
  } else if (task.scheduleType === 'once') {
    const runAt = new Date(task.scheduleValue);
    const delay = runAt.getTime() - Date.now();
    if (delay > 0) {
      task.timer = setTimeout(() => executeTask(task, app, anthropicApiKey, userName, secrets), delay);
      task.nextRun = runAt.toISOString();
    } else {
      // Already past, run on next tick so schedule_task returns promptly
      setTimeout(() => executeTask(task, app, anthropicApiKey, userName, secrets), 0);
    }
  }
}

// --- Exported helpers for host.ts reaction listener ---

/** Find a pending task by the Slack message ts used for the approval prompt. */
export function findPendingTaskByMessageTs(channelId: string, messageTs: string): ScheduledTask | undefined {
  for (const task of tasks.values()) {
    if (task.channelId === channelId && task.approvalMessageTs === messageTs && task.status === 'pending_approval') {
      return task;
    }
  }
  return undefined;
}

/** Approve a pending task: transition to active, start its schedule. */
export function activateTask(taskId: string, app: App, anthropicApiKey: string, userName?: string, secrets?: CronSecrets): boolean {
  const task = tasks.get(taskId);
  if (!task || task.status !== 'pending_approval') return false;

  if (task.approvalTimeout) {
    clearTimeout(task.approvalTimeout);
    task.approvalTimeout = undefined;
  }

  task.status = 'active';
  startSchedule(task, app, anthropicApiKey, userName, secrets);
  console.log(`[cron] Task ${task.id} approved and activated`);
  return true;
}

/** Reject a pending task: remove it entirely. */
export function rejectTask(taskId: string): boolean {
  const task = tasks.get(taskId);
  if (!task || task.status !== 'pending_approval') return false;

  if (task.approvalTimeout) {
    clearTimeout(task.approvalTimeout);
    task.approvalTimeout = undefined;
  }

  tasks.delete(taskId);
  console.log(`[cron] Task ${task.id} rejected and removed`);
  return true;
}

/** Find a task pending cancellation by the Slack message ts used for the cancellation prompt. */
export function findPendingCancellationByMessageTs(channelId: string, messageTs: string): ScheduledTask | undefined {
  for (const task of tasks.values()) {
    if (task.channelId === channelId && task.cancellationMessageTs === messageTs && task.status === 'pending_cancellation') {
      return task;
    }
  }
  return undefined;
}

/** Confirm cancellation: clear all timers, remove task. */
export function confirmCancellation(taskId: string): boolean {
  const task = tasks.get(taskId);
  if (!task || task.status !== 'pending_cancellation') return false;

  if (task.timer) {
    clearTimeout(task.timer as ReturnType<typeof setTimeout>);
    clearInterval(task.timer as ReturnType<typeof setInterval>);
  }
  if (task.cancellationTimeout) {
    clearTimeout(task.cancellationTimeout);
  }
  if (task.approvalTimeout) {
    clearTimeout(task.approvalTimeout);
  }

  tasks.delete(taskId);
  console.log(`[cron] Task ${taskId} cancellation confirmed — removed`);
  return true;
}

/** Reject cancellation: return task to active, clear cancellation fields. */
export function rejectCancellation(taskId: string): boolean {
  const task = tasks.get(taskId);
  if (!task || task.status !== 'pending_cancellation') return false;

  if (task.cancellationTimeout) {
    clearTimeout(task.cancellationTimeout);
    task.cancellationTimeout = undefined;
  }
  task.cancellationMessageTs = undefined;
  task.status = 'active';
  console.log(`[cron] Task ${taskId} cancellation rejected — remains active`);
  return true;
}

export function shutdownCron(): void {
  for (const task of tasks.values()) {
    if (task.timer) {
      clearTimeout(task.timer as ReturnType<typeof setTimeout>);
      clearInterval(task.timer as ReturnType<typeof setInterval>);
    }
    if (task.approvalTimeout) {
      clearTimeout(task.approvalTimeout);
    }
    if (task.cancellationTimeout) {
      clearTimeout(task.cancellationTimeout);
    }
  }
  tasks.clear();
}

export function createCronMcp({ channelId, app, anthropicApiKey, userName, workDir }: CronMcpOptions) {
  return createSdkMcpServer({
    name: 'cron',
    version: '1.0.0',
    tools: [
      tool(
        'schedule_task',
        `Schedule a recurring or one-time task. Requires human approval.
Types: cron (UTC), interval ("5m", "2h"), once ("in 5m" or timestamp).
See cron skill for schedule format details and timezone rules.`,
        {
          prompt: z.string().describe('What the agent should do when the task runs'),
          schedule_type: z.enum(['cron', 'interval', 'once']),
          schedule_value: z.string().describe('Cron expression (UTC), duration ("5m", "2h", "1h30m"), relative delay ("in 5m"), or timestamp (Pacific if no offset)'),
        },
        async (args) => {
          // Normalize schedule_value based on type
          let normalizedValue = args.schedule_value;

          if (args.schedule_type === 'cron') {
            try {
              CronExpressionParser.parse(args.schedule_value);
            } catch {
              return {
                content: [{ type: 'text' as const, text: `Invalid cron: "${args.schedule_value}". Use format like "0 9 * * *".` }],
                isError: true,
              };
            }
          } else if (args.schedule_type === 'interval') {
            const ms = parseDuration(args.schedule_value);
            if (!ms || ms < 60_000) {
              return {
                content: [{ type: 'text' as const, text: `Invalid interval: "${args.schedule_value}". Use "5m", "2h", "1h30m", or milliseconds. Minimum 1 minute.` }],
                isError: true,
              };
            }
            // Normalize to milliseconds string for startSchedule()
            normalizedValue = String(ms);
          } else if (args.schedule_type === 'once') {
            const parsed = parseOnceSchedule(args.schedule_value);
            if (parsed.error) {
              return {
                content: [{ type: 'text' as const, text: parsed.error }],
                isError: true,
              };
            }
            // Normalize to UTC ISO for startSchedule()
            normalizedValue = parsed.utcIso!;
          }

          // Rate limit: cap active tasks per channel
          const channelTaskCount = Array.from(tasks.values()).filter(t => t.channelId === channelId).length;
          if (channelTaskCount >= MAX_TASKS_PER_CHANNEL) {
            return {
              content: [{ type: 'text' as const, text: `Task limit reached (${MAX_TASKS_PER_CHANNEL} per channel). Cancel existing tasks first.` }],
              isError: true,
            };
          }

          const task: ScheduledTask = {
            id: generateId(),
            prompt: args.prompt,
            scheduleType: args.schedule_type,
            scheduleValue: normalizedValue,
            channelId,
            workDir,
            createdAt: new Date().toISOString(),
            status: 'pending_approval',
            isRunning: false,
          };

          tasks.set(task.id, task);

          // Post approval message to Slack
          const scheduleDesc = formatScheduleDescription(args.schedule_type, normalizedValue);

          try {
            const approvalMsg = await app.client.chat.postMessage({
              channel: channelId,
              text: [
                `:clock3: *Scheduled task requires approval*`,
                `*ID:* ${task.id}`,
                `*Schedule:* ${scheduleDesc}`,
                `*Task:* ${args.prompt}`,
                ``,
                `React with a :white_check_mark: checkmark to approve or :x: to reject. Auto-cancels in 15 minutes.`,
              ].join('\n'),
            });

            task.approvalMessageTs = approvalMsg.ts;
          } catch (err) {
            console.error(`[cron] Failed to post approval message for ${task.id}:`, err);
            tasks.delete(task.id);
            return {
              content: [{ type: 'text' as const, text: `Failed to post approval message: ${err instanceof Error ? err.message : String(err)}` }],
              isError: true,
            };
          }

          // Auto-cancel after 15 minutes if no response
          task.approvalTimeout = setTimeout(async () => {
            if (task.status !== 'pending_approval') return;

            tasks.delete(task.id);
            console.log(`[cron] Task ${task.id} expired (no approval within 15 minutes)`);

            writeAuditEntry({
              timestamp: new Date().toISOString(),
              channel: channelId,
              event: 'cron_task_expired',
              tool: 'cron__schedule_task',
              input: { task_id: task.id, prompt: args.prompt.slice(0, 200) },
            });

            try {
              await app.client.chat.postMessage({
                channel: channelId,
                text: `Task ${task.id} auto-cancelled — no approval received within 15 minutes.`,
              });
            } catch { /* best-effort */ }
          }, APPROVAL_TIMEOUT_MS);

          // Audit the request
          writeAuditEntry({
            timestamp: new Date().toISOString(),
            channel: channelId,
            event: 'cron_task_requested',
            tool: 'cron__schedule_task',
            input: {
              task_id: task.id,
              prompt: args.prompt.slice(0, 200),
              schedule_type: args.schedule_type,
              schedule_value: normalizedValue,
            },
          });

          return {
            content: [{
              type: 'text' as const,
              text: `Task ${task.id} created (${scheduleDesc}). Awaiting human approval — a checkmark reaction in Slack will activate it.`,
            }],
          };
        }
      ),

      tool(
        'list_tasks',
        'List all scheduled tasks with their IDs, schedules, and status.',
        {},
        async () => {
          if (tasks.size === 0) {
            return { content: [{ type: 'text' as const, text: 'No scheduled tasks.' }] };
          }

          const statusLabel = (t: ScheduledTask): string => {
            if (t.status === 'pending_approval') return 'awaiting approval';
            if (t.status === 'pending_cancellation') return 'cancelling (awaiting approval)';
            return t.status;
          };

          const nextRunLabel = (t: ScheduledTask): string => {
            if (!t.nextRun) return '';
            const date = new Date(t.nextRun);
            if (isNaN(date.getTime())) return '';
            return ` | next: ${formatPacificTime(date)}`;
          };

          const lines = Array.from(tasks.values()).map(t => {
            const schedule = formatScheduleDescription(t.scheduleType, t.scheduleValue);
            return `- ${t.id} | ${schedule} | ${statusLabel(t)}${nextRunLabel(t)}`;
          });

          return { content: [{ type: 'text' as const, text: `Scheduled tasks:\n${lines.join('\n')}` }] };
        }
      ),

      tool(
        'cancel_task',
        'Request cancellation of a scheduled task. Posts an approval message to Slack — a human must react with a checkmark to confirm. The task keeps running until cancellation is confirmed. Use list_tasks to find task IDs.',
        {
          task_id: z.string().describe('The task ID to cancel'),
        },
        async (args) => {
          const task = tasks.get(args.task_id);
          if (!task) {
            return {
              content: [{ type: 'text' as const, text: `Task ${args.task_id} not found.` }],
              isError: true,
            };
          }

          // Tasks still awaiting creation approval can be removed directly
          if (task.status === 'pending_approval') {
            if (task.timer) {
              clearTimeout(task.timer as ReturnType<typeof setTimeout>);
              clearInterval(task.timer as ReturnType<typeof setInterval>);
            }
            if (task.approvalTimeout) {
              clearTimeout(task.approvalTimeout);
            }
            tasks.delete(args.task_id);

            return { content: [{ type: 'text' as const, text: `Task ${args.task_id} removed (was awaiting approval).` }] };
          }

          if (task.status === 'pending_cancellation') {
            return {
              content: [{ type: 'text' as const, text: `Task ${args.task_id} is already pending cancellation.` }],
              isError: true,
            };
          }

          // Active task → require human approval for cancellation
          const scheduleDesc = formatScheduleDescription(task.scheduleType, task.scheduleValue);
          task.status = 'pending_cancellation';

          try {
            const cancelMsg = await app.client.chat.postMessage({
              channel: channelId,
              text: [
                `:wastebasket: *Task cancellation requires approval*`,
                `*ID:* ${task.id}`,
                `*Schedule:* ${scheduleDesc}`,
                `*Task:* ${task.prompt}`,
                ``,
                `React with a :white_check_mark: checkmark to confirm cancellation or :x: to keep the task running. Auto-reverts in 15 minutes.`,
              ].join('\n'),
            });

            task.cancellationMessageTs = cancelMsg.ts;
          } catch (err) {
            // Failed to post — revert status
            task.status = 'active';
            console.error(`[cron] Failed to post cancellation message for ${task.id}:`, err);
            return {
              content: [{ type: 'text' as const, text: `Failed to post cancellation approval message: ${err instanceof Error ? err.message : String(err)}` }],
              isError: true,
            };
          }

          // Auto-revert after 15 minutes if no response
          task.cancellationTimeout = setTimeout(async () => {
            if (task.status !== 'pending_cancellation') return;

            task.status = 'active';
            task.cancellationMessageTs = undefined;
            task.cancellationTimeout = undefined;
            console.log(`[cron] Task ${task.id} cancellation expired — reverted to active`);

            writeAuditEntry({
              timestamp: new Date().toISOString(),
              channel: channelId,
              event: 'cron_cancellation_expired',
              tool: 'cron__cancel_task',
              input: { task_id: task.id },
            });

            try {
              await app.client.chat.postMessage({
                channel: channelId,
                text: `Cancellation of task ${task.id} expired — no response within 15 minutes. Task remains active.`,
              });
            } catch { /* best-effort */ }
          }, APPROVAL_TIMEOUT_MS);

          writeAuditEntry({
            timestamp: new Date().toISOString(),
            channel: channelId,
            event: 'cron_cancellation_requested',
            tool: 'cron__cancel_task',
            input: { task_id: task.id },
          });

          return {
            content: [{
              type: 'text' as const,
              text: `Cancellation of task ${task.id} (${scheduleDesc}) requested. A human must react with a checkmark in Slack to confirm. The task continues running until then.`,
            }],
          };
        }
      ),
    ],
  });
}
