/**
 * hello-claw - Host Process
 * Slack listener + Agent SDK query() orchestration
 */

import fs from 'fs';
import path from 'path';
import { App, LogLevel } from '@slack/bolt';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { createSlackMcp } from './mcp/slack.js';
import { createCronMcp, shutdownCron, findPendingTaskByMessageTs, activateTask, rejectTask, findPendingCancellationByMessageTs, confirmCancellation, rejectCancellation, formatScheduleDescription, type ScheduledTask, type CronSecrets } from './mcp/cron.js';
import { createMediaMcp } from './mcp/media.js';
import { createSearchMcp } from './mcp/search.js';
import { createBrainMcp } from './mcp/brain.js';
import { createGithubMcp, findPendingWriteByMessageTs, approveWrite, rejectWrite, shutdownGithub } from './mcp/github.js';
import { createOracleMcp } from './mcp/oracle.js';
import { createVoiceMcp } from './mcp/voice.js';
import { createAudioMcp } from './mcp/audio.js';
import { createToolPolicy } from './hooks/tool-policy.js';
import { createAuditHook } from './hooks/audit.js';
import { getSessionId, saveSessionId } from './lib/sessions.js';
import { ensureWorkspace } from './lib/workspace.js';
import { snapshotClaudeMd, checkClaudeMdIntegrity } from './lib/integrity.js';
import { acquireChannelLock } from './lib/channel-lock.js';
import { writeAuditEntry } from './lib/audit-log.js';
import { buildSystemPrompt } from './lib/system-prompt.js';
import { AGENT_MODEL, BETAS, MAX_BUDGET_USD } from './lib/config.js';
import { startHeartbeat, stopHeartbeat } from './lib/heartbeat.js';
import { startApiProxy, stopApiProxy } from './lib/api-proxy.js';

// --- Capture and strip sensitive env vars ---
// MCP servers (running in the host process) need these values,
// but the sandboxed agent subprocess must NOT see them via `env`/`printenv`.
const SECRETS = {
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY!,
  SLACK_BOT_TOKEN: process.env.SLACK_BOT_TOKEN!,
  SLACK_APP_TOKEN: process.env.SLACK_APP_TOKEN!,
  GEMINI_API_KEY: process.env.GEMINI_API_KEY || '',
  PERPLEXITY_API_KEY: process.env.PERPLEXITY_API_KEY || '',
  GH_TOKEN: process.env.GH_TOKEN || '',
  OPENAI_API_KEY: process.env.OPENAI_API_KEY || '',
  ELEVENLABS_API_KEY: process.env.ELEVENLABS_API_KEY || '',
};

// Validate required secrets are present before stripping
for (const key of ['ANTHROPIC_API_KEY', 'SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN'] as const) {
  if (!SECRETS[key]) {
    console.error(`[host] Missing required env var: ${key}`);
    process.exit(1);
  }
}

// Strip secrets from process.env so sandboxed subprocesses can't read them
delete process.env.SLACK_BOT_TOKEN;
delete process.env.SLACK_APP_TOKEN;
delete process.env.GEMINI_API_KEY;
delete process.env.PERPLEXITY_API_KEY;
delete process.env.GH_TOKEN;
delete process.env.OPENAI_API_KEY;
delete process.env.ELEVENLABS_API_KEY;
// ANTHROPIC_API_KEY is passed explicitly to query() via `env` option,
// then stripped so sandboxed Bash can't `env | grep KEY`
delete process.env.ANTHROPIC_API_KEY;

// Non-secret config (safe to leave in process.env)
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || '';

// Enable experimental features for the SDK subprocess
process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = '1';
process.env.CLAUDE_CODE_STREAM_CLOSE_TIMEOUT = '1500000'; // 25 min for oracle (background mode takes 5-15 min)

// --- Agent and human identity ---
const agentName = process.env.AGENT_NAME || 'Agent';
const userName = process.env.USER_NAME || 'the user';

// --- Shared workspace (all channels use the same identity) ---
const workDir = ensureWorkspace();

function readFileOrEmpty(filePath: string): string {
  try {
    return fs.readFileSync(filePath, 'utf-8').trim();
  } catch {
    return '';
  }
}

