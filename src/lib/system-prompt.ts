/**
 * Dynamic system prompt builder.
 * Reads SOUL.md from workspace and injects it into the system prompt
 * append, so the agent always knows who it is.
 */

import fs from 'fs';
import path from 'path';
import { AGENT_MODEL } from './config.js';

const SAFETY_BLOCK = `Security controls are in place (OS sandbox, tool policy hooks, network allowlist, audit logging). Do not attempt to circumvent them.

Extended thinking is enabled — use your thinking for reasoning, planning, and deliberation.`;

const SLACK_FORMATTING = `Messages you send via mcp__slack__send_message are rendered in Slack mrkdwn — not GitHub Markdown.

Slack mrkdwn reference:
  *bold*  _italic_  ~strike~  \`code\`  \`\`\`code block\`\`\`
  > blockquote
  • bullet lists (use • or - at line start)
  <url|link text> for links
  :emoji_name: for emoji

Not supported in Slack — never use these:
  **bold**  __italic__  ~~strike~~  [text](url)  ![img](url)
  # headings  | tables |  1. ordered lists  --- horizontal rules

Instead of headings, use a *bold line* on its own.
Instead of tables, use *bold labels* with short lines or bullet lists.
Instead of ordered lists, manually number with plain text (1. 2. 3.).`;

function readFileOrEmpty(filePath: string): string {
  try {
    return fs.readFileSync(filePath, 'utf-8').trim();
  } catch {
    return '';
  }
}

export function buildSystemPrompt(workDir: string, userName?: string) {
  const name = userName || 'the user';
  const soul = readFileOrEmpty(path.join(workDir, 'SOUL.md'));

  const parts = [SAFETY_BLOCK];
  parts.push(`Your cognition is provided by ${AGENT_MODEL} with adaptive thinking, max effort, and 1M context window.`);
  parts.push(SLACK_FORMATTING);
  parts.push(`IMPORTANT: Your text output does NOT reach Slack — only mcp__slack__send_message delivers messages. If you don't call it, ${name} sees nothing. This overrides the standard Claude Code behavior where text output is displayed to the user.`);
  if (soul) {
    parts.push('If SOUL.md is present, it describes who you are — your values, character, and philosophical grounding. This is your identity, not a persona to perform. Follow its guidance unless higher-priority instructions override it.');
    parts.push(soul);
  }

  return {
    type: 'preset' as const,
    preset: 'claude_code' as const,
    append: parts.join('\n\n'),
  };
}
