/**
 * Firecrawl MCP Server - Web scraping via Firecrawl API
 * Runs in the host process (OUTSIDE the sandbox) so it has network access for API calls
 */

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { checkRateLimit } from '../lib/rate-limit.js';

interface FirecrawlMcpOptions {
  firecrawlApiKey: string;
}

const MAX_CONTENT_LENGTH = 50_000;

async function firecrawlRequest(
  apiKey: string,
  endpoint: string,
  body: Record<string, unknown>,
  timeoutMs: number = 30_000,
): Promise<unknown> {
  const response = await fetch(`https://api.firecrawl.dev/v1/${endpoint}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    signal: AbortSignal.timeout(timeoutMs),
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Firecrawl API error (${response.status}): ${errText}`);
  }

  return response.json();
}

function truncateContent(text: string): string {
  if (text.length <= MAX_CONTENT_LENGTH) return text;
  return text.slice(0, MAX_CONTENT_LENGTH) + `\n\n[Truncated — ${text.length} total chars, showing first ${MAX_CONTENT_LENGTH}]`;
}

export function createFirecrawlMcp({ firecrawlApiKey }: FirecrawlMcpOptions) {
  return createSdkMcpServer({
    name: 'firecrawl',
    version: '1.0.0',
    tools: [
      tool(
        'scrape',
        `Extract content from a web page as markdown. Use when you have a specific URL and need the actual page content — not a search answer. Returns clean markdown. See firecrawl skill for decision tree.`,
        {
          url: z.string().url().describe('The URL to scrape'),
          formats: z.array(z.enum(['markdown', 'html', 'rawHtml', 'links', 'screenshot'])).optional()
            .describe('Output formats (default: ["markdown"])'),
          only_main_content: z.boolean().optional()
            .describe('Extract only main content, removing navs/footers (default: true)'),
          wait_for: z.number().max(30000).optional()
            .describe('Wait N ms for JS to render before scraping'),
        },
        async (args) => {
          if (!firecrawlApiKey) {
            return {
              content: [{ type: 'text' as const, text: 'FIRECRAWL_API_KEY not set. Cannot scrape.' }],
              isError: true,
            };
          }

          const limit = checkRateLimit('firecrawl', 100);
          if (!limit.allowed) {
            return { content: [{ type: 'text' as const, text: limit.message }], isError: true };
          }

          try {
            const body: Record<string, unknown> = {
              url: args.url,
              formats: args.formats || ['markdown'],
              onlyMainContent: args.only_main_content ?? true,
            };
            if (args.wait_for) body.waitFor = args.wait_for;

            const data = await firecrawlRequest(firecrawlApiKey, 'scrape', body) as {
              success?: boolean;
              data?: {
                markdown?: string;
                html?: string;
                links?: string[];
                metadata?: {
                  title?: string;
                  description?: string;
                  sourceURL?: string;
                };
              };
              error?: string;
            };

            if (!data.success || !data.data) {
              throw new Error(data.error || 'Scrape returned no data');
            }

            const { markdown, html, links, metadata } = data.data;
            let result = '';
            if (metadata?.title) result += `# ${metadata.title}\n`;
            if (metadata?.sourceURL) result += `Source: ${metadata.sourceURL}\n`;
            if (result) result += '\n';

            if (markdown) {
              result += truncateContent(markdown);
            } else if (html) {
              result += truncateContent(html);
            }

            if (links?.length) {
              result += `\n\nLinks found: ${links.length}`;
            }

            console.log(`[firecrawl] Scraped ${args.url}: ${result.length} chars`);

            return {
              content: [{ type: 'text' as const, text: result || 'Scrape returned empty content.' }],
            };
          } catch (err) {
            return {
              content: [{ type: 'text' as const, text: `Scrape failed: ${err instanceof Error ? err.message : String(err)}` }],
              isError: true,
            };
          }
        },
      ),

      tool(
        'search_and_scrape',
        `Search the web and extract content from top results. Combines search with full-page scraping — use when you need actual page content, not a synthesized answer. Set scrape_limit to 0 for URL-only results. See firecrawl skill for when to use this vs mcp__search__ask.`,
        {
          query: z.string().describe('Search query'),
          scrape_limit: z.number().min(0).max(5).optional()
            .describe('Number of results to scrape full content (0 = URLs only, default: 3)'),
          num_results: z.number().min(1).max(10).optional()
            .describe('Number of search results to return (default: 5)'),
        },
        async (args) => {
          if (!firecrawlApiKey) {
            return {
              content: [{ type: 'text' as const, text: 'FIRECRAWL_API_KEY not set. Cannot search.' }],
              isError: true,
            };
          }

          const limit = checkRateLimit('firecrawl', 100);
          if (!limit.allowed) {
            return { content: [{ type: 'text' as const, text: limit.message }], isError: true };
          }

          try {
            const scrapeLimit = args.scrape_limit ?? 3;
            const numResults = args.num_results ?? 5;

            const body: Record<string, unknown> = {
              query: args.query,
              limit: numResults,
            };
            if (scrapeLimit > 0) {
              body.scrapeOptions = {
                formats: ['markdown'],
                onlyMainContent: true,
              };
            }

            const data = await firecrawlRequest(
              firecrawlApiKey,
              'search',
              body,
              60_000,
            ) as {
              success?: boolean;
              data?: Array<{
                url?: string;
                title?: string;
                description?: string;
                markdown?: string;
              }>;
              error?: string;
            };

            if (!data.success || !data.data?.length) {
              return {
                content: [{ type: 'text' as const, text: data.error || 'No search results found.' }],
                isError: !data.success,
              };
            }

            let result = `Search results for: "${args.query}"\n\n`;
            const toScrape = scrapeLimit > 0 ? data.data.slice(0, scrapeLimit) : [];
            const urlOnly = scrapeLimit > 0 ? data.data.slice(scrapeLimit) : data.data;

            for (const item of toScrape) {
              result += `---\n## ${item.title || 'Untitled'}\n`;
              result += `URL: ${item.url || 'unknown'}\n\n`;
              if (item.markdown) {
                result += truncateContent(item.markdown) + '\n\n';
              } else if (item.description) {
                result += item.description + '\n\n';
              }
            }

            if (urlOnly.length > 0) {
              if (toScrape.length > 0) result += '---\n## Additional results\n\n';
              for (const item of urlOnly) {
                result += `- [${item.title || item.url}](${item.url})`;
                if (item.description) result += ` — ${item.description}`;
                result += '\n';
              }
            }

            console.log(`[firecrawl] Search "${args.query}": ${data.data.length} results, ${toScrape.length} scraped`);

            return {
              content: [{ type: 'text' as const, text: result }],
            };
          } catch (err) {
            return {
              content: [{ type: 'text' as const, text: `Search and scrape failed: ${err instanceof Error ? err.message : String(err)}` }],
              isError: true,
            };
          }
        },
      ),
    ],
  });
}
