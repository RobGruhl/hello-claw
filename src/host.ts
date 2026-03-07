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
import { createFirecrawlMcp } from './mcp/firecrawl.js';
import { createBrowserMcp } from './mcp/browser.js';
import { getSessionId, saveSessionId, clearSession, touchSession, evaluateSessionFreshness } from './lib/sessions.js';
import { ensureWorkspace } from './lib/workspace.js';
import { snapshotClaudeMd, checkClaudeMdIntegrity } from './lib/integrity.js';
import { snapshotIdentity, reportIdentityChanges } from './lib/identity-watch.js';
import { acquireChannelLock } from './lib/channel-lock.js';
import { writeAuditEntry } from './lib/audit-log.js';
import { buildQueryOptions } from './lib/query-config.js';
import { AGENT_MODEL, AGENT_NAME, MAX_DAILY_BUDGET_USD } from './lib/config.js';
import { AGENT_TIMEZONE, friendlyTimestamp } from './lib/timezone.js';
import { startHeartbeat, stopHeartbeat } from './lib/heartbeat.js';
import { startApiProxy, stopApiProxy } from './lib/api-proxy.js';
import { recordCost, getDailyCost, formatCostSummary } from './lib/cost-tracker.js';
import { isPaused, setPaused } from './lib/pause.js';

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
  FIRECRAWL_API_KEY: process.env.FIRECRAWL_API_KEY || '',
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
delete process.env.FIRECRAWL_API_KEY;
// ANTHROPIC_API_KEY is passed explicitly to query() via `env` option,
// then stripped so sandboxed Bash can't `env | grep KEY`
delete process.env.ANTHROPIC_API_KEY;

// Non-secret config (safe to leave in process.env)
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || '';

// Enable experimental features for the SDK subprocess
process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = '1';
process.env.CLAUDE_CODE_STREAM_CLOSE_TIMEOUT = '1500000'; // 25 min for oracle (background mode takes 5-15 min)

// --- Human identity ---
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
    timeZone: AGENT_TIMEZONE,
    weekday: 'long', month: 'long', day: 'numeric',
  });
  const timePart = now.toLocaleTimeString('en-US', {
    timeZone: AGENT_TIMEZONE,
    hour: 'numeric', minute: '2-digit', hour12: true, timeZoneName: 'short',
  });

  const state = sessionType === 'fresh' ? 'This is a fresh session.' : 'Resuming your previous session.';
  return `[SESSION CONTEXT]\nWelcome back ${AGENT_NAME}, it's ${datePart} at ${timePart}. ${state}\nCognition: ${AGENT_MODEL} with adaptive thinking.\nChannel: ${channelId}`;
}

const app = new App({
  token: SECRETS.SLACK_BOT_TOKEN,
  appToken: SECRETS.SLACK_APP_TOKEN,
  socketMode: true,
  logLevel: LogLevel.INFO,
});

/** Extract full text from Slack rich_text blocks (message.blocks).
 *  Slack's modern clients send messages with blocks; the top-level `text`
 *  field can be a truncated plain-text fallback with a trailing "…".
 *
 *  Block structure is recursive:
 *    rich_text -> [rich_text_section | rich_text_list | rich_text_quote | rich_text_preformatted]
 *    rich_text_list -> [rich_text_section]  (list items are sections, not leaves)
 *    rich_text_section -> [text | link | emoji | user | channel]  (leaves)
 *
 *  The old implementation was one level too shallow — it treated a list's
 *  children as leaves, so list item text was silently dropped and only a
 *  trailing newline survived. */
function extractLeaf(el: any): string {
  if (el.type === 'text') return el.text ?? '';
  if (el.type === 'link') return el.text ?? el.url ?? '';
  if (el.type === 'emoji') return el.unicode ? String.fromCodePoint(...el.unicode.split('-').map((h: string) => parseInt(h, 16))) : `:${el.name}:`;
  if (el.type === 'user') return `<@${el.user_id}>`;
  if (el.type === 'channel') return `<#${el.channel_id}>`;
  return '';
}

