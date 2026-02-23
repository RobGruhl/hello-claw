/**
 * Session ID management - maps channel IDs to Agent SDK session IDs
 *
 * Keys use the format `${channelId}:${type}` where type defaults to 'interactive'.
 * Heartbeat sessions are ephemeral (never stored) — only interactive and cron persist.
 *
 * SessionEntry tracks timestamps for lifecycle management:
 * - Daily reset: sessions created before 4am PT today are cleared
 * - Idle compaction: sessions idle >2h trigger autocompact on next use
 */

import fs from 'fs';
import path from 'path';

const DATA_DIR = path.resolve('data');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');

const IDLE_COMPACT_MS = 2 * 60 * 60 * 1000; // 2 hours

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

/** Get the 4am PT boundary for today as a Date. */
function getTodayResetBoundary(): Date {
  const now = new Date();
  // Get today's date in Pacific time
  const ptStr = now.toLocaleDateString('en-US', { timeZone: 'America/Los_Angeles' });
  const ptDate = new Date(ptStr);
  const ptHour = parseInt(
    now.toLocaleString('en-US', { hour: 'numeric', hour12: false, timeZone: 'America/Los_Angeles' }),
    10,
  );

  // If before 4am PT, the boundary is yesterday's 4am PT
  if (ptHour < 4) {
    ptDate.setDate(ptDate.getDate() - 1);
  }

  // Construct 4am Pacific for that date
  // Use Intl to get the UTC offset for Pacific on that date
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    timeZoneName: 'shortOffset',
  });
  const parts = formatter.formatToParts(ptDate);
  const offsetPart = parts.find(p => p.type === 'timeZoneName');
  const offsetMatch = offsetPart?.value?.match(/GMT([+-]?\d+)/);
  const offsetHours = offsetMatch ? parseInt(offsetMatch[1], 10) : -8;

  // 4am Pacific = 4:00 - offset in UTC
  const boundaryUtc = new Date(ptDate);
  boundaryUtc.setHours(4 - offsetHours, 0, 0, 0);
  return boundaryUtc;
}

export type SessionAction = { action: 'resume' } | { action: 'reset'; reason: string } | { action: 'compact'; reason: string };

export function evaluateSessionFreshness(channelId: string, type: string = 'interactive'): SessionAction {
  const entry = getSessionEntry(channelId, type);
  if (!entry) return { action: 'resume' }; // No session = fresh start, same as resume with undefined

  const updatedAt = new Date(entry.updatedAt);
  const now = new Date();

  // Daily reset: if last activity was before today's 4am PT boundary
  const resetBoundary = getTodayResetBoundary();
  if (updatedAt < resetBoundary) {
    return { action: 'reset', reason: 'daily reset (4am PT boundary)' };
  }

  // Idle compaction: if idle for more than 2 hours
  const idleMs = now.getTime() - updatedAt.getTime();
  if (idleMs > IDLE_COMPACT_MS) {
    const idleHours = (idleMs / 3_600_000).toFixed(1);
    return { action: 'compact', reason: `idle ${idleHours}h (>${IDLE_COMPACT_MS / 3_600_000}h threshold)` };
  }

  return { action: 'resume' };
}
