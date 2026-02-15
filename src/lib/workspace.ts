/**
 * Workspace directory management - single shared workspace
 * Seeds all identity/memory files from workspace-seed/ on first run.
 */

import fs from 'fs';
import path from 'path';

const WORKSPACE_DIR = path.resolve('workspace');
const SEED_DIR = path.resolve('workspace-seed');

const SEED_FILES = [
  'CLAUDE.md',
  'SOUL.md',
  'USER.md',
  'MEMORY.md',
  'HEARTBEAT.md',
  'AGENTS.md',
];

export function ensureWorkspace(): string {
  fs.mkdirSync(WORKSPACE_DIR, { recursive: true });

  // Ensure subdirectories exist
  fs.mkdirSync(path.join(WORKSPACE_DIR, 'memory'), { recursive: true });
  fs.mkdirSync(path.join(WORKSPACE_DIR, 'images'), { recursive: true });
  fs.mkdirSync(path.join(WORKSPACE_DIR, 'daily-logs'), { recursive: true });
  fs.mkdirSync(path.join(WORKSPACE_DIR, 'daily-reflections'), { recursive: true });
  fs.mkdirSync(path.join(WORKSPACE_DIR, '.second-brain'), { recursive: true });

  // Seed files from workspace-seed/ — only if they don't already exist
  // (preserves agent edits across deploys)
  for (const file of SEED_FILES) {
    const dest = path.join(WORKSPACE_DIR, file);
    const src = path.join(SEED_DIR, file);
    if (!fs.existsSync(dest) && fs.existsSync(src)) {
      fs.copyFileSync(src, dest);
    }
  }

  // Seed subdirectory contents (memory/, images/, daily-logs/)
  for (const subdir of ['memory', 'images', 'daily-logs', 'daily-reflections']) {
    const seedSubdir = path.join(SEED_DIR, subdir);
    if (fs.existsSync(seedSubdir)) {
      for (const file of fs.readdirSync(seedSubdir)) {
        if (file === '.gitkeep') continue;
        const dest = path.join(WORKSPACE_DIR, subdir, file);
        const src = path.join(seedSubdir, file);
        if (!fs.existsSync(dest)) {
          fs.copyFileSync(src, dest);
        }
      }
    }
  }

  return WORKSPACE_DIR;
}
