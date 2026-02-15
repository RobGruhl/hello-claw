/**
 * Persistent audit log writer
 * One JSONL file per channel, stored in data/audit/
 */

import fs from 'fs';
import path from 'path';

const AUDIT_DIR = path.resolve('data', 'audit');

// Ensure audit directory exists on import
fs.mkdirSync(AUDIT_DIR, { recursive: true });

export interface AuditEntry {
  timestamp: string;
  channel: string;
  event: 'tool_use' | 'tool_denied' | 'cron_task_requested' | 'cron_task_approved' | 'cron_task_rejected' | 'cron_task_expired' | 'cron_cancellation_requested' | 'cron_cancellation_confirmed' | 'cron_cancellation_rejected' | 'cron_cancellation_expired' | 'cron_task_self_cancelled' | 'github_write_requested' | 'github_write_approved' | 'github_write_rejected' | 'github_write_expired';
  tool: string;
  input: Record<string, unknown>;
  reason?: string;
  success?: boolean;
}

export function writeAuditEntry(entry: AuditEntry): void {
  const logFile = path.join(AUDIT_DIR, `${entry.channel}.jsonl`);
  const line = JSON.stringify(entry) + '\n';

  try {
    fs.appendFileSync(logFile, line);
  } catch (err) {
    // Fall back to console if file write fails
    console.error(`[audit] Failed to write to ${logFile}: ${err}`);
    console.log(`[audit] ${line}`);
  }
}
