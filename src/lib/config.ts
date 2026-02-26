export const AGENT_MODEL = process.env.AGENT_MODEL || 'claude-opus-4-6';

export const BETAS: string[] = process.env.ENABLE_1M_CONTEXT === 'true'
  ? ['context-1m-2025-08-07'] : [];

// Per-session budget cap (SDK maxBudgetUsd).
export const MAX_BUDGET_USD = parseFloat(process.env.MAX_SESSION_BUDGET_USD || '') || 50;

// Daily budget cap — auto-pauses agent when exceeded. Tracked in data/costs/daily.json.
export const MAX_DAILY_BUDGET_USD = parseFloat(process.env.MAX_DAILY_BUDGET_USD || '') || 5;

// Heartbeat schedule preset: 'conservative' (4/day), 'standard' (8/day), 'off' (disabled).
export const HEARTBEAT_MODE = process.env.HEARTBEAT_MODE || 'conservative';
