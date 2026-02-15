/**
 * API Logging Proxy — intercepts SDK → Anthropic API traffic for visibility.
 *
 * Sets ANTHROPIC_BASE_URL to http://localhost:PORT so the SDK subprocess
 * sends cleartext HTTP here. This proxy logs the full request body (system
 * prompt, tools, messages) and response usage, then forwards to the real
 * https://api.anthropic.com over HTTPS.
 *
 * Controlled by API_LOG_PROXY env var — opt-in only.
 */

import http from 'http';
import https from 'https';
import fs from 'fs';
import path from 'path';

let server: http.Server | undefined;
let cleanupTimer: ReturnType<typeof setInterval> | undefined;

// Session tracking state
let currentSessionId = '';
let currentSessionLabel = '';
let callNum = 0;

/** Paths to skip logging entirely — they're noise. */
const SKIP_PATHS = ['/api/event_logging/batch', '/v1/messages/count_tokens'];

function ensureLogDir(logDir: string): void {
  fs.mkdirSync(logDir, { recursive: true });
}

function hourlyLogPath(logDir: string): string {
  const now = new Date();
  const stamp = now.toISOString().slice(0, 13).replace(/[T:]/g, '-'); // YYYY-MM-DD-HH
  return path.join(logDir, `api-${stamp}.jsonl`);
}

function cleanOldLogs(logDir: string, maxAgeMs = 24 * 60 * 60 * 1000): void {
  try {
    const files = fs.readdirSync(logDir);
    const cutoff = Date.now() - maxAgeMs;
    for (const file of files) {
      if (!file.endsWith('.jsonl')) continue;
      const filePath = path.join(logDir, file);
      try {
        const stat = fs.statSync(filePath);
        if (stat.mtimeMs < cutoff) {
          fs.unlinkSync(filePath);
          console.log(`[api-proxy] Cleaned old log: ${file}`);
        }
      } catch { /* ignore per-file errors */ }
    }
  } catch { /* logDir may not exist yet */ }
}

function appendLog(logDir: string, entry: Record<string, unknown>): void {
  try {
    const logPath = hourlyLogPath(logDir);
    fs.appendFileSync(logPath, JSON.stringify(entry) + '\n');
  } catch (err) {
    console.error('[api-proxy] Failed to write log:', err);
  }
}

