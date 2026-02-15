/**
 * Per-channel async mutex
 * Serializes all query() calls (interactive + cron) for a given channel
 * to prevent session collisions and concurrent workspace access.
 */

const locks = new Map<string, Promise<void>>();

/**
 * Acquire a per-channel lock. Returns a release function.
 * If another caller holds the lock for this channel, waits until it's released.
 */
export async function acquireChannelLock(channelId: string): Promise<() => void> {
  // Wait for any existing lock on this channel
  while (locks.has(channelId)) {
    await locks.get(channelId);
  }

  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });

  locks.set(channelId, promise);

  return () => {
    locks.delete(channelId);
    release();
  };
}
