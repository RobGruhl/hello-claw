/**
 * Cost Tracker — daily cost accumulation and JSONL logging.
 *
 * Tracks per-query costs from SDK's total_cost_usd, accumulates daily totals,
 * and persists to data/costs/daily.json + data/costs/costs.jsonl.
 * Day boundary is 4:00 AM Pacific Time.
 */

import fs from 'fs';
import path from 'path';

const COSTS_DIR = path.resolve('data/costs');
const DAILY_FILE = path.join(COSTS_DIR, 'daily.json');
const JSONL_FILE = path.join(COSTS_DIR, 'costs.jsonl');

interface CostEntry {
  timestamp: string;
  source: 'interactive' | 'heartbeat' | 'cron';
  channelId: string;
  costUsd: number;
  numTurns: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheCreationTokens?: number;
  cacheReadTokens?: number;
}

interface DailyState {
  date: string; // YYYY-MM-DD in Pacific time (day boundary = 4am PT)
  totalUsd: number;
  entries: number;
}

function ensureDir(): void {
  fs.mkdirSync(COSTS_DIR, { recursive: true });
}

/** Get the "cost day" date string (4am PT boundary). */
function getCostDay(): string {
  const now = new Date();
  // Get current Pacific time components
  const ptStr = now.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' });
  const ptDate = new Date(ptStr);
  const ptHour = ptDate.getHours();

  // Before 4am PT → still "yesterday"
  if (ptHour < 4) {
    ptDate.setDate(ptDate.getDate() - 1);
  }

  const y = ptDate.getFullYear();
  const m = String(ptDate.getMonth() + 1).padStart(2, '0');
  const d = String(ptDate.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function loadDaily(): DailyState {
  try {
    const raw = fs.readFileSync(DAILY_FILE, 'utf-8');
    return JSON.parse(raw) as DailyState;
  } catch {
    return { date: getCostDay(), totalUsd: 0, entries: 0 };
  }
}

function saveDaily(state: DailyState): void {
  ensureDir();
  const tmp = `${DAILY_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, DAILY_FILE);
}

function appendJsonl(entry: CostEntry): void {
  ensureDir();
  fs.appendFileSync(JSONL_FILE, JSON.stringify(entry) + '\n');
}

/** Reset daily accumulator if the cost day has changed. */
function resetDailyCostIfNewDay(state: DailyState): DailyState {
  const today = getCostDay();
  if (state.date !== today) {
    return { date: today, totalUsd: 0, entries: 0 };
  }
  return state;
}

export function recordCost(entry: CostEntry): DailyState {
  let state = loadDaily();
  state = resetDailyCostIfNewDay(state);

  state.totalUsd += entry.costUsd;
  state.entries += 1;
  saveDaily(state);
  appendJsonl(entry);

  return state;
}

export function getDailyCost(): DailyState {
  let state = loadDaily();
  state = resetDailyCostIfNewDay(state);
  // If day changed, persist the reset
  if (state.entries === 0 && state.totalUsd === 0) {
    saveDaily(state);
  }
  return state;
}

export function formatCostSummary(sessionCostUsd: number, numTurns: number, dailyTotalUsd: number): string {
  const session = `$${sessionCostUsd.toFixed(2)} (${numTurns} turn${numTurns === 1 ? '' : 's'})`;
  const daily = `today: $${dailyTotalUsd.toFixed(2)}`;
  return `${session} | ${daily}`;
}
