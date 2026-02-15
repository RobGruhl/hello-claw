/**
 * Slack MCP Server - In-process tools for Slack interaction
 * Runs in the host process (OUTSIDE the sandbox)
 */

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import type { App } from '@slack/bolt';
import { markdownToMrkdwn } from '../lib/mrkdwn.js';

interface SlackMcpOptions {
  app: App;
  channelId: string;
  workspaceDir: string;
}

export function createSlackMcp({ app, channelId, workspaceDir }: SlackMcpOptions) {
  return createSdkMcpServer({
    name: 'slack',
    version: '1.0.0',
    tools: [
      tool(
        'send_message',
        `Send a message to the current Slack channel. Use Slack mrkdwn format (see system prompt for syntax).`,
        {
          text: z.string().describe('The message text to send (Slack mrkdwn format)'),
          thread_ts: z.string().optional().describe('Thread timestamp — reply within an existing thread'),
        },
        async (args) => {
          try {
            const response = await app.client.chat.postMessage({
              channel: channelId,
              text: markdownToMrkdwn(args.text),
              ...(args.thread_ts ? { thread_ts: args.thread_ts } : {}),
            });
            const ts = response.ts || '';
            const friendly = ts ? new Date(parseFloat(ts) * 1000).toLocaleString('en-US', {
              timeZone: 'America/Los_Angeles',
              weekday: 'short', month: 'short', day: 'numeric',
              hour: 'numeric', minute: '2-digit', hour12: true, timeZoneName: 'short',
            }) : '';
            return {
              content: [{ type: 'text' as const, text: `Message sent to ${channelId} [ts: ${ts} | ${friendly}]` }],
            };
          } catch (err) {
            return {
              content: [{ type: 'text' as const, text: `Failed to send message: ${err instanceof Error ? err.message : String(err)}` }],
              isError: true,
            };
          }
        }
      ),

      tool(
        'upload_file',
        'Upload a file to the current Slack channel. Use this for sharing images, documents, or any generated files.',
        {
          file_path: z.string().describe('Local path to the file to upload'),
          title: z.string().optional().describe('Optional title for the file'),
          initial_comment: z.string().optional().describe('Optional comment to accompany the file'),
        },
        async (args) => {
          try {
            // Restrict uploads to workspace and /tmp to prevent reading arbitrary files
            const resolvedPath = path.resolve(args.file_path);

            if (!fs.existsSync(resolvedPath)) {
              return {
                content: [{ type: 'text' as const, text: `File not found: ${args.file_path}` }],
                isError: true,
              };
            }

            // Resolve symlinks to prevent symlink-based path traversal (H-2)
            const realPath = fs.realpathSync(resolvedPath);
            const resolvedWorkspace = path.resolve(workspaceDir);
            if (!realPath.startsWith(resolvedWorkspace) && !realPath.startsWith('/tmp/')) {
              return {
                content: [{ type: 'text' as const, text: `Upload restricted to workspace and /tmp. Denied: ${args.file_path}` }],
                isError: true,
              };
            }

            await app.client.filesUploadV2({
              channel_id: channelId,
              file: fs.createReadStream(realPath),
              filename: path.basename(realPath),
              title: args.title,
              initial_comment: args.initial_comment ? markdownToMrkdwn(args.initial_comment) : undefined,
            });

            return {
              content: [{ type: 'text' as const, text: `File uploaded: ${args.file_path}` }],
            };
          } catch (err) {
            return {
              content: [{ type: 'text' as const, text: `Failed to upload file: ${err instanceof Error ? err.message : String(err)}` }],
              isError: true,
            };
          }
        }
      ),

      tool(
        'download_file',
        'Download a Slack-hosted file by ID to the workspace. Use this to retrieve images or files attached to messages.',
        {
          file_id: z.string().describe('Slack file ID (from [ATTACHED FILES] block)'),
          filename: z.string().optional().describe('Override filename (defaults to original name)'),
        },
        async (args) => {
          try {
            const info = await app.client.files.info({ file: args.file_id });
            const file = info.file;
            if (!file) {
              return {
                content: [{ type: 'text' as const, text: `File not found: ${args.file_id}` }],
                isError: true,
              };
            }

            const size = file.size ?? 0;
            if (size > 20 * 1024 * 1024) {
              return {
                content: [{ type: 'text' as const, text: `File too large (${(size / 1024 / 1024).toFixed(1)}MB). Max 20MB.` }],
                isError: true,
              };
            }

            const downloadUrl = file.url_private_download || file.url_private;
            if (!downloadUrl) {
              return {
                content: [{ type: 'text' as const, text: `No download URL available for file ${args.file_id}` }],
                isError: true,
              };
            }

            const response = await fetch(downloadUrl, {
              headers: { Authorization: `Bearer ${app.client.token}` },
              signal: AbortSignal.timeout(30_000),
            });

            if (!response.ok) {
              return {
                content: [{ type: 'text' as const, text: `Download failed (${response.status}): ${response.statusText}` }],
                isError: true,
              };
            }

            const outputName = path.basename(args.filename || file.name || `file-${args.file_id}`);
            const mediaDir = path.join(workspaceDir, 'media');
            fs.mkdirSync(mediaDir, { recursive: true });
            const outputPath = path.resolve(mediaDir, outputName);

            // Path traversal guard
            if (!outputPath.startsWith(path.resolve(workspaceDir))) {
              return {
                content: [{ type: 'text' as const, text: `Path traversal blocked: ${outputName}` }],
                isError: true,
              };
            }

            const buffer = Buffer.from(await response.arrayBuffer());
            fs.writeFileSync(outputPath, buffer);

            return {
              content: [{ type: 'text' as const, text: `Downloaded to ${outputPath} (${(size / 1024).toFixed(1)}KB, ${file.mimetype || 'unknown type'})` }],
            };
          } catch (err) {
            return {
              content: [{ type: 'text' as const, text: `Failed to download file: ${err instanceof Error ? err.message : String(err)}` }],
              isError: true,
            };
          }
        }
      ),

      tool(
        'add_reaction',
        'Add an emoji reaction to a message in the current channel.',
        {
          name: z.string().describe('Emoji name without colons (e.g., "thumbsup", "wave")'),
          timestamp: z.string().describe('Message timestamp to react to'),
        },
        async (args) => {
          try {
            await app.client.reactions.add({
              channel: channelId,
              name: args.name,
              timestamp: args.timestamp,
            });
            return {
              content: [{ type: 'text' as const, text: `Reaction :${args.name}: added` }],
            };
          } catch (err) {
            return {
              content: [{ type: 'text' as const, text: `Failed to add reaction: ${err instanceof Error ? err.message : String(err)}` }],
              isError: true,
            };
          }
        }
      ),

      tool(
        'get_reactions',
        'Get emoji reactions on a message in the current channel.',
        {
          timestamp: z.string().describe('Message timestamp to get reactions for'),
        },
        async (args) => {
          try {
            const result = await app.client.reactions.get({
              channel: channelId,
              timestamp: args.timestamp,
            });

            const reactions = result.message?.reactions;
            if (!reactions || reactions.length === 0) {
              return {
                content: [{ type: 'text' as const, text: 'No reactions on this message.' }],
              };
            }

            const lines = reactions.map(r =>
              `:${r.name}: (${r.count}) — ${(r.users || []).join(', ')}`
            );
            return {
              content: [{ type: 'text' as const, text: `Reactions:\n${lines.join('\n')}` }],
            };
          } catch (err) {
            return {
              content: [{ type: 'text' as const, text: `Failed to get reactions: ${err instanceof Error ? err.message : String(err)}` }],
              isError: true,
            };
          }
        }
      ),

      tool(
        'get_channel_history',
        'Get recent messages from the current channel. Returns timestamps you can use with add_reaction and get_reactions.',
        {
          limit: z.number().min(1).max(20).optional().describe('Number of messages to fetch (default 10, max 20)'),
        },
        async (args) => {
          try {
            const result = await app.client.conversations.history({
              channel: channelId,
              limit: args.limit ?? 10,
            });

            const messages = result.messages || [];
            if (messages.length === 0) {
              return {
                content: [{ type: 'text' as const, text: 'No messages found.' }],
              };
            }

            const lines = messages.map(m => {
              const who = m.bot_id ? '(bot)' : `<@${m.user}>`;
              const text = (m.text || '').slice(0, 150);
              const reactions = (m.reactions || []).map(r => `:${r.name}:(${r.count})`).join(' ');
              return `[ts: ${m.ts}] ${who}: ${text}${reactions ? `  ${reactions}` : ''}`;
            });

            return {
              content: [{ type: 'text' as const, text: lines.join('\n') }],
            };
          } catch (err) {
            return {
              content: [{ type: 'text' as const, text: `Failed to get history: ${err instanceof Error ? err.message : String(err)}` }],
              isError: true,
            };
          }
        }
      ),

      tool(
        'list_channels',
        'List Slack channels the bot is a member of.',
        {},
        async () => {
          try {
            const result = await app.client.conversations.list({
              types: 'public_channel,private_channel',
              exclude_archived: true,
            });

            const channels = (result.channels || [])
              .filter(c => c.is_member)
              .map(c => `- #${c.name} (${c.id})`)
              .join('\n');

            return {
              content: [{ type: 'text' as const, text: channels || 'No channels found.' }],
            };
          } catch (err) {
            return {
              content: [{ type: 'text' as const, text: `Failed to list channels: ${err instanceof Error ? err.message : String(err)}` }],
              isError: true,
            };
          }
        }
      ),
    ],
  });
}