interface UsageInfo {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

/**
 * Extract usage from a streamed SSE response body.
 * Looks for message_start (input + cache) and message_delta (output) events.
 */
function extractUsageFromSSE(body: string): UsageInfo {
  const usage: UsageInfo = {};

  const lines = body.split('\n');
  for (const line of lines) {
    if (!line.startsWith('data: ')) continue;
    const data = line.slice(6);
    if (data === '[DONE]') continue;
    try {
      const parsed = JSON.parse(data);
      if (parsed.type === 'message_start' && parsed.message?.usage) {
        const u = parsed.message.usage;
        usage.input_tokens = u.input_tokens;
        if (u.cache_creation_input_tokens) usage.cache_creation_input_tokens = u.cache_creation_input_tokens;
        if (u.cache_read_input_tokens) usage.cache_read_input_tokens = u.cache_read_input_tokens;
      }
      if (parsed.type === 'message_delta' && parsed.usage) {
        usage.output_tokens = parsed.usage.output_tokens;
      }
    } catch { /* not JSON, skip */ }
  }

  return usage;
}

export function startApiProxy(port: number, logDir: string): void {
  ensureLogDir(logDir);
  cleanOldLogs(logDir);

  // Clean old logs every hour
  cleanupTimer = setInterval(() => cleanOldLogs(logDir), 60 * 60 * 1000);

  server = http.createServer((req, res) => {
    const startTime = Date.now();
    const chunks: Buffer[] = [];
    const requestPath = req.url || '';
    const shouldLog = !SKIP_PATHS.some(p => requestPath.startsWith(p));

    req.on('data', (chunk: Buffer) => chunks.push(chunk));

    req.on('end', () => {
      const requestBody = Buffer.concat(chunks).toString('utf-8');

      // Parse request for logging metadata
      let parsedBody: any = {};
      try {
        parsedBody = JSON.parse(requestBody);
      } catch { /* not JSON */ }

      const toolNames: string[] = (parsedBody.tools || []).map((t: any) => t.name).filter(Boolean);

      // Session tracking — extract session ID from metadata.user_id
      if (shouldLog) {
        const userId: string = parsedBody.metadata?.user_id || '';
        const sessionMatch = userId.match(/session_([0-9a-f-]+)/);
        const sessionId = sessionMatch ? sessionMatch[1] : '';

        if (sessionId && sessionId !== currentSessionId) {
          currentSessionId = sessionId;
          currentSessionLabel = sessionId.slice(0, 8);
          callNum = 0;
        }
        callNum++;
      }

      // Forward to real Anthropic API
      const forwardHeaders: Record<string, string> = {};
      for (const [key, value] of Object.entries(req.headers)) {
        if (key === 'host' || key === 'connection') continue;
        if (typeof value === 'string') forwardHeaders[key] = value;
        if (Array.isArray(value)) forwardHeaders[key] = value.join(', ');
      }

      const forwardReq = https.request(
        {
          hostname: 'api.anthropic.com',
          port: 443,
          path: req.url,
          method: req.method,
          headers: forwardHeaders,
        },
        (forwardRes) => {
          // Stream response headers back to client
          res.writeHead(forwardRes.statusCode || 502, forwardRes.headers);

          const responseChunks: Buffer[] = [];

          forwardRes.on('data', (chunk: Buffer) => {
            responseChunks.push(chunk);
            res.write(chunk);
          });

          forwardRes.on('end', () => {
            res.end();

            const duration = Date.now() - startTime;
            const responseBody = Buffer.concat(responseChunks).toString('utf-8');

            if (!shouldLog) return;

            // Extract usage from streaming SSE or JSON response
            let usage: UsageInfo = {};
            const contentType = forwardRes.headers['content-type'] || '';

            if (contentType.includes('text/event-stream')) {
              usage = extractUsageFromSSE(responseBody);
            } else {
              try {
                const jsonResponse = JSON.parse(responseBody);
                if (jsonResponse.usage) {
                  usage.input_tokens = jsonResponse.usage.input_tokens;
                  usage.output_tokens = jsonResponse.usage.output_tokens;
                  if (jsonResponse.usage.cache_creation_input_tokens)
                    usage.cache_creation_input_tokens = jsonResponse.usage.cache_creation_input_tokens;
                  if (jsonResponse.usage.cache_read_input_tokens)
                    usage.cache_read_input_tokens = jsonResponse.usage.cache_read_input_tokens;
                }
              } catch { /* not JSON */ }
            }

            const logEntry: Record<string, unknown> = {
              ts: new Date().toISOString(),
              session_id: currentSessionLabel,
              call_num: callNum,
              method: req.method,
              path: req.url,
              status: forwardRes.statusCode,
              model: parsedBody.model,
              tool_count: toolNames.length,
              tool_names: toolNames,
              system_prompt_chars: typeof parsedBody.system === 'string'
                ? parsedBody.system.length
                : Array.isArray(parsedBody.system)
                  ? parsedBody.system.reduce((n: number, b: any) => n + (b.text?.length || 0), 0)
                  : 0,
              message_count: Array.isArray(parsedBody.messages) ? parsedBody.messages.length : 0,
              input_tokens: usage.input_tokens,
              output_tokens: usage.output_tokens,
              cache_creation_input_tokens: usage.cache_creation_input_tokens,
              cache_read_input_tokens: usage.cache_read_input_tokens,
              duration_ms: duration,
              request_body: parsedBody,
            };

            appendLog(logDir, logEntry);

            console.log(
              `[api-proxy] [${currentSessionLabel}#${callNum}] ${req.method} ${req.url} → ${forwardRes.statusCode} ` +
              `(${usage.input_tokens || '?'}in/${usage.output_tokens || '?'}out, ${duration}ms)`,
            );
          });
        },
      );

      forwardReq.on('error', (err) => {
        console.error('[api-proxy] Forward error:', err);
        res.writeHead(502);
        res.end('Proxy error');

        if (shouldLog) {
          appendLog(logDir, {
            ts: new Date().toISOString(),
            session_id: currentSessionLabel,
            call_num: callNum,
            method: req.method,
            path: req.url,
            error: String(err),
            duration_ms: Date.now() - startTime,
          });
        }
      });

      forwardReq.write(requestBody);
      forwardReq.end();
    });
  });

  server.listen(port, '127.0.0.1', () => {
    console.log(`[api-proxy] Listening on http://127.0.0.1:${port}`);
  });
}

export function stopApiProxy(): void {
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = undefined;
  }
  if (server) {
    server.close();
    server = undefined;
    console.log('[api-proxy] Stopped');
  }
}