function walkRichTextContainer(container: any, parts: string[]): void {
  if (!Array.isArray(container?.elements)) return;
  for (const child of container.elements) {
    if (child.type === 'rich_text_section' || child.type === 'rich_text_quote' || child.type === 'rich_text_preformatted') {
      for (const leaf of child.elements || []) parts.push(extractLeaf(leaf));
      parts.push('\n');
    } else if (child.type === 'rich_text_list') {
      // List items are themselves sections — recurse one more level.
      walkRichTextContainer(child, parts);
    } else {
      // Direct leaf (shouldn't happen at this level, but be tolerant)
      parts.push(extractLeaf(child));
    }
  }
}

function extractTextFromBlocks(blocks: any[] | undefined): string | null {
  if (!blocks || !Array.isArray(blocks)) return null;
  const parts: string[] = [];
  for (const block of blocks) {
    if (block.type !== 'rich_text') continue;
    walkRichTextContainer(block, parts);
  }
  const joined = parts.join('').replace(/\n+$/, '');
  return joined.length > 0 ? joined : null;
}

app.message(async ({ message, say }) => {
  // Skip bot messages and edits, but allow file_share subtype (user sent image with text)
  if (message.subtype && message.subtype !== 'file_share') return;

  const blockText = extractTextFromBlocks((message as any).blocks);
  const fallbackText = ('text' in message ? message.text : '') || '';
  const text = blockText || fallbackText;
  const files = ('files' in message ? (message as any).files : undefined) as Array<{
    id: string; name?: string; mimetype?: string; size?: number;
  }> | undefined;

  if (!text && (!files || files.length === 0)) return;

  const messageTs = ('ts' in message ? message.ts : '') || '';

  let prompt = text;
  const ts = messageTs || (Date.now() / 1000).toFixed(6);
  prompt += `\n\n[ts: ${ts} | ${friendlyTimestamp(ts)}]`;
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

  // --- Bot commands (! prefix to avoid Slack intercepting / as slash commands) ---
  const trimmedText = text.trim().toLowerCase();
  if (trimmedText === '!pause') {
    setPaused(true, 'manual pause via !pause');
    await say(`:double_vertical_bar: Agent paused. Send \`!unpause\` to resume.`);
    return;
  }
  if (trimmedText === '!unpause') {
    setPaused(false);
    const daily = getDailyCost();
    await say(`:arrow_forward: Agent resumed. Today's cost: $${daily.totalUsd.toFixed(2)}`);
    return;
  }
  if (trimmedText === '!clear') {
    clearSession(message.channel);
    const daily = getDailyCost();
    await say(`:wastebasket: Session cleared. Starting fresh on your next message. Today: $${daily.totalUsd.toFixed(2)}`);
    return;
  }
  // Check pause state (allow !unpause through, block everything else)
  if (isPaused()) {
    await say(`_Agent is paused. Send \`!unpause\` to resume._`);
    return;
  }

  // Acquire per-channel lock (shared with cron) to prevent session collisions
  const release = await acquireChannelLock(channelId);

  try {
    // --- Session lifecycle evaluation ---
    const freshness = evaluateSessionFreshness(channelId);

    if (freshness.action === 'reset') {
      console.log(`[host] Session reset for ${channelId}: ${freshness.reason}`);
      clearSession(channelId);
    }

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

    // Snapshot CLAUDE.md (restored on tamper) and SOUL/MEMORY (reported, not restored)
    const claudeMdPath = `${workDir}/CLAUDE.md`;
    const claudeMdSnapshot = snapshotClaudeMd(claudeMdPath);
    const identitySnapshot = snapshotIdentity(workDir);

    let newSessionId: string | undefined;
    let totalCostUsd = 0;
    let numTurns = 0;
    let resultUsage: { inputTokens?: number; outputTokens?: number; cacheCreationTokens?: number; cacheReadTokens?: number } = {};

    for await (const msg of query({
        prompt,
        options: buildQueryOptions({
          workDir,
          channelId,
          anthropicApiKey: SECRETS.ANTHROPIC_API_KEY,
          userName,
          sessionId,
          allowedTools: [
            'Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'Task',
            'WebSearch', 'WebFetch',
            'mcp__slack__*', 'mcp__cron__*', 'mcp__media__*', 'mcp__search__*',
            'mcp__second-brain__*', 'mcp__github__*', 'mcp__oracle__*',
            'mcp__voice__*', 'mcp__audio__*', 'mcp__firecrawl__*', 'mcp__browser__*',
          ],
          mcpServers: {
            slack: createSlackMcp({ app, channelId, workspaceDir: workDir }),
            cron: createCronMcp({ channelId, app, anthropicApiKey: SECRETS.ANTHROPIC_API_KEY, userName, workDir }),
            media: createMediaMcp({ geminiApiKey: SECRETS.GEMINI_API_KEY, workDir }),
            search: createSearchMcp({ perplexityApiKey: SECRETS.PERPLEXITY_API_KEY }),
            'second-brain': createBrainMcp({ workDir, userName }),
            github: createGithubMcp({ ghToken: SECRETS.GH_TOKEN, app, channelId }),
            oracle: createOracleMcp({ openaiApiKey: SECRETS.OPENAI_API_KEY }),
            voice: createVoiceMcp({ elevenlabsApiKey: SECRETS.ELEVENLABS_API_KEY, workDir, defaultVoiceId: ELEVENLABS_VOICE_ID }),
            audio: createAudioMcp({ openaiApiKey: SECRETS.OPENAI_API_KEY, workDir }),
            firecrawl: createFirecrawlMcp({ firecrawlApiKey: SECRETS.FIRECRAWL_API_KEY }),
            browser: createBrowserMcp({ workDir }),
          },
        }),
      })) {
        const sub = 'subtype' in msg ? ` subtype=${(msg as any).subtype}` : '';
        console.log(`[host:sdk] type=${msg.type}${sub}`);
        if (msg.type === 'system' && msg.subtype === 'init') {
          newSessionId = msg.session_id;
        }
        if (msg.type === 'result') {
          const resultMsg = msg as any;
          totalCostUsd = resultMsg.total_cost_usd || 0;
          numTurns = resultMsg.num_turns || 0;
          if (resultMsg.usage) {
            resultUsage = {
              inputTokens: resultMsg.usage.inputTokens,
              outputTokens: resultMsg.usage.outputTokens,
              cacheCreationTokens: resultMsg.usage.cacheCreationInputTokens,
              cacheReadTokens: resultMsg.usage.cacheReadInputTokens,
            };
          }
        }
      }

    touchSession(channelId);
    if (newSessionId) saveSessionId(channelId, newSessionId);

    // CLAUDE.md: restore on tamper. SOUL/MEMORY: report but allow.
    checkClaudeMdIntegrity(claudeMdPath, claudeMdSnapshot, channelId);
    await reportIdentityChanges(workDir, identitySnapshot, app, channelId);

    // --- Cost tracking ---
    if (totalCostUsd > 0) {
      const daily = recordCost({
        timestamp: new Date().toISOString(),
        source: 'interactive',
        channelId,
        costUsd: totalCostUsd,
        numTurns,
        inputTokens: resultUsage.inputTokens,
        outputTokens: resultUsage.outputTokens,
        cacheCreationTokens: resultUsage.cacheCreationTokens,
        cacheReadTokens: resultUsage.cacheReadTokens,
      });

      // Post cost summary to Slack
      const summary = formatCostSummary(totalCostUsd, numTurns, daily.totalUsd);
      try {
        await app.client.chat.postMessage({
          channel: channelId,
          text: `_${summary}_`,
        });
      } catch { /* best-effort */ }

      // Budget alerts
      const halfBudget = MAX_DAILY_BUDGET_USD / 2;
      const prevTotal = daily.totalUsd - totalCostUsd;
      if (prevTotal < halfBudget && daily.totalUsd >= halfBudget) {
        try {
          await app.client.chat.postMessage({
            channel: channelId,
            text: `:warning: Daily cost at $${daily.totalUsd.toFixed(2)} — 50% of $${MAX_DAILY_BUDGET_USD} budget.`,
          });
        } catch { /* best-effort */ }
      }

      if (daily.totalUsd >= MAX_DAILY_BUDGET_USD) {
        setPaused(true, `daily budget exceeded ($${daily.totalUsd.toFixed(2)})`);
        try {
          await app.client.chat.postMessage({
            channel: channelId,
            text: `:octagonal_sign: *Auto-paused* — daily cost $${daily.totalUsd.toFixed(2)} exceeded $${MAX_DAILY_BUDGET_USD} budget. Send \`!unpause\` to resume.`,
          });
        } catch { /* best-effort */ }
      }
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
  try {
    await app.client.chat.postMessage({
      channel: heartbeatChannel,
      text: `:warning: *Restarted after unexpected exit* — ${friendlyTimestamp(new Date())}\nPrevious process didn't shut down cleanly. launchd auto-restarted.`,
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
