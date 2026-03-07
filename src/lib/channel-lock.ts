/**
 * Per-channel async mutex
 * Serializes all query() calls (interactive + cron + heartbeat) for a
 * given channel to prevent concurrent workspace access.
 *
 * The old implementation had a TOCTOU race: between the `while` loop
 * exiting and `locks.set()` being called, another waiter could slip
 * through the same gap. This version chains each acquisition onto the
 * tail of the previous promise — the chain is extended synchronously,
 * so there's no gap.
 */

const tails = new Map<string, Promise<void>>();

export async function acquireChannelLock(channelId: string): Promise<() => void> {
  const prev = tails.get(channelId) ?? Promise.resolve();

  let release!: () => void;
  const mine = new Promise<void>(resolve => { release = resolve; });

  // Extend the chain SYNCHRONOUSLY, before any await. A concurrent caller
  // arriving on the next microtask will see this promise as the new tail
  // and chain behind it. No gap.
  tails.set(channelId, prev.then(() => mine));

  await prev;

  return () => {
    // Only clear the map entry if we're still the tail — otherwise
    // someone's already chained behind us and we'd orphan them.
    if (tails.get(channelId) === mine) tails.delete(channelId);
    release();
  };
}
