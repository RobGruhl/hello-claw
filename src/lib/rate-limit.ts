/**
 * Simple daily rate limiter for MCP tools
 *
 * In-memory counters that reset at midnight Pacific.
 * If the process restarts, counters reset — acceptable since
 * restarts are infrequent and the limit is generous.
 */

const PACIFIC_TZ = 'America/Los_Angeles';

interface BucketState {
  count: number;
  date: string; // YYYY-MM-DD in Pacific time
}

const buckets = new Map<string, BucketState>();

function todayPacific(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: PACIFIC_TZ }); // YYYY-MM-DD
}

/**
 * Check if a tool call is within its daily rate limit.
 * Returns { allowed: true } or { allowed: false, message: string }.
 */
export function checkRateLimit(
  toolCategory: string,
  dailyLimit: number,
): { allowed: true } | { allowed: false; message: string } {
  const today = todayPacific();
  const bucket = buckets.get(toolCategory);

  if (!bucket || bucket.date !== today) {
    // New day or first call — reset
    buckets.set(toolCategory, { count: 1, date: today });
    return { allowed: true };
  }

  if (bucket.count >= dailyLimit) {
    return {
      allowed: false,
      message: `Daily rate limit reached for ${toolCategory}: ${dailyLimit} calls per day. Resets at midnight Pacific.`,
    };
  }

  bucket.count++;
  return { allowed: true };
}