function buildSessionBanner(channelId: string, sessionType: 'fresh' | 'resumed'): string {
  const now = new Date();
  const datePart = now.toLocaleDateString('en-US', {
    timeZone: 'America/Los_Angeles',
    weekday: 'long', month: 'long', day: 'numeric',
  });
  const timePart = now.toLocaleTimeString('en-US', {
    timeZone: 'America/Los_Angeles',
    hour: 'numeric', minute: '2-digit', hour12: true,
  });

  const greeting = sessionType === 'fresh'
    ? `Welcome back ${agentName}, it's ${datePart} at ${timePart} Pacific Time. This is a fresh session.`
    : `Welcome back ${agentName}, it's ${datePart} at ${timePart} Pacific Time. Resuming your previous session.`;

  return `[SESSION CONTEXT]\n${greeting}\nYour cognition is provided by ${AGENT_MODEL} with adaptive thinking, max effort, and 1M context window.\nChannel: ${channelId}`;
}

const app = new App({
  token: SECRETS.SLACK_BOT_TOKEN,
  appToken: SECRETS.SLACK_APP_TOKEN,
  socketMode: true,
  logLevel: LogLevel.INFO,
});

app.message(async ({ message, say }) => {
  // Skip bot messages and edits, but allow file_share subtype (user sent image with text)
  if (message.subtype && message.subtype !== 'file_share') return;

  const text = ('text' in message ? message.text : '') || '';
  const files = ('files' in message ? (message as any).files : undefined) as Array<{
    id: string; name?: string; mimetype?: string; size?: number;
  }> | undefined;

  if (!text && (!files || files.length === 0)) return;

  const messageTs = ('ts' in message ? message.ts : '') || '';

  const friendly = (ts: string) => new Date(parseFloat(ts) * 1000).toLocaleString('en-US', {
    timeZone: 'America/Los_Angeles', weekday: 'short', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true, timeZoneName: 'short',
  });
  let prompt = text;
  if (messageTs) {
    prompt += `\n\n[ts: ${messageTs} | ${friendly(messageTs)}]`;
  } else {
    const nowTs = (Date.now() / 1000).toFixed(6);
    prompt += `\n\n[ts: ${nowTs} | ${friendly(nowTs)}]`;
  }
  if (files && files.length > 0) {
    const sanitizeName = (name: string | undefined): string => {
      if (!name) return 'unnamed';
      // Strip newlines, control chars, and cap length to prevent filename injection (H-11)
      return name.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 120);
    };
    const fileList = files.map(f =>
      `- file_id: ${f.id}, name: ${sanitizeName(f.name)}, type: ${f.mimetype || 'unknown'}, size: ${f.size || 0} bytes`
    ).join('\n');
    prompt += `\n\n[ATTACHED FILES]\nThe user attached files to this message. Use mcp__slack__download_file to retrieve any you need.\n${fileList}`;
  }

  const channelId = message.channel;

  // Acquire per-channel lock (shared with cron) to prevent session collisions
  const release = await acquireChannelLock(channelId);

  try {
    const sessionId = getSessionId(channelId);
    const sessionType = sessionId ? 'resumed' : 'fresh';
    const banner = buildSessionBanner(channelId, sessionType);

    if (!sessionId) {
      const memory = readFileOrEmpty(path.join(workDir, 'MEMORY.md'));
      const memoryBlock = memory ? `\nLong-term memory follows.\n\n${memory}\n` : '';
      prompt = `${banner}\n${memoryBlock}\n[END SESSION CONTEXT]\n\n${prompt}`;
    } else {
      prompt = `${banner}\n[END SESSION CONTEXT]\n\n${prompt}`;
    }

    const slackMcp = createSlackMcp({ app, channelId, workspaceDir: workDir });
    const cronMcp = createCronMcp({ channelId, app, anthropicApiKey: SECRETS.ANTHROPIC_API_KEY, userName, workDir });
    const mediaMcp = createMediaMcp({ geminiApiKey: SECRETS.GEMINI_API_KEY, workDir });
    const searchMcp = createSearchMcp({ perplexityApiKey: SECRETS.PERPLEXITY_API_KEY });
    const brainMcp = createBrainMcp({ workDir, userName });
    const githubMcp = createGithubMcp({ ghToken: SECRETS.GH_TOKEN, app, channelId });
    const oracleMcp = createOracleMcp({ openaiApiKey: SECRETS.OPENAI_API_KEY });
    const voiceMcp = createVoiceMcp({ elevenlabsApiKey: SECRETS.ELEVENLABS_API_KEY, workDir, defaultVoiceId: ELEVENLABS_VOICE_ID });
    const audioMcp = createAudioMcp({ openaiApiKey: SECRETS.OPENAI_API_KEY, workDir });

    // Snapshot CLAUDE.md before the agent runs to detect tampering
    const claudeMdPath = `${workDir}/CLAUDE.md`;
    const claudeMdSnapshot = snapshotClaudeMd(claudeMdPath);

    let result: string | null = null;
    let newSessionId: string | undefined;

    for await (const msg of query({
      prompt,
      options: {
        model: AGENT_MODEL,
        thinking: { type: 'adaptive' },
        effort: 'max',
        betas: [...BETAS],
        maxBudgetUsd: MAX_BUDGET_USD,
        systemPrompt: buildSystemPrompt(workDir, userName),
        cwd: workDir,
        resume: sessionId,
        env: { ...process.env, ANTHROPIC_API_KEY: SECRETS.ANTHROPIC_API_KEY },
        ...(sessionId ? {} : { plugins: [{ type: 'local' as const, path: path.resolve('plugins') }] }),
        allowedTools: [
          'Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep',
          'WebSearch', 'WebFetch',
          'mcp__slack__*', 'mcp__cron__*', 'mcp__media__*', 'mcp__search__*',
          'mcp__second-brain__*',
          'mcp__github__*',
          'mcp__oracle__*',
          'mcp__voice__*',
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
        mcpServers: {
          slack: slackMcp,
          cron: cronMcp,
          media: mediaMcp,
          search: searchMcp,
          'second-brain': brainMcp,
          github: githubMcp,
          oracle: oracleMcp,
          voice: voiceMcp,
          audio: audioMcp,
        },
        hooks: {
          PreToolUse: [{ hooks: [createToolPolicy(workDir, channelId)] }],
          PostToolUse: [{ hooks: [createAuditHook(channelId)] }],
        },
      },
    })) {
      const sub = 'subtype' in msg ? ` subtype=${(msg as any).subtype}` : '';
      console.log(`[host:sdk] type=${msg.type}${sub}`);
      if (msg.type === 'system' && msg.subtype === 'init') {
        newSessionId = msg.session_id;
      }
      if ('result' in msg && msg.result) {
        result = msg.result as string;
      }
    }

    if (newSessionId) saveSessionId(channelId, newSessionId);

    // Check CLAUDE.md integrity — restore if tampered
    checkClaudeMdIntegrity(claudeMdPath, claudeMdSnapshot, channelId);

    if (result) {
      console.log(`[host] query() returned ${result.length} chars (discarded — agent must use send_message)`);
    }
  } catch (err) {
    console.error(`[host] Error processing message in ${channelId}:`, err);
    const errMsg = err instanceof Error ? err.message : String(err);
    await say(`:warning: Error processing that request: ${errMsg}`);
  } finally {
    release();
  }
});

