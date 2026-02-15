/**
 * Session ID management - maps channel IDs to Agent SDK session IDs
 *
 * Keys use the format `${channelId}:${type}` where type defaults to 'interactive'.
 * Heartbeat sessions are ephemeral (never stored) — only interactive and cron persist.
 */

import fs from 'fs';
import path from 'path';

const DATA_DIR = path.resolve('data');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');

let sessions: Record<string, string> = {};

// Load sessions from disk on startup
try {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(SESSIONS_FILE)) {
    sessions = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf-8'));
  }
} catch {
  sessions = {};
}

export function getSessionId(channelId: string, type: string = 'interactive'): string | undefined {
  return sessions[`${channelId}:${type}`];
}

export function saveSessionId(channelId: string, sessionId: string, type: string = 'interactive'): void {
  sessions[`${channelId}:${type}`] = sessionId;
  const tmp = `${SESSIONS_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(sessions, null, 2));
  fs.renameSync(tmp, SESSIONS_FILE);
}
