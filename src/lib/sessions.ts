/**
 * Session ID management - maps channel IDs to Agent SDK session IDs
 *
 * Keys use the format `${channelId}:${type}` where type defaults to 'interactive'.
 * Heartbeat and cron sessions are ephemeral (never stored) — only interactive persists.
 *
 * Daily reset: sessions older than the 4am boundary (AGENT_TIMEZONE) are cleared.
 */

import fs from 'fs';
import path from 'path';
import { isBeforeTodayBoundary } from './timezone.js';

const DATA_DIR = path.resolve('data');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');

interface SessionEntry {
  sessionId: string;
  createdAt: string;
  updatedAt: string;
}

type SessionStore = Record<string, SessionEntry | string>;

let sessions: SessionStore = {};

// Load sessions from disk on startup (auto-migrates bare strings)
try {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(SESSIONS_FILE)) {
    sessions = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf-8'));
  }
} catch {
  sessions = {};
}

function persist(): void {
  const tmp = `${SESSIONS_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(sessions, null, 2));
  fs.renameSync(tmp, SESSIONS_FILE);
}

/** Migrate a bare string entry to SessionEntry format. */
function migrateEntry(value: SessionEntry | string): SessionEntry | undefined {
  if (!value) return undefined;
  if (typeof value === 'string') {
    const now = new Date().toISOString();
    return { sessionId: value, createdAt: now, updatedAt: now };
  }
  return value;
}

export function getSessionId(channelId: string, type: string = 'interactive'): string | undefined {
  const entry = sessions[`${channelId}:${type}`];
  if (!entry) return undefined;
  const migrated = migrateEntry(entry);
  if (!migrated) return undefined;
  // Persist migration if it happened
  if (typeof entry === 'string') {
    sessions[`${channelId}:${type}`] = migrated;
    persist();
  }
  return migrated.sessionId;
}

export function getSessionEntry(channelId: string, type: string = 'interactive'): SessionEntry | undefined {
  const entry = sessions[`${channelId}:${type}`];
  if (!entry) return undefined;
  const migrated = migrateEntry(entry);
  if (!migrated) return undefined;
  // Persist migration if it happened
  if (typeof entry === 'string') {
    sessions[`${channelId}:${type}`] = migrated;
    persist();
  }
  return migrated;
}

export function saveSessionId(channelId: string, sessionId: string, type: string = 'interactive'): void {
  const now = new Date().toISOString();
  const existing = getSessionEntry(channelId, type);
  sessions[`${channelId}:${type}`] = {
    sessionId,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  };
  persist();
}

export function touchSession(channelId: string, type: string = 'interactive'): void {
  const entry = getSessionEntry(channelId, type);
  if (entry) {
    entry.updatedAt = new Date().toISOString();
    sessions[`${channelId}:${type}`] = entry;
    persist();
  }
}

export function clearSession(channelId: string, type: string = 'interactive'): void {
  delete sessions[`${channelId}:${type}`];
  persist();
  console.log(`[sessions] Cleared session for ${channelId}:${type}`);
}

export type SessionAction = { action: 'resume' } | { action: 'reset'; reason: string };

export function evaluateSessionFreshness(channelId: string, type: string = 'interactive'): SessionAction {
  const entry = getSessionEntry(channelId, type);
  if (!entry) return { action: 'resume' }; // No session = fresh start

  // The old implementation also returned a 'compact' action for >2h idle,
  // but host.ts never handled it — the branch was dead code. Dropped.
  // (The SDK's default autocompact handles context pressure on its own;
  // see commit 4c2662f.)
  if (isBeforeTodayBoundary(new Date(entry.updatedAt))) {
    return { action: 'reset', reason: 'daily reset (4am boundary)' };
  }

  return { action: 'resume' };
}