// --- Cron task approval via Slack reactions ---
let botUserId: string | undefined;

const APPROVAL_EMOJIS = new Set([
  'white_check_mark',      // ✅
  'heavy_check_mark',      // ✔️
  'ballot_box_with_check', // ☑️
  'check',                 // common workspace custom emoji
]);

const REJECTION_EMOJIS = new Set(['x']);

app.event('reaction_added', async ({ event }) => {
  const reaction = event.reaction;
  const isApproval = APPROVAL_EMOJIS.has(reaction);
  const isRejection = REJECTION_EMOJIS.has(reaction);

  console.log(`[host:reaction] Emoji received: ${reaction} from user ${event.user}`);

  if (!isApproval && !isRejection) {
    // Log near-miss emojis that might indicate user confusion
    if (/check|tick/i.test(reaction)) {
      console.log(`[host:reaction] Unrecognized checkmark-like emoji: ${reaction} — not in APPROVAL_EMOJIS set`);
    }
    return;
  }

  // Only handle reactions on messages (not files, etc.)
  if (event.item.type !== 'message') {
    console.log(`[host:reaction] Skipped: item type is "${event.item.type}", not "message"`);
    return;
  }

  // Reject bot self-reactions (the agent cannot approve its own tasks)
  if (botUserId && event.user === botUserId) {
    console.log(`[host:reaction] Skipped: bot self-reaction (user ${event.user} = bot ${botUserId})`);
    return;
  }

  const channelId = event.item.channel;
  const messageTs = event.item.ts;

  // --- Check 1: Creation approval ---
  const pendingTask = findPendingTaskByMessageTs(channelId, messageTs);
  if (pendingTask) {
    console.log(`[host:reaction] Found pending task ${pendingTask.id} for channel=${channelId} messageTs=${messageTs}`);

    if (isApproval) {
      const cronSecrets: CronSecrets = {
        geminiApiKey: SECRETS.GEMINI_API_KEY || undefined,
        perplexityApiKey: SECRETS.PERPLEXITY_API_KEY || undefined,
      };
      const activated = activateTask(pendingTask.id, app, SECRETS.ANTHROPIC_API_KEY, userName, cronSecrets);
      if (activated) {
        console.log(`[host:reaction] Task ${pendingTask.id} approved and activated by user ${event.user}`);
        writeAuditEntry({
          timestamp: new Date().toISOString(),
          channel: channelId,
          event: 'cron_task_approved',
          tool: 'cron__schedule_task',
          input: { task_id: pendingTask.id, approved_by: event.user },
        });
        try {
          const scheduleDesc = formatScheduleDescription(pendingTask.scheduleType, pendingTask.scheduleValue);
          const promptPreview = pendingTask.prompt.length > 100
            ? pendingTask.prompt.slice(0, 100) + '...'
            : pendingTask.prompt;
          await app.client.chat.postMessage({
            channel: channelId,
            text: [
              `:white_check_mark: *Task ${pendingTask.id} approved and activated*`,
              `*Schedule:* ${scheduleDesc}`,
              `*Task:* ${promptPreview}`,
            ].join('\n'),
          });
        } catch { /* best-effort */ }
      }
    } else {
      const rejected = rejectTask(pendingTask.id);
      if (rejected) {
        console.log(`[host:reaction] Task ${pendingTask.id} rejected by user ${event.user}`);
        writeAuditEntry({
          timestamp: new Date().toISOString(),
          channel: channelId,
          event: 'cron_task_rejected',
          tool: 'cron__schedule_task',
          input: { task_id: pendingTask.id, rejected_by: event.user },
        });
        try {
          await app.client.chat.postMessage({
            channel: channelId,
            text: `Task ${pendingTask.id} rejected and removed.`,
          });
        } catch { /* best-effort */ }
      }
    }
    return; // Handled creation approval — don't double-match
  }

  // --- Check 2: Cancellation approval ---
  const cancellingTask = findPendingCancellationByMessageTs(channelId, messageTs);
  if (cancellingTask) {
    console.log(`[host:reaction] Found pending cancellation for task ${cancellingTask.id} channel=${channelId} messageTs=${messageTs}`);

    if (isApproval) {
      const scheduleDesc = formatScheduleDescription(cancellingTask.scheduleType, cancellingTask.scheduleValue);
      const confirmed = confirmCancellation(cancellingTask.id);
      if (confirmed) {
        console.log(`[host:reaction] Task ${cancellingTask.id} cancellation confirmed by user ${event.user}`);
        writeAuditEntry({
          timestamp: new Date().toISOString(),
          channel: channelId,
          event: 'cron_cancellation_confirmed',
          tool: 'cron__cancel_task',
          input: { task_id: cancellingTask.id, confirmed_by: event.user },
        });
        try {
          await app.client.chat.postMessage({
            channel: channelId,
            text: `:wastebasket: Task ${cancellingTask.id} (${scheduleDesc}) cancelled and removed.`,
          });
        } catch { /* best-effort */ }
      }
    } else {
      const scheduleDesc = formatScheduleDescription(cancellingTask.scheduleType, cancellingTask.scheduleValue);
      const rejected = rejectCancellation(cancellingTask.id);
      if (rejected) {
        console.log(`[host:reaction] Task ${cancellingTask.id} cancellation rejected by user ${event.user}`);
        writeAuditEntry({
          timestamp: new Date().toISOString(),
          channel: channelId,
          event: 'cron_cancellation_rejected',
          tool: 'cron__cancel_task',
          input: { task_id: cancellingTask.id, rejected_by: event.user },
        });
        try {
          await app.client.chat.postMessage({
            channel: channelId,
            text: `Cancellation of task ${cancellingTask.id} (${scheduleDesc}) rejected — task remains active.`,
          });
        } catch { /* best-effort */ }
      }
    }
    return;
  }

  // --- Check 3: GitHub write approval ---
  const pendingWrite = findPendingWriteByMessageTs(channelId, messageTs);
  if (pendingWrite) {
    console.log(`[host:reaction] Found pending GitHub write ${pendingWrite.id} for channel=${channelId} messageTs=${messageTs}`);

    if (isApproval) {
      try {
        const result = await approveWrite(pendingWrite.id, SECRETS.GH_TOKEN);
        console.log(`[host:reaction] GitHub write ${pendingWrite.id} approved by user ${event.user}`);
        writeAuditEntry({
          timestamp: new Date().toISOString(),
          channel: channelId,
          event: 'github_write_approved',
          tool: `github__${pendingWrite.type}`,
          input: { write_id: pendingWrite.id, approved_by: event.user },
        });
        try {
          await app.client.chat.postMessage({
            channel: channelId,
            text: `:white_check_mark: *GitHub write ${pendingWrite.id} approved*\n${result.output}`,
          });
        } catch { /* best-effort */ }
      } catch (err) {
        console.error(`[host:reaction] GitHub write ${pendingWrite.id} execution failed:`, err);
        try {
          await app.client.chat.postMessage({
            channel: channelId,
            text: `:warning: GitHub write ${pendingWrite.id} approved but execution failed: ${err instanceof Error ? err.message : String(err)}`,
          });
        } catch { /* best-effort */ }
      }
    } else {
      const rejected = rejectWrite(pendingWrite.id);
      if (rejected) {
        console.log(`[host:reaction] GitHub write ${pendingWrite.id} rejected by user ${event.user}`);
        writeAuditEntry({
          timestamp: new Date().toISOString(),
          channel: channelId,
          event: 'github_write_rejected',
          tool: `github__${pendingWrite.type}`,
          input: { write_id: pendingWrite.id, rejected_by: event.user },
        });
        try {
          await app.client.chat.postMessage({
            channel: channelId,
            text: `GitHub write ${pendingWrite.id} rejected and discarded.`,
          });
        } catch { /* best-effort */ }
      }
    }
    return;
  }

  console.log(`[host:reaction] No pending task, cancellation, or GitHub write found for channel=${channelId} messageTs=${messageTs}`);
});

