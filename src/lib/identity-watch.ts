/**
 * Identity file change detection — SOUL.md and MEMORY.md.
 *
 * These files are MUTABLE BY DESIGN. Personality and continuity require
 * the agent to be able to update who it is and what it remembers. That's
 * the whole point. We don't block or restore on change — we *notice*
 * and tell the human, so they have visibility into identity drift.
 *
 * Contrast with CLAUDE.md (integrity.ts), which IS restored on tamper
 * because it's operational config, not identity.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import type { App } from '@slack/bolt';

const WATCHED = ['SOUL.md', 'MEMORY.md'];

interface FileSnapshot {
  hash: string | null;
  content: string | null;
}

export type IdentitySnapshot = Record<string, FileSnapshot>;

function hashContent(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function readSnapshot(filePath: string): FileSnapshot {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    return { hash: hashContent(content), content };
  } catch {
    return { hash: null, content: null };
  }
}

export function snapshotIdentity(workDir: string): IdentitySnapshot {
  const snap: IdentitySnapshot = {};
  for (const name of WATCHED) {
    snap[name] = readSnapshot(path.join(workDir, name));
  }
  return snap;
}

/**
 * Diff two versions of a text file and produce a terse Slack-renderable
 * summary. Not a real unified diff — just enough to show what changed
 * so the human can eyeball it without opening the file.
 */
function summarizeDiff(before: string | null, after: string | null): string {
  if (before === null && after !== null) {
    return `_created_ (${after.length} chars)`;
  }
  if (before !== null && after === null) {
    return `_deleted_`;
  }
  if (before === null || after === null) return '_changed_';

  const beforeLines = before.split('\n');
  const afterLines = after.split('\n');
  const beforeSet = new Set(beforeLines);
  const afterSet = new Set(afterLines);

  const added = afterLines.filter(l => l.trim() && !beforeSet.has(l));
  const removed = beforeLines.filter(l => l.trim() && !afterSet.has(l));

  const preview = (lines: string[], prefix: string) =>
    lines.slice(0, 4).map(l => `${prefix} ${l.slice(0, 140)}`).join('\n');

  const parts: string[] = [];
  if (added.length) parts.push(`*+${added.length} line${added.length === 1 ? '' : 's'}:*\n${preview(added, '`+`')}`);
  if (removed.length) parts.push(`*−${removed.length} line${removed.length === 1 ? '' : 's'}:*\n${preview(removed, '`−`')}`);
  if (added.length > 4 || removed.length > 4) parts.push(`_(${added.length + removed.length} total, showing first 4 each)_`);

  return parts.join('\n') || `_modified_ (${before.length} → ${after.length} chars)`;
}

/**
 * Compare current identity files against a pre-query snapshot.
 * If anything changed, post a diff summary to Slack. Never blocks,
 * never restores — purely observational.
 */
export async function reportIdentityChanges(
  workDir: string,
  before: IdentitySnapshot,
  app: App,
  channelId: string,
): Promise<void> {
  const changes: string[] = [];

  for (const name of WATCHED) {
    const prev = before[name];
    const curr = readSnapshot(path.join(workDir, name));

    if (prev.hash === curr.hash) continue;

    console.log(`[identity-watch] ${name} changed (${prev.hash?.slice(0, 8) ?? 'null'} → ${curr.hash?.slice(0, 8) ?? 'null'})`);
    changes.push(`*${name}*\n${summarizeDiff(prev.content, curr.content)}`);
  }

  if (changes.length === 0) return;

  try {
    await app.client.chat.postMessage({
      channel: channelId,
      text: `:pencil2: _Identity files updated during this session:_\n\n${changes.join('\n\n')}`,
    });
  } catch (err) {
    console.warn(`[identity-watch] Failed to post diff: ${err}`);
  }
}
