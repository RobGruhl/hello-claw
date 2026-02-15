/**
 * Second Brain MCP Server — ADHD-friendly task and habit management
 * Runs in the host process (OUTSIDE the sandbox) for filesystem access.
 *
 * Data storage: workspace/.second-brain/ (captures.json, history.json)
 * The agent can also Read these files directly for full transparency.
 */

import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

// --- Types ---

interface Capture {
  id: string;
  content: string;
  category: string;
  context: string | null;
  status: string;
  urgency: string;
  deadline: string | null;
  parent_id: string | null;
  task_order: number;
  is_archived: boolean;
  notes: string | null;
  recurrence_pattern: string | null;
  recurrence_days: string[];
  recurrence_time: string | null;
  recurrence_flex: string;
  next_due: string | null;
  current_streak: number;
  best_streak: number;
  total_completions: number;
  total_skips: number;
  created_at: string;
  last_completed: string | null;
  // Computed fields (added by focus)
  priority_score?: number;
  days_until_deadline?: number | null;
  is_overdue?: boolean;
  completed_today?: boolean;
}

interface HistoryEntry {
  id: string;
  task_id: string;
  due_date: string;
  action_date: string;
  status: string;
  quality: string | null;
  energy_level: string | null;
  notes: string | null;
}

// --- Constants ---

const MAX_BACKUPS = 10;

const FLEX_WINDOWS: Record<string, number> = {
  strict: 0,
  normal: 1,
  gentle: 2,
  whenever: 999999,
};

// --- File I/O ---

interface BrainPaths {
  dataDir: string;
  capturesFile: string;
  historyFile: string;
  backupsDir: string;
}

function getPaths(workDir: string): BrainPaths {
  const dataDir = path.join(workDir, '.second-brain');
  return {
    dataDir,
    capturesFile: path.join(dataDir, 'captures.json'),
    historyFile: path.join(dataDir, 'history.json'),
    backupsDir: path.join(dataDir, 'backups'),
  };
}

function ensureDataDir(paths: BrainPaths): void {
  fs.mkdirSync(paths.dataDir, { recursive: true });
  fs.mkdirSync(paths.backupsDir, { recursive: true });
}

function loadJson<T>(filePath: string, fallback: T): T {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function saveJson(filePath: string, data: unknown): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = filePath + '.tmp.' + Date.now();
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2));
  fs.renameSync(tmpPath, filePath);
}

function backupFile(filePath: string, backupsDir: string): void {
  if (!fs.existsSync(filePath)) return;
  fs.mkdirSync(backupsDir, { recursive: true });
  const stem = path.basename(filePath, '.json');
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const dest = path.join(backupsDir, `${stem}_${ts}.json`);
  fs.copyFileSync(filePath, dest);

  // Prune old backups
  const existing = fs.readdirSync(backupsDir)
    .filter(f => f.startsWith(stem + '_') && f.endsWith('.json'))
    .sort();
  for (const old of existing.slice(0, -MAX_BACKUPS)) {
    fs.unlinkSync(path.join(backupsDir, old));
  }
}

function loadCaptures(paths: BrainPaths): Capture[] {
  return loadJson<Capture[]>(paths.capturesFile, []);
}

function loadHistory(paths: BrainPaths): HistoryEntry[] {
  return loadJson<HistoryEntry[]>(paths.historyFile, []);
}

// --- Date helpers ---

