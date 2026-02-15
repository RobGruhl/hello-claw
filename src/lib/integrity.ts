/**
 * CLAUDE.md integrity checking
 * Detects if the agent modified workspace CLAUDE.md (potential prompt injection persistence)
 */

import fs from 'fs';
import crypto from 'crypto';

function hashFile(filePath: string): string | null {
  try {
    const content = fs.readFileSync(filePath);
    return crypto.createHash('sha256').update(content).digest('hex');
  } catch {
    return null;
  }
}

export function snapshotClaudeMd(filePath: string): { hash: string | null; backup: string | null } {
  const hash = hashFile(filePath);
  let backup: string | null = null;

  if (hash) {
    try {
      backup = fs.readFileSync(filePath, 'utf-8');
    } catch {
      // file disappeared between hash and read — unlikely but fine
    }
  }

  return { hash, backup };
}

export function checkClaudeMdIntegrity(
  filePath: string,
  snapshot: { hash: string | null; backup: string | null },
  channelId: string,
): boolean {
  const currentHash = hashFile(filePath);

  if (snapshot.hash === null && currentHash === null) {
    // File didn't exist before and still doesn't — fine
    return true;
  }

  if (snapshot.hash === currentHash) {
    return true;
  }

  // CLAUDE.md was modified by the agent
  console.warn(
    `[integrity] CLAUDE.md modified during session! channel=${channelId} ` +
    `before=${snapshot.hash} after=${currentHash}`
  );

  if (snapshot.backup !== null) {
    // Restore from backup
    try {
      fs.writeFileSync(filePath, snapshot.backup);
      console.warn(`[integrity] CLAUDE.md restored from pre-session backup. channel=${channelId}`);
    } catch (err) {
      console.error(`[integrity] Failed to restore CLAUDE.md: ${err}`);
    }
  }

  return false;
}
