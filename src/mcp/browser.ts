/**
 * Browser MCP Server - Playwright-powered web browsing
 * Runs in the host process (OUTSIDE the sandbox) so it has network access
 *
 * Provides read-heavy browsing: navigate, snapshot, click, screenshot.
 * No form filling or JS evaluation — minimizes attack surface.
 *
 * Playwright is an optional runtime dependency. If not installed, all tools
 * return helpful error messages. Install with:
 *   npm install playwright && npx playwright install chromium
 */

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import dns from 'dns/promises';
import net from 'net';
import path from 'path';
import fs from 'fs';
import { checkRateLimit } from '../lib/rate-limit.js';

interface BrowserMcpOptions {
  workDir: string;
}

// --- URL Validation ---

const BLOCKED_HOSTNAME_PATTERNS = [
  /^localhost$/i,
  /^localhost\./i,
  /\.local$/i,
  /\.internal$/i,
  /\.lan$/i,
];

function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const parts = ip.split('.').map(Number);
    if (parts[0] === 127) return true;
    if (parts[0] === 10) return true;
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    if (parts[0] === 192 && parts[1] === 168) return true;
    if (parts[0] === 169 && parts[1] === 254) return true;
    if (parts[0] === 0) return true;
  }
  if (net.isIPv6(ip)) {
    const normalized = ip.toLowerCase();
    if (normalized === '::1') return true;
    if (normalized.startsWith('fe80')) return true;
    if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true;
  }
  return false;
}

async function validateUrl(urlStr: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(urlStr);
  } catch {
    throw new Error(`Invalid URL: ${urlStr}`);
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error(`Only http/https URLs allowed, got: ${parsed.protocol}`);
  }

  const hostname = parsed.hostname;

  // Fast hostname pattern check
  for (const pattern of BLOCKED_HOSTNAME_PATTERNS) {
    if (pattern.test(hostname)) {
      throw new Error(`Private/local hostname blocked: ${hostname}`);
    }
  }

  // Check if hostname is an IP literal
  if (net.isIP(hostname)) {
    if (isPrivateIp(hostname)) {
      throw new Error(`Private IP blocked: ${hostname}`);
    }
    return;
  }

  // DNS resolution check — catches public hostnames resolving to private IPs
  try {
    const addresses4 = await dns.resolve4(hostname).catch(() => [] as string[]);
    const addresses6 = await dns.resolve6(hostname).catch(() => [] as string[]);
    for (const addr of [...addresses4, ...addresses6]) {
      if (isPrivateIp(addr)) {
        throw new Error(`Hostname "${hostname}" resolves to private IP ${addr} — blocked`);
      }
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes('blocked')) throw err;
    // DNS failure for other reasons — let playwright try
    console.log(`[browser] DNS pre-check warning for ${hostname}: ${err instanceof Error ? err.message : err}`);
  }
}

// --- Browser lifecycle (singleton) ---

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let browserInstance: any = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let pageInstance: any = null;
let closeTimer: ReturnType<typeof setTimeout> | undefined;

const BROWSER_IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 min

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function loadPlaywright(): Promise<any> {
  // Dynamic import via variable expression — bypasses TypeScript module resolution
  // so the project compiles without playwright installed
  const moduleName = 'playwright';
  return import(moduleName);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function ensurePage(): Promise<any> {
  if (pageInstance) {
    resetCloseTimer();
    return pageInstance;
  }

  const pw = await loadPlaywright();
  browserInstance = await pw.chromium.launch({
    headless: true,
    args: ['--disable-dev-shm-usage'],
  });
  pageInstance = await browserInstance.newPage();
  resetCloseTimer();
  console.log('[browser] Browser launched');
  return pageInstance;
}

async function closeBrowser(): Promise<void> {
  if (closeTimer) {
    clearTimeout(closeTimer);
    closeTimer = undefined;
  }
  if (browserInstance) {
    try { await browserInstance.close(); } catch { /* best-effort */ }
    browserInstance = null;
    pageInstance = null;
    refMap.clear();
    console.log('[browser] Browser closed (idle timeout)');
  }
}

function resetCloseTimer(): void {
  if (closeTimer) clearTimeout(closeTimer);
  closeTimer = setTimeout(() => closeBrowser(), BROWSER_IDLE_TIMEOUT_MS);
}

// --- Accessibility snapshot via Playwright's _snapshotForAI ---

interface SnapshotResult {
  snapshotPath: string;  // absolute path to full snapshot file (empty if no snapshot)
  chars: number;         // total snapshot size
  refs: number;          // count of interactive refs found
  index: string;         // structured summary: headings, links, buttons, inputs
}

let refMap = new Map<string, { role: string; name: string }>();

/** Parse _snapshotForAI output to build refMap for click handler */
function buildRefMap(snapshot: string): void {
  refMap = new Map();
  // Match lines like: `- link "Learn more" [ref=e6]` or `- button "Submit" [ref=e42] [cursor=pointer]`
  const refPattern = /- (\w+)\s*(?:"([^"]*)")?\s*(?:\[.*?\]\s*)*\[ref=(e\d+)\]/g;
  let match;
  while ((match = refPattern.exec(snapshot)) !== null) {
    refMap.set(match[3], { role: match[1], name: match[2] || '' });
  }
}