function parseDate(s: string | null | undefined): Date | null {
  if (!s) return null;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

function todayStart(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

function todayEnd(): Date {
  const d = new Date();
  d.setHours(23, 59, 59, 0);
  return d;
}

// --- Priority scoring ---

function priorityScore(task: Capture): number {
  const now = new Date();
  const urgency = task.urgency || 'low';
  let daysUntil: number | null = null;

  if (task.deadline) {
    const dl = parseDate(task.deadline);
    if (dl) {
      daysUntil = Math.floor((dl.getTime() - now.getTime()) / (86400 * 1000));
    }
  }

  let score = 0;

  if (daysUntil !== null && daysUntil < 0) {
    score = 1000 + Math.abs(daysUntil);
  } else if (urgency === 'high' && daysUntil !== null && daysUntil <= 3) {
    score = 900 - daysUntil;
  } else if (urgency === 'high' && daysUntil === null) {
    score = 800;
  } else if (urgency === 'medium' && daysUntil !== null && daysUntil <= 5) {
    score = 700 - daysUntil;
  } else if (daysUntil !== null) {
    score = Math.max(0, 500 - daysUntil);
  } else {
    score = urgency === 'medium' ? 100 : 50;
  }

  if (task.status === 'in_progress') {
    score += 50;
  }

  return score;
}

// --- Recall sort key ---

function recallSortKey(capture: Capture): number {
  const now = new Date();
  const status = capture.status || 'pending';

  if (capture.deadline && (status === 'pending' || status === 'in_progress')) {
    const dl = parseDate(capture.deadline);
    if (dl && dl < now) return 0; // overdue
  }

  if (capture.urgency === 'high' && (status === 'pending' || status === 'in_progress')) return 1;
  if (capture.urgency === 'medium' && (status === 'pending' || status === 'in_progress')) return 2;
  if (status === 'pending' || status === 'in_progress') return 3;

  const created = parseDate(capture.created_at);
  const daysOld = created ? Math.floor((now.getTime() - created.getTime()) / (86400 * 1000)) : 0;
  return 4 + daysOld;
}

// --- Habit helpers ---

function isOverdue(due: Date, flex: string, now: Date): boolean {
  if (flex === 'whenever') return false;
  const windowDays = FLEX_WINDOWS[flex] ?? 1;
  const windowMs = windowDays * 86400 * 1000;
  return due.getTime() < now.getTime() - windowMs;
}

function maintainsStreak(task: Capture, dueDate: Date, completedDate: Date): boolean {
  const flex = task.recurrence_flex || 'normal';
  const windowDays = FLEX_WINDOWS[flex] ?? 1;
  const windowMs = windowDays * 86400 * 1000;
  return completedDate.getTime() <= dueDate.getTime() + windowMs;
}

function calculateNextDue(task: Capture, fromDate: Date): Date {
  const pattern = task.recurrence_pattern || 'daily';
  const days = task.recurrence_days || [];
  const timeStr = task.recurrence_time;

  let nextDate = new Date(fromDate);
  nextDate.setDate(nextDate.getDate() + 1);

  if (pattern === 'daily') {
    // already +1 day
  } else if (pattern === 'weekly') {
    if (days.length > 0) {
      const dayAbbrs = days.map(d => d.toLowerCase().slice(0, 3));
      const dayNames = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
      for (let i = 0; i < 7; i++) {
        const dayName = dayNames[nextDate.getDay()];
        if (dayAbbrs.includes(dayName)) break;
        nextDate.setDate(nextDate.getDate() + 1);
      }
    } else {
      nextDate = new Date(fromDate);
      nextDate.setDate(nextDate.getDate() + 7);
    }
  } else if (pattern === 'biweekly') {
    nextDate = new Date(fromDate);
    nextDate.setDate(nextDate.getDate() + 14);
  } else if (pattern === 'monthly') {
    nextDate = new Date(fromDate);
    nextDate.setMonth(nextDate.getMonth() + 1);
  } else if (pattern === 'weekdays') {
    while (nextDate.getDay() === 0 || nextDate.getDay() === 6) {
      nextDate.setDate(nextDate.getDate() + 1);
    }
  }

  if (timeStr) {
    const parts = timeStr.split(':');
    nextDate.setHours(parseInt(parts[0] || '0', 10), parseInt(parts[1] || '0', 10), 0, 0);
  }

  return nextDate;
}

// --- Capture factory ---

function newCapture(overrides: Partial<Capture> & { content: string }): Capture {
  return {
    id: randomUUID(),
    content: overrides.content,
    category: overrides.category || 'task',
    context: overrides.context || null,
    status: overrides.status || 'pending',
    urgency: overrides.urgency || 'medium',
    deadline: overrides.deadline || null,
    parent_id: overrides.parent_id || null,
    task_order: overrides.task_order || 0,
    created_at: new Date().toISOString(),
    is_archived: false,
    notes: overrides.notes || null,
    recurrence_pattern: overrides.recurrence_pattern || null,
    recurrence_days: overrides.recurrence_days || [],
    recurrence_time: overrides.recurrence_time || null,
    recurrence_flex: overrides.recurrence_flex || 'normal',
    next_due: overrides.next_due || null,
    current_streak: 0,
    best_streak: 0,
    total_completions: 0,
    total_skips: 0,
    last_completed: null,
  };
}

// --- Helper to make tool responses ---

function ok(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

function err(message: string) {
  return { content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: message }) }], isError: true };
}