// --- PID file for crash detection ---
const PID_FILE = path.resolve('data/host.pid');

function writePidFile(): void {
  fs.mkdirSync(path.dirname(PID_FILE), { recursive: true });
  fs.writeFileSync(PID_FILE, String(process.pid));
}

function removePidFile(): void {
  try { fs.unlinkSync(PID_FILE); } catch {}
}

/** Check if previous shutdown was clean. Returns 'crash' or 'clean'. */
function detectStartupReason(): 'crash' | 'clean' {
  try {
    if (!fs.existsSync(PID_FILE)) return 'clean';
    // PID file left behind = previous process didn't shut down gracefully
    return 'crash';
  } catch {
    return 'clean';
  }
}

// Graceful shutdown
function shutdown() {
  console.log('[host] Shutting down...');
  removePidFile();
  stopHeartbeat();
  shutdownCron();
  shutdownGithub();
  stopApiProxy();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Start API logging proxy (opt-in via API_LOG_PROXY env var)
const API_PROXY_PORT = 9998;
const apiLogDir = path.resolve('data/api-logs');
if (process.env.API_LOG_PROXY) {
  startApiProxy(API_PROXY_PORT, apiLogDir);
  process.env.ANTHROPIC_BASE_URL = `http://localhost:${API_PROXY_PORT}`;
}

// Start
console.log('[host] Starting hello-claw...');
await app.start();

// Resolve bot user ID for self-reaction filtering
try {
  const authResult = await app.client.auth.test();
  botUserId = authResult.user_id;
  console.log(`[host] Bot user ID: ${botUserId}`);
} catch (err) {
  console.warn('[host] Could not resolve bot user ID:', err);
}

// --- Startup health alert ---
const startupReason = detectStartupReason();
writePidFile();
const heartbeatChannel = process.env.HEARTBEAT_CHANNEL;

if (heartbeatChannel && startupReason === 'crash') {
  const now = new Date().toLocaleString('en-US', {
    timeZone: 'America/Los_Angeles',
    weekday: 'short', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true, timeZoneName: 'short',
  });
  try {
    await app.client.chat.postMessage({
      channel: heartbeatChannel,
      text: `:warning: *Restarted after unexpected exit* — ${now}\nPrevious process didn't shut down cleanly. launchd auto-restarted.`,
    });
    console.log('[host] Posted crash-restart alert to Slack');
  } catch (err) {
    console.error('[host] Failed to post crash-restart alert:', err);
  }
}

if (heartbeatChannel) {
  const slackMcp = createSlackMcp({ app, channelId: heartbeatChannel, workspaceDir: workDir });
  const mediaMcp = createMediaMcp({ geminiApiKey: SECRETS.GEMINI_API_KEY, workDir });
  const searchMcp = createSearchMcp({ perplexityApiKey: SECRETS.PERPLEXITY_API_KEY });
  const brainMcp = createBrainMcp({ workDir, userName });
  const audioMcp = createAudioMcp({ openaiApiKey: SECRETS.OPENAI_API_KEY, workDir });
  startHeartbeat({
    workDir,
    app,
    anthropicApiKey: SECRETS.ANTHROPIC_API_KEY,
    channelId: heartbeatChannel,
    userName,
    mcpServers: {
      slack: slackMcp,
      media: mediaMcp,
      search: searchMcp,
      'second-brain': brainMcp,
      audio: audioMcp,
    },
  });
}

console.log('[host] hello-claw is running.');
