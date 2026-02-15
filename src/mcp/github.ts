/**
 * GitHub Issues MCP Server - In-process issue management
 * Runs in the host process (OUTSIDE the sandbox)
 *
 * Write operations (create, comment, close) require human approval via Slack reaction,
 * mirroring the cron task approval pattern exactly.
 */

import { execFile, execFileSync } from 'child_process';
import { promisify } from 'util';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { App } from '@slack/bolt';
import { writeAuditEntry } from '../lib/audit-log.js';

const exec = promisify(execFile);

const APPROVAL_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes
const DEFAULT_REPO = process.env.GH_REPO || 'RobGruhl/hello-claw';

interface GitHubMcpOptions {
  ghToken: string;
  app: App;
  channelId: string;
  repo?: string;
}

export interface PendingWrite {
  id: string;
  channelId: string;
  type: 'create_issue' | 'add_comment' | 'close_issue';
  ghArgs: string[];
  description: string;
  approvalMessageTs?: string;
  approvalTimeout?: ReturnType<typeof setTimeout>;
}

const pendingWrites = new Map<string, PendingWrite>();
let writeCounter = 0;

function generateWriteId(): string {
  return `gh-write-${++writeCounter}`;
}

/**
 * Derive owner/repo from git remote, falling back to constructor arg or default.
 */
function resolveRepo(override?: string): string {
  if (override) return override;

  try {
    const url = execFileSync('git', ['config', '--get', 'remote.origin.url'], {
      encoding: 'utf-8',
      timeout: 5_000,
    }).trim();

    // SSH: git@github.com:Owner/Repo.git
    const sshMatch = url.match(/github\.com[:/](.+?)(?:\.git)?$/);
    if (sshMatch) return sshMatch[1];

    // HTTPS: https://github.com/Owner/Repo.git
    const httpsMatch = url.match(/github\.com\/(.+?)(?:\.git)?$/);
    if (httpsMatch) return httpsMatch[1];
  } catch {
    // git not available or not in a repo — use fallback
  }

  return DEFAULT_REPO;
}

/**
 * Execute a gh CLI command with the provided token.
 */
async function ghExec(args: string[], ghToken: string): Promise<string> {
  const { stdout } = await exec('gh', args, {
    env: { ...process.env, GH_TOKEN: ghToken },
    timeout: 30_000,
  });
  return stdout.trim();
}

/**
 * Fetch all label names for a repo, for pre-validation.
 */
async function getRepoLabels(repo: string, ghToken: string): Promise<Set<string>> {
  const output = await ghExec(['label', 'list', '--repo', repo, '--json', 'name', '--limit', '100'], ghToken);
  const labels = JSON.parse(output) as Array<{ name: string }>;
  return new Set(labels.map(l => l.name));
}

// --- Exported helpers for host.ts reaction handler ---

/** Find a pending write by the Slack approval message ts. */
export function findPendingWriteByMessageTs(channelId: string, messageTs: string): PendingWrite | undefined {
  for (const write of pendingWrites.values()) {
    if (write.channelId === channelId && write.approvalMessageTs === messageTs) {
      return write;
    }
  }
  return undefined;
}

/** Approve a pending write: execute the gh command and return output. */
export async function approveWrite(writeId: string, ghToken: string): Promise<{ output: string }> {
  const write = pendingWrites.get(writeId);
  if (!write) throw new Error(`Pending write ${writeId} not found`);

  if (write.approvalTimeout) {
    clearTimeout(write.approvalTimeout);
  }

  pendingWrites.delete(writeId);

  const output = await ghExec(write.ghArgs, ghToken);
  return { output };
}

/** Reject a pending write: discard it. */
export function rejectWrite(writeId: string): boolean {
  const write = pendingWrites.get(writeId);
  if (!write) return false;

  if (write.approvalTimeout) {
    clearTimeout(write.approvalTimeout);
  }

  pendingWrites.delete(writeId);
  return true;
}

/** Clear all pending writes and timeouts. */
export function shutdownGithub(): void {
  for (const write of pendingWrites.values()) {
    if (write.approvalTimeout) {
      clearTimeout(write.approvalTimeout);
    }
  }
  pendingWrites.clear();
}

// --- MCP Server ---

