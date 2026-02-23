/**
 * Pause — process-level pause flag for the agent.
 *
 * When paused, host.ts, heartbeat.ts, and cron.ts skip query() calls.
 * Persisted to data/pause-state.json so it survives restarts.
 */

import fs from 'fs';
import path from 'path';

const PAUSE_FILE = path.resolve('data/pause-state.json');

interface PauseState {
  paused: boolean;
  reason?: string;
  pausedAt?: string;
}

function loadState(): PauseState {
  try {
    const raw = fs.readFileSync(PAUSE_FILE, 'utf-8');
    return JSON.parse(raw) as PauseState;
  } catch {
    return { paused: false };
  }
}

function saveState(state: PauseState): void {
  fs.mkdirSync(path.dirname(PAUSE_FILE), { recursive: true });
  const tmp = `${PAUSE_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, PAUSE_FILE);
}

export function isPaused(): boolean {
  return loadState().paused;
}

export function getPauseReason(): string | undefined {
  return loadState().reason;
}

export function setPaused(paused: boolean, reason?: string): void {
  const state: PauseState = paused
    ? { paused: true, reason, pausedAt: new Date().toISOString() }
    : { paused: false };
  saveState(state);
  console.log(`[pause] Agent ${paused ? 'paused' : 'unpaused'}${reason ? `: ${reason}` : ''}`);
}