const INDEXED_ROLES = ['heading', 'link', 'button', 'textbox', 'combobox',
  'checkbox', 'radio', 'tab', 'searchbox', 'spinbutton'];

/** Build a structured index of meaningful elements from the snapshot */
function buildIndex(snapshot: string): string {
  const lines = snapshot.split('\n');
  const sections: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    const match = line.match(/^- (\w+)\s*(?:"([^"]*)")?\s*(.*)/);
    if (!match) continue;
    const [, role, name, rest] = match;
    if (!INDEXED_ROLES.includes(role)) continue;

    // Extract ref from rest
    const refMatch = rest.match(/\[ref=(e\d+)\]/);
    const ref = refMatch ? refMatch[1] : '';

    // For links, capture the URL from the next line
    let url = '';
    if (role === 'link' && i + 1 < lines.length) {
      const urlMatch = lines[i + 1].match(/\/url:\s*(.+)/);
      if (urlMatch) url = urlMatch[1].trim();
    }

    // Format based on role
    if (role === 'heading') {
      const levelMatch = rest.match(/\[level=(\d+)\]/);
      const level = levelMatch ? '#'.repeat(Number(levelMatch[1])) : '#';
      sections.push(`${level} ${name || '(untitled)'}${ref ? ` [ref=${ref}]` : ''}`);
    } else if (role === 'link' && url) {
      sections.push(`- link "${name || ''}" → ${url}${ref ? ` [ref=${ref}]` : ''}`);
    } else if (role === 'link') {
      sections.push(`- link "${name || ''}"${ref ? ` [ref=${ref}]` : ''}`);
    } else {
      sections.push(`- ${role} "${name || ''}"${ref ? ` [ref=${ref}]` : ''}`);
    }
  }

  const index = sections.join('\n');
  return index.length > 10_000
    ? index.slice(0, 10_000) + `\n[... ${sections.length} total elements]`
    : index;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function getSnapshot(page: any, workDir: string): Promise<SnapshotResult> {
  const result = await page._snapshotForAI();
  if (!result?.full) {
    return { snapshotPath: '', chars: 0, refs: 0, index: '(empty page — no accessibility tree available)' };
  }

  const snapshot = result.full;
  buildRefMap(snapshot);

  // Write full snapshot to disk
  const browserDir = path.join(workDir, 'browser');
  fs.mkdirSync(browserDir, { recursive: true });
  const snapshotPath = path.join(browserDir, 'snapshot.txt');
  fs.writeFileSync(snapshotPath, snapshot, 'utf-8');

  // Build structured index
  const index = buildIndex(snapshot);

  return { snapshotPath, chars: snapshot.length, refs: refMap.size, index };
}

// --- MCP Server ---