// --- MCP Server ---

interface BrainMcpOptions {
  workDir: string;
  userName?: string;
}

export function createBrainMcp({ workDir, userName }: BrainMcpOptions) {
  const name = userName || 'the user';
  const paths = getPaths(workDir);

  // Ensure data dir exists on creation
  ensureDataDir(paths);

  return createSdkMcpServer({
    name: 'second-brain',
    version: '1.0.0',
    tools: [

      // --- capture ---
      tool(
        'capture',
        `Store a thought, task, habit, or memory. This is the universal intake — everything goes through capture.

Use for: brain dumps, new tasks, things to remember, recurring habits.
Returns: the stored item with its generated ID.

For recurring habits, set recurrence_pattern and optionally recurrence_time, recurrence_days, and recurrence_flex. The first next_due is computed automatically.`,
        {
          content: z.string().describe('What to capture — the task, thought, or habit description'),
          category: z.enum(['task', 'memory', 'person']).optional().describe('Type of capture (default: task)'),
          context: z.enum(['work', 'personal', 'family', 'health', 'finance', 'learning']).optional().describe('Life area this belongs to'),
          urgency: z.enum(['high', 'medium', 'low']).optional().describe('How urgent (default: medium)'),
          deadline: z.string().optional().describe('ISO datetime deadline (e.g. "2026-03-15" or "2026-03-15T14:00:00")'),
          notes: z.string().optional().describe('Additional context or details'),
          recurrence_pattern: z.enum(['daily', 'weekly', 'biweekly', 'monthly', 'weekdays']).optional().describe('For habits: how often it repeats'),
          recurrence_time: z.string().optional().describe('For habits: preferred time of day (e.g. "08:00")'),
          recurrence_days: z.array(z.string()).optional().describe('For weekly habits: which days (e.g. ["mon", "wed", "fri"])'),
          recurrence_flex: z.enum(['strict', 'normal', 'gentle', 'whenever']).optional().describe('For habits: how strict the schedule is. strict=same day (meds), normal=±1 day, gentle=±2 days, whenever=no pressure'),
        },
        async (args) => {
          try {
            const captures = loadCaptures(paths);
            const now = new Date();

            const capture = newCapture({
              content: args.content,
              category: args.category,
              context: args.context,
              urgency: args.urgency,
              deadline: args.deadline,
              notes: args.notes,
              recurrence_pattern: args.recurrence_pattern,
              recurrence_time: args.recurrence_time,
              recurrence_days: args.recurrence_days,
              recurrence_flex: args.recurrence_flex,
            });

            if (capture.recurrence_pattern) {
              capture.next_due = calculateNextDue(capture, now).toISOString();
            }

            captures.push(capture);
            saveJson(paths.capturesFile, captures);
            return ok({ success: true, message: 'Captured!', capture });
          } catch (e) {
            return err(`Capture failed: ${e instanceof Error ? e.message : String(e)}`);
          }
        },
      ),

      // --- recall ---
      tool(
        'recall',
        `Retrieve active captures sorted by priority. Shows the current landscape — what's pending, overdue, in progress.

Filters out archived items and subtasks (subtasks are shown under their parents). Returns up to limit items with any attached subtasks.`,
        {
          limit: z.number().optional().describe('Max items to return (default: 10)'),
          context: z.enum(['work', 'personal', 'family', 'health', 'finance', 'learning']).optional().describe('Filter by life area'),
          include_archived: z.boolean().optional().describe('Include archived items (default: false)'),
          status: z.string().optional().describe('Comma-separated statuses to filter (e.g. "pending,in_progress")'),
        },
        async (args) => {
          try {
            const allCaptures = loadCaptures(paths);
            const statuses = args.status ? args.status.split(',').map(s => s.trim()) : null;

            let result = allCaptures.filter(c => {
              if (c.is_archived && !args.include_archived) return false;
              if (args.context && c.context !== args.context) return false;
              if (statuses && !statuses.includes(c.status)) return false;
              if (c.category === 'subtask') return false;
              return true;
            });

            result.sort((a, b) => recallSortKey(a) - recallSortKey(b));
            const limit = args.limit || 10;
            result = result.slice(0, limit);

            // Attach subtasks
            const parentIds = new Set(result.map(c => c.id));
            const subtasks = allCaptures.filter(c =>
              c.parent_id && parentIds.has(c.parent_id) && !c.is_archived
            );

            return ok({ success: true, captures: [...result, ...subtasks], count: result.length });
          } catch (e) {
            return err(`Recall failed: ${e instanceof Error ? e.message : String(e)}`);
          }
        },
      ),

      // --- focus ---
      tool(
        'focus',
        `Returns the top N highest-priority items with scoring rationale. Optimized for "what should I do next?" — cuts through decision paralysis.

Scoring: overdue items first (1000+days), then high-urgency with deadlines (900-days), then by urgency tier. In-progress items get a +50 boost.`,
        {
          limit: z.number().optional().describe('How many items (default: 5)'),
          context: z.enum(['work', 'personal', 'family', 'health', 'finance', 'learning']).optional().describe('Filter by life area'),
          status: z.string().optional().describe('Comma-separated statuses (default: "pending,in_progress")'),
        },
        async (args) => {
          try {
            const captures = loadCaptures(paths);
            const statuses = args.status
              ? args.status.split(',').map(s => s.trim())
              : ['pending', 'in_progress'];

            let tasks = captures.filter(c => {
              if (c.is_archived) return false;
              if (!statuses.includes(c.status)) return false;
              if (c.category !== 'task' && c.category !== 'subtask') return false;
              if (args.context && c.context !== args.context) return false;
              return true;
            });

            const now = new Date();
            for (const t of tasks) {
              t.priority_score = priorityScore(t);
              const dl = parseDate(t.deadline);
              t.days_until_deadline = dl
                ? Math.floor((dl.getTime() - now.getTime()) / (86400 * 1000))
                : null;
              t.is_overdue = t.days_until_deadline !== null && t.days_until_deadline < 0;
            }

            tasks.sort((a, b) => (b.priority_score || 0) - (a.priority_score || 0));
            const limit = args.limit || 5;
            tasks = tasks.slice(0, limit);

            return ok({ success: true, tasks, count: tasks.length });
          } catch (e) {
            return err(`Focus failed: ${e instanceof Error ? e.message : String(e)}`);
          }
        },
      ),

      // --- update_status ---
      tool(
        'update_status',
        `Update the status of a capture. For regular tasks, sets the new status directly. For recurring habits, also tracks streaks and advances the next due date.

Statuses: pending, in_progress, completed, paused, skipped, partial.
For habits: "completed" and "partial" increment streaks (if within flex window). "skipped" resets the streak. "paused" freezes next_due.

Returns the updated task and, for habits, celebration data (streak count, whether it's a personal best).`,
        {
          id: z.string().describe('The capture ID to update'),
          status: z.enum(['pending', 'in_progress', 'completed', 'paused', 'skipped', 'partial']).describe('New status'),
          notes: z.string().optional().describe('Notes about this update'),
          quality: z.enum(['full', 'quick', 'micro']).optional().describe('For partial habit completions: how much was done'),
          energy: z.enum(['high', 'medium', 'low']).optional().describe('Energy level during completion'),
        },
        async (args) => {
          try {
            const captures = loadCaptures(paths);
            const idx = captures.findIndex(c => c.id === args.id);
            if (idx === -1) return err(`Capture not found: ${args.id}`);

            const task = captures[idx];
            const isRecurring = !!task.recurrence_pattern;
            const now = new Date();
            const response: Record<string, unknown> = {
              task_id: args.id,
              old_status: task.status,
              new_status: args.status,
            };

            if (isRecurring) {
              const dueDate = parseDate(task.next_due) || now;

              // Record history
              const history = loadHistory(paths);
              const entry: HistoryEntry = {
                id: randomUUID(),
                task_id: args.id,
                due_date: dueDate.toISOString(),
                action_date: now.toISOString(),
                status: args.status,
                quality: args.status === 'partial' ? (args.quality || null) : null,
                energy_level: args.energy || null,
                notes: args.notes || null,
              };
              history.push(entry);
              saveJson(paths.historyFile, history);

              if (args.status === 'completed' || args.status === 'partial') {
                let streak = task.current_streak || 0;
                let best = task.best_streak || 0;
                if (maintainsStreak(task, dueDate, now)) {
                  streak += 1;
                  best = Math.max(streak, best);
                } else {
                  streak = 1;
                }
                task.current_streak = streak;
                task.best_streak = best;
                task.total_completions = (task.total_completions || 0) + 1;
                task.last_completed = now.toISOString();

                response.celebration = {
                  streak,
                  total: task.total_completions,
                  is_best_streak: streak === best,
                };
              } else if (args.status === 'skipped') {
                task.current_streak = 0;
                task.total_skips = (task.total_skips || 0) + 1;
                response.support = {
                  best_streak: task.best_streak || 0,
                  total_completions: task.total_completions || 0,
                };
              }

              // Advance next_due (unless paused)
              if (args.status !== 'paused') {
                task.next_due = calculateNextDue(task, now).toISOString();
              }

              response.history_entry = entry;
            } else {
              task.status = args.status;
            }

            if (args.notes) {
              task.notes = args.notes;
            }

            captures[idx] = task;
            saveJson(paths.capturesFile, captures);
            response.success = true;
            response.task = task;
            return ok(response);
          } catch (e) {
            return err(`Update failed: ${e instanceof Error ? e.message : String(e)}`);
          }
        },
      ),

      // --- archive ---
      tool(
        'archive',
        `Soft-delete captures that are done or no longer relevant. Supports archiving specific IDs or bulk-archiving old completed items.

For bulk: set old_completed_days to archive all completed items older than N days.
For specific: provide comma-separated IDs.`,
        {
          ids: z.string().optional().describe('Comma-separated IDs to archive'),
          reason: z.string().optional().describe('Why these are being archived'),
          old_completed_days: z.number().optional().describe('Bulk-archive completed items older than N days'),
        },
        async (args) => {
          try {
            backupFile(paths.capturesFile, paths.backupsDir);
            const captures = loadCaptures(paths);
            const now = new Date();
            const archivedIds: string[] = [];

            if (args.old_completed_days !== undefined) {
              const cutoff = new Date(now.getTime() - args.old_completed_days * 86400 * 1000);
              for (const c of captures) {
                if (c.status === 'completed' && !c.is_archived) {
                  const completedAt = parseDate(c.last_completed) || parseDate(c.created_at);
                  if (completedAt && completedAt < cutoff) {
                    c.is_archived = true;
                    archivedIds.push(c.id);
                  }
                }
              }
            } else if (args.ids) {
              const idList = args.ids.split(',').map(s => s.trim());
              for (const c of captures) {
                if (idList.includes(c.id)) {
                  c.is_archived = true;
                  archivedIds.push(c.id);
                }
              }
            } else {
              return err('Provide either ids or old_completed_days');
            }

            saveJson(paths.capturesFile, captures);
            return ok({
              success: true,
              message: `Archived ${archivedIds.length} items`,
              archived_ids: archivedIds,
              reason: args.reason || null,
            });
          } catch (e) {
            return err(`Archive failed: ${e instanceof Error ? e.message : String(e)}`);
          }
        },
      ),

      // --- habits ---
      tool(
        'habits',
        `Returns recurring tasks organized by urgency: overdue, due_now, due_today, due_later, completed_today.

Respects flex windows — strict habits go overdue immediately, gentle habits have a 2-day grace period, "whenever" habits never show as overdue.

Timeframe filters: "today" (default), "tomorrow", "week", "overdue".`,
        {
          timeframe: z.enum(['today', 'tomorrow', 'week', 'overdue']).optional().describe('Time window to check (default: today)'),
          include_completed: z.boolean().optional().describe('Include habits already completed today (default: false)'),
          context: z.enum(['work', 'personal', 'family', 'health', 'finance', 'learning']).optional().describe('Filter by life area'),
        },
        async (args) => {
          try {
            const captures = loadCaptures(paths);
            const history = loadHistory(paths);
            const now = new Date();
            const tStart = todayStart();
            const tEnd = todayEnd();
            const timeframe = args.timeframe || 'today';

            // Filter to recurring, non-archived
            let habits = captures.filter(c => c.recurrence_pattern && !c.is_archived);
            if (args.context) {
              habits = habits.filter(h => h.context === args.context);
            }

            // Find habits completed today
            const completedTodayIds = new Set<string>();
            for (const h of history) {
              const action = parseDate(h.action_date);
              if (action && action >= tStart && action <= tEnd &&
                  (h.status === 'completed' || h.status === 'partial')) {
                completedTodayIds.add(h.task_id);
              }
            }

            const organized: Record<string, Capture[]> = {
              overdue: [],
              due_now: [],
              due_today: [],
              due_later: [],
              completed_today: [],
            };

            const tomorrowEnd = new Date(tEnd);
            tomorrowEnd.setDate(tomorrowEnd.getDate() + 1);
            const weekEnd = new Date(tEnd);
            weekEnd.setDate(weekEnd.getDate() + 7);

            for (const habit of habits) {
              if (completedTodayIds.has(habit.id)) {
                if (args.include_completed) {
                  habit.completed_today = true;
                  organized.completed_today.push(habit);
                }
                continue;
              }

              const nextDue = parseDate(habit.next_due);
              if (!nextDue) continue;

              const flex = habit.recurrence_flex || 'normal';

              // Apply timeframe filter
              if (timeframe === 'today' && nextDue > tEnd && !isOverdue(nextDue, flex, now)) continue;
              if (timeframe === 'tomorrow') {
                const tomorrowStart = new Date(tomorrowEnd);
                tomorrowStart.setHours(0, 0, 0, 0);
                if (nextDue < tomorrowStart || nextDue > tomorrowEnd) continue;
              }
              if (timeframe === 'week' && nextDue > weekEnd) continue;
              if (timeframe === 'overdue' && !isOverdue(nextDue, flex, now)) continue;

              // Categorize
              if (isOverdue(nextDue, flex, now)) {
                organized.overdue.push(habit);
              } else if (nextDue.toDateString() === now.toDateString()) {
                if (habit.recurrence_time && nextDue <= now) {
                  organized.due_now.push(habit);
                } else {
                  organized.due_today.push(habit);
                }
              } else {
                organized.due_later.push(habit);
              }
            }

            const totalDue = organized.overdue.length + organized.due_now.length + organized.due_today.length;
            return ok({
              success: true,
              timeframe,
              habits: organized,
              summary: {
                total_due_today: totalDue,
                completed_today: organized.completed_today.length,
                overdue: organized.overdue.length,
                has_time_sensitive: organized.due_now.length > 0,
              },
              context_filter: args.context || null,
            });
          } catch (e) {
            return err(`Habits check failed: ${e instanceof Error ? e.message : String(e)}`);
          }
        },
      ),

    ],
  });
}
