/**
 * Configuration constants — all env-driven with FRUGAL defaults.
 *
 * Defaults target the public OSS release: someone cloning this repo and
 * running it for the first time should not accidentally spend $50/day.
 * Power users override via .env.
 */

// --- Models ---
// Frugal default: Sonnet. Opus is ~5× the price.
export const AGENT_MODEL = process.env.AGENT_MODEL || 'claude-sonnet-4-6';

// Cron tasks are typically simple ("post a reminder") — default one tier down.
export const CRON_MODEL = process.env.CRON_MODEL || AGENT_MODEL;

// --- Effort ---
// 'max' is Opus-only. 'high' is the Sonnet ceiling and the right frugal default.
export const AGENT_EFFORT = (process.env.AGENT_EFFORT || 'high') as
  'low' | 'medium' | 'high' | 'max';

// --- Budget ---
// Per-session cap passed to SDK's maxBudgetUsd. Hard stop within one query() call.
export const MAX_BUDGET_USD = parseFloat(process.env.MAX_SESSION_BUDGET_USD || '') || 50;

// Daily accumulator — auto-pauses agent when exceeded. Frugal default: $3.
export const MAX_DAILY_BUDGET_USD = parseFloat(process.env.MAX_DAILY_BUDGET_USD || '') || 3;

// --- Heartbeat ---
// 'off' by default — heartbeats cost money on a schedule whether you use them or not.
// 'conservative' = 4 beats/day, 'standard' = 8 beats/day.
export const HEARTBEAT_MODE = process.env.HEARTBEAT_MODE || 'off';

// --- Identity ---
export const AGENT_NAME = process.env.AGENT_NAME || 'Agent';
// Used when other systems discuss or review this agent — not optional noise.
export const AGENT_PRONOUNS = process.env.AGENT_PRONOUNS || 'they/them';

// --- Betas ---
// Shared beta flags applied to every query() call. Keeping this list here
// (rather than inline in each call site) is what fixes the drift where
// cron.ts was missing code-execution-web-tools.
export const BETAS: string[] = ['code-execution-web-tools-2026-02-09'];