export function createBrowserMcp({ workDir }: BrowserMcpOptions) {
  // Check playwright availability at construction (non-blocking)
  let playwrightAvailable: boolean | null = null;
  loadPlaywright()
    .then((pw) => {
      playwrightAvailable = true;
      console.log('[browser] Playwright available');
    })
    .catch(() => {
      playwrightAvailable = false;
      console.log('[browser] Playwright not installed — browser tools will return errors. Install: npm install playwright && npx playwright install chromium');
    });

  function playwrightUnavailable() {
    return {
      content: [{ type: 'text' as const, text: 'Playwright not installed. Install with: npm install playwright && npx playwright install chromium' }],
      isError: true,
    };
  }

  return createSdkMcpServer({
    name: 'browser',
    version: '1.0.0',
    tools: [
      tool(
        'navigate',
        `Open a URL in the browser and return the page's accessibility tree. Use when you need to interact with a JS-heavy page or read content that firecrawl can't handle. See browser skill for decision tree.`,
        {
          url: z.string().describe('URL to navigate to (http/https only, no private/local addresses)'),
        },
        async (args) => {
          if (playwrightAvailable === false) return playwrightUnavailable();

          const limit = checkRateLimit('browser', 100);
          if (!limit.allowed) {
            return { content: [{ type: 'text' as const, text: limit.message }], isError: true };
          }

          try {
            await validateUrl(args.url);
            const page = await ensurePage();
            await page.goto(args.url, { waitUntil: 'domcontentloaded', timeout: 30_000 });

            // H-NEW-7: Validate redirect destination
            const finalUrl = page.url();
            if (finalUrl !== args.url) {
              try {
                await validateUrl(finalUrl);
              } catch (err) {
                await page.goto('about:blank').catch(() => {});
                throw err;
              }
            }

            const title = await page.title();
            const url = page.url();
            const snap = await getSnapshot(page, workDir);

            const header = snap.snapshotPath
              ? `Page: ${title}\nURL: ${url}\nSnapshot: ${snap.snapshotPath} (${snap.chars} chars, ${snap.refs} interactive refs)`
              : `Page: ${title}\nURL: ${url}`;

            return {
              content: [{
                type: 'text' as const,
                text: `${header}\n\n${snap.index}`,
              }],
            };
          } catch (err) {
            return {
              content: [{ type: 'text' as const, text: `Navigate failed: ${err instanceof Error ? err.message : String(err)}` }],
              isError: true,
            };
          }
        },
      ),

      tool(
        'snapshot',
        `Get the current page's accessibility tree without navigating. Use after clicking or waiting for content to load. Returns the same tree format as navigate.`,
        {},
        async () => {
          if (playwrightAvailable === false) return playwrightUnavailable();

          const limit = checkRateLimit('browser', 100);
          if (!limit.allowed) {
            return { content: [{ type: 'text' as const, text: limit.message }], isError: true };
          }

          try {
            if (!pageInstance) {
              return {
                content: [{ type: 'text' as const, text: 'No page open. Use navigate first.' }],
                isError: true,
              };
            }

            // H-NEW-7: Defense-in-depth — validate current URL before returning snapshot
            const currentUrl = pageInstance.url();
            if (currentUrl.startsWith('http:') || currentUrl.startsWith('https:')) {
              try {
                await validateUrl(currentUrl);
              } catch (err) {
                await pageInstance.goto('about:blank').catch(() => {});
                throw err;
              }
            }

            const title = await pageInstance.title();
            const url = pageInstance.url();
            const snap = await getSnapshot(pageInstance, workDir);

            const header = snap.snapshotPath
              ? `Page: ${title}\nURL: ${url}\nSnapshot: ${snap.snapshotPath} (${snap.chars} chars, ${snap.refs} interactive refs)`
              : `Page: ${title}\nURL: ${url}`;

            return {
              content: [{
                type: 'text' as const,
                text: `${header}\n\n${snap.index}`,
              }],
            };
          } catch (err) {
            return {
              content: [{ type: 'text' as const, text: `Snapshot failed: ${err instanceof Error ? err.message : String(err)}` }],
              isError: true,
            };
          }
        },
      ),

      tool(
        'click',
        `Click an interactive element by its ref number from the accessibility snapshot. Returns the updated accessibility tree. Use for cookie banners, pagination, "show more" buttons.`,
        {
          ref: z.string().describe('The ref from the accessibility snapshot (e.g., "e6")'),
        },
        async (args) => {
          if (playwrightAvailable === false) return playwrightUnavailable();

          const limit = checkRateLimit('browser', 100);
          if (!limit.allowed) {
            return { content: [{ type: 'text' as const, text: limit.message }], isError: true };
          }

          try {
            if (!pageInstance) {
              return {
                content: [{ type: 'text' as const, text: 'No page open. Use navigate first.' }],
                isError: true,
              };
            }

            const info = refMap.get(args.ref);
            if (!info) {
              return {
                content: [{ type: 'text' as const, text: `Unknown ref: ${args.ref}. Take a new snapshot to get current refs.` }],
                isError: true,
              };
            }

            // Use getByRole to locate the element
            const locator = info.name
              ? pageInstance.getByRole(info.role, { name: info.name, exact: false })
              : pageInstance.getByRole(info.role);

            const urlBefore = pageInstance.url();
            await locator.first().click({ timeout: 10_000 });

            // Brief wait for page to react
            await pageInstance.waitForTimeout(500);

            // H-NEW-7: Validate post-click URL if navigation occurred
            const urlAfter = pageInstance.url();
            if (urlAfter !== urlBefore) {
              try {
                await validateUrl(urlAfter);
              } catch (err) {
                await pageInstance.goto('about:blank').catch(() => {});
                throw err;
              }
            }

            const title = await pageInstance.title();
            const url = pageInstance.url();
            const snap = await getSnapshot(pageInstance, workDir);

            const header = snap.snapshotPath
              ? `Clicked: ${info.role} "${info.name}"\nPage: ${title}\nURL: ${url}\nSnapshot: ${snap.snapshotPath} (${snap.chars} chars, ${snap.refs} interactive refs)`
              : `Clicked: ${info.role} "${info.name}"\nPage: ${title}\nURL: ${url}`;

            return {
              content: [{
                type: 'text' as const,
                text: `${header}\n\n${snap.index}`,
              }],
            };
          } catch (err) {
            return {
              content: [{ type: 'text' as const, text: `Click failed: ${err instanceof Error ? err.message : String(err)}` }],
              isError: true,
            };
          }
        },
      ),

      tool(
        'screenshot',
        `Capture a screenshot of the current page. Saves to the workspace media directory. Use when visual context is needed or to verify page state.`,
        {
          filename: z.string().optional().describe('Filename for screenshot (default: screenshot-{timestamp}.png)'),
          full_page: z.boolean().optional().describe('Capture full scrollable page (default: false)'),
        },
        async (args) => {
          if (playwrightAvailable === false) return playwrightUnavailable();

          const limit = checkRateLimit('browser', 100);
          if (!limit.allowed) {
            return { content: [{ type: 'text' as const, text: limit.message }], isError: true };
          }

          try {
            if (!pageInstance) {
              return {
                content: [{ type: 'text' as const, text: 'No page open. Use navigate first.' }],
                isError: true,
              };
            }

            const filename = args.filename || `screenshot-${Date.now()}.png`;
            // Sanitize filename: strip path separators and control chars
            const safeName = filename.replace(/[/\\:*?"<>|\x00-\x1f]/g, '_');

            const mediaDir = path.join(workDir, 'media');
            fs.mkdirSync(mediaDir, { recursive: true });
            const outputPath = path.join(mediaDir, safeName);

            // Verify output stays within workspace
            const resolved = path.resolve(outputPath);
            if (!resolved.startsWith(path.resolve(workDir)) && !resolved.startsWith('/tmp/')) {
              return {
                content: [{ type: 'text' as const, text: `Screenshot path must be within workspace: ${resolved}` }],
                isError: true,
              };
            }

            await pageInstance.screenshot({
              path: resolved,
              fullPage: args.full_page ?? false,
            });

            const stat = fs.statSync(resolved);
            console.log(`[browser] Screenshot saved: ${resolved} (${stat.size} bytes)`);

            return {
              content: [{
                type: 'text' as const,
                text: `Screenshot saved: ${resolved} (${Math.round(stat.size / 1024)}KB)`,
              }],
            };
          } catch (err) {
            return {
              content: [{ type: 'text' as const, text: `Screenshot failed: ${err instanceof Error ? err.message : String(err)}` }],
              isError: true,
            };
          }
        },
      ),
    ],
  });
}