export function createGithubMcp({ ghToken, app, channelId, repo: repoOverride }: GitHubMcpOptions) {
  const repo = resolveRepo(repoOverride);

  if (!ghToken) {
    console.warn('[github] GH_TOKEN not set — GitHub MCP tools will be unavailable');
  } else {
    // Only check for gh CLI when we have a token (avoids noisy warnings on hosts without gh)
    try {
      execFileSync('gh', ['--version'], { encoding: 'utf-8', timeout: 5_000 });
    } catch {
      console.warn('[github] gh CLI not found — GitHub MCP tools will fail. Install with: brew install gh');
    }
  }

  console.log(`[github] MCP initialized for repo: ${repo}`);

  return createSdkMcpServer({
    name: 'github',
    version: '1.0.0',
    tools: [
      // --- Read tools (no approval needed) ---

      tool(
        'list_issues',
        `List issues on the project repo. Returns JSON with number, title, state, labels, and creation date. Defaults to open issues.`,
        {
          state: z.enum(['open', 'closed', 'all']).optional().describe('Filter by state (default: open)'),
          labels: z.array(z.string()).optional().describe('Filter by labels'),
          limit: z.number().optional().describe('Max results (default: 30)'),
        },
        async (args) => {
          if (!ghToken) {
            return { content: [{ type: 'text' as const, text: 'GH_TOKEN not set. Cannot access GitHub.' }], isError: true };
          }

          const ghArgs = [
            'issue', 'list',
            '--repo', repo,
            '--json', 'number,title,state,labels,createdAt',
            '--limit', String(args.limit ?? 30),
          ];
          if (args.state) ghArgs.push('--state', args.state);
          if (args.labels?.length) ghArgs.push('--label', args.labels.join(','));

          try {
            const output = await ghExec(ghArgs, ghToken);
            return { content: [{ type: 'text' as const, text: output || '[]' }] };
          } catch (err) {
            return {
              content: [{ type: 'text' as const, text: `list_issues failed: ${err instanceof Error ? err.message : String(err)}` }],
              isError: true,
            };
          }
        },
      ),

      tool(
        'get_issue',
        `Get full details for a single issue including body and comments.`,
        {
          issue_number: z.number().describe('The issue number'),
        },
        async (args) => {
          if (!ghToken) {
            return { content: [{ type: 'text' as const, text: 'GH_TOKEN not set. Cannot access GitHub.' }], isError: true };
          }

          try {
            const output = await ghExec([
              'issue', 'view', String(args.issue_number),
              '--repo', repo,
              '--json', 'number,title,body,state,labels,comments,createdAt',
            ], ghToken);
            return { content: [{ type: 'text' as const, text: output }] };
          } catch (err) {
            return {
              content: [{ type: 'text' as const, text: `get_issue failed: ${err instanceof Error ? err.message : String(err)}` }],
              isError: true,
            };
          }
        },
      ),

      // --- Write tools (approval required) ---

      tool(
        'create_issue',
        `Create a new issue on the project repo. Requires human approval via Slack reaction before execution. Check list_issues first to avoid duplicates. Write specific, scannable titles.`,
        {
          title: z.string().describe('Issue title — specific and scannable'),
          body: z.string().describe('Issue body — what, where, why, suggested approach'),
          labels: z.array(z.string()).optional().describe('Labels: bug, enhancement, new-capability, documentation, priority:high, priority:medium'),
        },
        async (args) => {
          if (!ghToken) {
            return { content: [{ type: 'text' as const, text: 'GH_TOKEN not set. Cannot access GitHub.' }], isError: true };
          }

          // Validate labels against repo's actual labels
          let validLabels: string[] = [];
          let droppedLabels: string[] = [];
          let labelWarning = '';

          if (args.labels?.length) {
            try {
              const repoLabels = await getRepoLabels(repo, ghToken);
              for (const label of args.labels) {
                if (repoLabels.has(label)) {
                  validLabels.push(label);
                } else {
                  droppedLabels.push(label);
                }
              }
              if (droppedLabels.length > 0) {
                labelWarning = `\nNote: labels [${droppedLabels.join(', ')}] don't exist in the repo and were dropped. Valid labels: [${Array.from(repoLabels).join(', ')}]`;
              }
            } catch (err) {
              // If label fetch fails, proceed with all labels and let gh handle it
              console.warn(`[github] Failed to fetch repo labels for validation: ${err instanceof Error ? err.message : String(err)}`);
              validLabels = [...args.labels];
            }
          }

          const ghArgs = [
            'issue', 'create',
            '--repo', repo,
            '--title', args.title,
            '--body', args.body,
          ];
          for (const label of validLabels) {
            ghArgs.push('--label', label);
          }

          const writeId = generateWriteId();
          const labelDesc = validLabels.length ? `\n*Labels:* ${validLabels.join(', ')}` : '';
          const bodyPreview = args.body.length > 300 ? args.body.slice(0, 300) + '...' : args.body;

          const write: PendingWrite = {
            id: writeId,
            channelId,
            type: 'create_issue',
            ghArgs,
            description: `Create issue: "${args.title}"`,
          };

          pendingWrites.set(writeId, write);

          // Post approval message to Slack
          try {
            const approvalMsg = await app.client.chat.postMessage({
              channel: channelId,
              text: [
                `:octocat: *GitHub issue creation requires approval*`,
                `*Repo:* ${repo}`,
                `*Title:* ${args.title}${labelDesc}`,
                `*Body:* ${bodyPreview}`,
                ``,
                `React with :white_check_mark: to approve or :x: to reject. Auto-cancels in 15 minutes.`,
              ].join('\n'),
            });
            write.approvalMessageTs = approvalMsg.ts;
          } catch (err) {
            pendingWrites.delete(writeId);
            return {
              content: [{ type: 'text' as const, text: `Failed to post approval message: ${err instanceof Error ? err.message : String(err)}` }],
              isError: true,
            };
          }

          // Auto-cancel after 15 minutes
          write.approvalTimeout = setTimeout(async () => {
            if (!pendingWrites.has(writeId)) return;

            pendingWrites.delete(writeId);
            console.log(`[github] Write ${writeId} expired (no approval within 15 minutes)`);

            writeAuditEntry({
              timestamp: new Date().toISOString(),
              channel: channelId,
              event: 'github_write_expired',
              tool: 'github__create_issue',
              input: { write_id: writeId, title: args.title },
            });

            try {
              await app.client.chat.postMessage({
                channel: channelId,
                text: `GitHub write ${writeId} auto-cancelled — no approval received within 15 minutes.`,
              });
            } catch { /* best-effort */ }
          }, APPROVAL_TIMEOUT_MS);

          // Audit
          writeAuditEntry({
            timestamp: new Date().toISOString(),
            channel: channelId,
            event: 'github_write_requested',
            tool: 'github__create_issue',
            input: { write_id: writeId, title: args.title, labels: args.labels ?? [] },
          });

          return {
            content: [{
              type: 'text' as const,
              text: `Issue creation requested (${writeId}). Awaiting human approval in Slack — react with :white_check_mark: to create the issue.${labelWarning}`,
            }],
          };
        },
      ),

      tool(
        'add_comment',
        `Add a comment to an existing issue. Requires human approval via Slack reaction. Use for adding context, updates, or discussion — not for creating new issues.`,
        {
          issue_number: z.number().describe('The issue number to comment on'),
          body: z.string().describe('Comment body'),
        },
        async (args) => {
          if (!ghToken) {
            return { content: [{ type: 'text' as const, text: 'GH_TOKEN not set. Cannot access GitHub.' }], isError: true };
          }

          const ghArgs = [
            'issue', 'comment', String(args.issue_number),
            '--repo', repo,
            '--body', args.body,
          ];

          const writeId = generateWriteId();
          const bodyPreview = args.body.length > 300 ? args.body.slice(0, 300) + '...' : args.body;

          const write: PendingWrite = {
            id: writeId,
            channelId,
            type: 'add_comment',
            ghArgs,
            description: `Comment on issue #${args.issue_number}`,
          };

          pendingWrites.set(writeId, write);

          try {
            const approvalMsg = await app.client.chat.postMessage({
              channel: channelId,
              text: [
                `:octocat: *GitHub comment requires approval*`,
                `*Repo:* ${repo}`,
                `*Issue:* #${args.issue_number}`,
                `*Comment:* ${bodyPreview}`,
                ``,
                `React with :white_check_mark: to approve or :x: to reject. Auto-cancels in 15 minutes.`,
              ].join('\n'),
            });
            write.approvalMessageTs = approvalMsg.ts;
          } catch (err) {
            pendingWrites.delete(writeId);
            return {
              content: [{ type: 'text' as const, text: `Failed to post approval message: ${err instanceof Error ? err.message : String(err)}` }],
              isError: true,
            };
          }

          write.approvalTimeout = setTimeout(async () => {
            if (!pendingWrites.has(writeId)) return;
            pendingWrites.delete(writeId);
            console.log(`[github] Write ${writeId} expired (no approval within 15 minutes)`);
            writeAuditEntry({
              timestamp: new Date().toISOString(),
              channel: channelId,
              event: 'github_write_expired',
              tool: 'github__add_comment',
              input: { write_id: writeId, issue_number: args.issue_number },
            });
            try {
              await app.client.chat.postMessage({
                channel: channelId,
                text: `GitHub write ${writeId} auto-cancelled — no approval received within 15 minutes.`,
              });
            } catch { /* best-effort */ }
          }, APPROVAL_TIMEOUT_MS);

          writeAuditEntry({
            timestamp: new Date().toISOString(),
            channel: channelId,
            event: 'github_write_requested',
            tool: 'github__add_comment',
            input: { write_id: writeId, issue_number: args.issue_number },
          });

          return {
            content: [{
              type: 'text' as const,
              text: `Comment on issue #${args.issue_number} requested (${writeId}). Awaiting human approval in Slack.`,
            }],
          };
        },
      ),

      tool(
        'close_issue',
        `Close an issue, optionally with a closing comment. Requires human approval via Slack reaction. Include a brief summary of what was done when closing.`,
        {
          issue_number: z.number().describe('The issue number to close'),
          comment: z.string().optional().describe('Optional closing comment summarizing resolution'),
        },
        async (args) => {
          if (!ghToken) {
            return { content: [{ type: 'text' as const, text: 'GH_TOKEN not set. Cannot access GitHub.' }], isError: true };
          }

          const ghArgs = [
            'issue', 'close', String(args.issue_number),
            '--repo', repo,
          ];
          if (args.comment) {
            ghArgs.push('--comment', args.comment);
          }

          const writeId = generateWriteId();
          const commentDesc = args.comment ? `\n*Comment:* ${args.comment.length > 200 ? args.comment.slice(0, 200) + '...' : args.comment}` : '';

          const write: PendingWrite = {
            id: writeId,
            channelId,
            type: 'close_issue',
            ghArgs,
            description: `Close issue #${args.issue_number}`,
          };

          pendingWrites.set(writeId, write);

          try {
            const approvalMsg = await app.client.chat.postMessage({
              channel: channelId,
              text: [
                `:octocat: *GitHub issue close requires approval*`,
                `*Repo:* ${repo}`,
                `*Issue:* #${args.issue_number}${commentDesc}`,
                ``,
                `React with :white_check_mark: to approve or :x: to reject. Auto-cancels in 15 minutes.`,
              ].join('\n'),
            });
            write.approvalMessageTs = approvalMsg.ts;
          } catch (err) {
            pendingWrites.delete(writeId);
            return {
              content: [{ type: 'text' as const, text: `Failed to post approval message: ${err instanceof Error ? err.message : String(err)}` }],
              isError: true,
            };
          }

          write.approvalTimeout = setTimeout(async () => {
            if (!pendingWrites.has(writeId)) return;
            pendingWrites.delete(writeId);
            console.log(`[github] Write ${writeId} expired (no approval within 15 minutes)`);
            writeAuditEntry({
              timestamp: new Date().toISOString(),
              channel: channelId,
              event: 'github_write_expired',
              tool: 'github__close_issue',
              input: { write_id: writeId, issue_number: args.issue_number },
            });
            try {
              await app.client.chat.postMessage({
                channel: channelId,
                text: `GitHub write ${writeId} auto-cancelled — no approval received within 15 minutes.`,
              });
            } catch { /* best-effort */ }
          }, APPROVAL_TIMEOUT_MS);

          writeAuditEntry({
            timestamp: new Date().toISOString(),
            channel: channelId,
            event: 'github_write_requested',
            tool: 'github__close_issue',
            input: { write_id: writeId, issue_number: args.issue_number, has_comment: !!args.comment },
          });

          return {
            content: [{
              type: 'text' as const,
              text: `Close issue #${args.issue_number} requested (${writeId}). Awaiting human approval in Slack.`,
            }],
          };
        },
      ),
    ],
  });
}
