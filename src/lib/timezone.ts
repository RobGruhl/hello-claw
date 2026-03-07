/**
 * Timezone utilities — single source of truth for AGENT_TIMEZONE.
 *
 * Before this file, the codebase had three different 4am-boundary
 * implementations (sessions.ts, cost-tracker.ts, and a hardcoded
 * PACIFIC_TZ in cron.ts), plus a dozen inline `America/Los_Angeles`
 * strings. AGENT_TIMEZONE makes this configurable for the OSS release.
 */

export const AGENT_TIMEZONE = process.env.AGENT_TIMEZONE || 'America/Los_Angeles';

/** Reset hour for the "agent day" — sessions older than this boundary get cleared,
 *  daily cost accumulator rolls over at this hour. */
const DAY_RESET_HOUR = 4;

/**
 * Format a Date (or Slack-ts-seconds) as a short human-friendly string
 * in the agent timezone: "Mon, Jan 6, 3:45 PM PST"
 */
export function friendlyTimestamp(input: Date | number | string): string {
  const date = typeof input === 'object'
    ? input
    : new Date(parseFloat(String(input)) * 1000);
  return date.toLocaleString('en-US', {
    timeZone: AGENT_TIMEZONE,
    weekday: 'short', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true, timeZoneName: 'short',
  });
}

/** Current hour and minute in the agent timezone (0-23, 0-59). */
export function nowInTz(): { hour: number; minute: number } {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: AGENT_TIMEZONE, hour: 'numeric', minute: 'numeric', hour12: false,
  }).formatToParts(now);
  const hour = parseInt(parts.find(p => p.type === 'hour')?.value || '0', 10) % 24;
  const minute = parseInt(parts.find(p => p.type === 'minute')?.value || '0', 10);
  return { hour, minute };
}

/** Today's date in the agent timezone as YYYY-MM-DD (midnight boundary). */
export function todayInTz(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: AGENT_TIMEZONE });
}

/**
 * The current "agent day" as YYYY-MM-DD, where the day boundary is
 * DAY_RESET_HOUR (4am) rather than midnight. Before 4am, you're still
 * in "yesterday".
 *
 * This is the shared implementation that replaces the three divergent
 * copies in sessions.ts, cost-tracker.ts, and elsewhere.
 */
export function agentDay(date: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: AGENT_TIMEZONE,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: 'numeric', hour12: false,
  }).formatToParts(date);

  const get = (type: string) => parts.find(p => p.type === type)?.value || '';
  let y = parseInt(get('year'), 10);
  let m = parseInt(get('month'), 10);
  let d = parseInt(get('day'), 10);
  const hour = parseInt(get('hour'), 10) % 24;

  if (hour < DAY_RESET_HOUR) {
    // Still "yesterday" — walk the calendar back one day.
    // Use UTC arithmetic to avoid DST edge cases.
    const rolled = new Date(Date.UTC(y, m - 1, d - 1));
    y = rolled.getUTCFullYear();
    m = rolled.getUTCMonth() + 1;
    d = rolled.getUTCDate();
  }

  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/**
 * Returns true if `timestamp` falls on an earlier agent-day than now.
 * Used by sessions.ts to decide whether to reset a stale session.
 */
export function isBeforeTodayBoundary(timestamp: Date): boolean {
  return agentDay(timestamp) < agentDay(new Date());
}
