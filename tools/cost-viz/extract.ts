/**
 * extract.ts — Parse API proxy JSONL logs into compact JSON for visualization.
 *
 * Usage: bun tools/cost-viz/extract.ts <raw-dir> > tools/cost-viz/data/sessions.json
 *
 * Reads all *.jsonl files from the directory, classifies request content into
 * 8 input categories, applies cache waterfall attribution, and computes actual
 * costs from API-reported token counts.
 */

import { readdir, readFile } from "fs/promises";
import { join } from "path";

// --- Pricing ---
const PRICING = {
  standard: {
    input: 5 / 1_000_000,
    cache_write: 6.25 / 1_000_000,
    cache_read: 0.5 / 1_000_000,
    output: 25 / 1_000_000,
  },
  long: {
    input: 10 / 1_000_000,
    cache_write: 12.5 / 1_000_000,
    cache_read: 1.0 / 1_000_000,
    output: 37.5 / 1_000_000,
  },
};

// --- Types ---
interface LogEntry {
  ts: string;
  session_id: string;
  call_num: number;
  method: string;
  path: string;
  status: number;
  model: string;
  tool_count: number;
  tool_names: string[];
  system_prompt_chars: number;
  message_count: number;
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  duration_ms: number;
  request_body: any;
}

interface CategoryBreakdown {
  chars: number;
  est_tokens: number;
  cache_read: number;
  cache_creation: number;
  uncached: number;
}

interface Block {
  type: string;
  chars: number;
  est_tokens: number;
  cache_read: number;
  cache_creation: number;
  uncached: number;
}

interface PrefixMutation {
  section: "system" | "tools" | "sdk_injected";
  section_index?: number;
  prev_len: number;
  curr_len: number;
  divergence_count: number;
  first_diverge_at: number;
  context: string;
  tools_added?: string[];
  tools_removed?: string[];
}

interface ExtractedPrefix {
  system: string;
  tools: string;
  toolNames: string[];
  sdkBlocks: string[];
}

interface CallData {
  call_num: number;
  ts: string;
  api_tokens: {
    input: number;
    cache_creation: number;
    cache_read: number;
    output: number;
  };
  long_context: boolean;
  cost_usd: {
    input: number;
    cache_creation: number;
    cache_read: number;
    output: number;
    total: number;
  };
  categories: Record<string, CategoryBreakdown>;
  blocks: Block[];
  is_subagent: boolean;
  output_tokens: number;
  message_count: number;
  tool_count: number;
  tool_names: string[];
  duration_ms: number;
  prefix_mutations: PrefixMutation[] | null;
}

interface SessionData {
  session_id: string;
  first_ts: string;
  call_count: number;
  total_cost_usd: number;
  calls: CallData[];
}

// --- Category classification ---

const CATEGORY_ORDER = [
  "system",
  "tools",
  "sdk_injected",
  "user_messages",
  "thinking",
  "response_text",
  "tool_calls",
  "tool_results",
];

function classifyContent(requestBody: any): Record<string, { chars: number }> {
  const cats: Record<string, { chars: number }> = {};
  for (const c of CATEGORY_ORDER) cats[c] = { chars: 0 };

  // 1. System prompt
  const sys = requestBody.system;
  if (typeof sys === "string") {
    cats.system.chars += sys.length;
  } else if (Array.isArray(sys)) {
    for (const block of sys) {
      cats.system.chars += block.text?.length || 0;
    }
  }

  // 2. Tool schemas — stringify each tool definition
  const tools = requestBody.tools || [];
  for (const tool of tools) {
    cats.tools.chars += JSON.stringify(tool).length;
  }

  // 3-8. Messages
  const messages = requestBody.messages || [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const role = msg.role;
    const content = msg.content;

    if (typeof content === "string") {
      if (role === "user") cats.user_messages.chars += content.length;
      else if (role === "assistant") cats.response_text.chars += content.length;
      continue;
    }

    if (!Array.isArray(content)) continue;

    for (let j = 0; j < content.length; j++) {
      const block = content[j];
      const btype = block.type;

      if (btype === "text") {
        const text: string = block.text || "";

        if (role === "user") {
          // First user message (i=0) is composite — SDK injects blocks
          if (i === 0) {
            const isSdkInjected =
              text.includes("<system-reminder>") ||
              text.startsWith("USD budget:");

            if (isSdkInjected) {
              cats.sdk_injected.chars += text.length;
            } else {
              // Last text block in msg[0] without system-reminder = user message
              cats.user_messages.chars += text.length;
            }
          } else {
            // Non-first user messages: text blocks are user text
            cats.user_messages.chars += text.length;
          }
        } else if (role === "assistant") {
          cats.response_text.chars += text.length;
        }
      } else if (btype === "thinking") {
        cats.thinking.chars += (block.thinking || "").length;
      } else if (btype === "tool_use") {
        cats.tool_calls.chars += JSON.stringify(block).length;
      } else if (btype === "tool_result") {
        // tool_result content can be string or array of blocks
        const rc = block.content;
        if (typeof rc === "string") {
          cats.tool_results.chars += rc.length;
        } else if (Array.isArray(rc)) {
          for (const rb of rc) {
            cats.tool_results.chars += JSON.stringify(rb).length;
          }
        }
        // Also count the wrapper overhead
        cats.tool_results.chars += 50; // tool_use_id, type, etc.
      }
    }
  }

  return cats;
}

// --- Chronological block extraction ---

function buildBlocks(
  requestBody: any,
  apiTokens: {
    input: number;
    cache_creation: number;
    cache_read: number;
    output: number;
  }
): Block[] {
  const rawBlocks: { type: string; chars: number }[] = [];

  // 1. System block
  let systemChars = 0;
  const sys = requestBody.system;
  if (typeof sys === "string") {
    systemChars = sys.length;
  } else if (Array.isArray(sys)) {
    for (const block of sys) {
      systemChars += block.text?.length || 0;
    }
  }
  if (systemChars > 0) {
    rawBlocks.push({ type: "system", chars: systemChars });
  }

  // 2. Tools block
  let toolsChars = 0;
  const tools = requestBody.tools || [];
  for (const tool of tools) {
    toolsChars += JSON.stringify(tool).length;
  }
  if (toolsChars > 0) {
    rawBlocks.push({ type: "tools", chars: toolsChars });
  }

  // 3. Walk messages in order
  const messages = requestBody.messages || [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const role = msg.role;
    const content = msg.content;

    if (typeof content === "string") {
      if (role === "user") {
        rawBlocks.push({ type: "user_message", chars: content.length });
      } else if (role === "assistant") {
        rawBlocks.push({ type: "response_text", chars: content.length });
      }
      continue;
    }

    if (!Array.isArray(content)) continue;

    for (const block of content) {
      const btype = block.type;

      if (btype === "text") {
        const text: string = block.text || "";
        if (role === "user") {
          if (i === 0) {
            const isSdkInjected =
              text.includes("<system-reminder>") ||
              text.startsWith("USD budget:");
            rawBlocks.push({
              type: isSdkInjected ? "sdk_injected" : "user_message",
              chars: text.length,
            });
          } else {
            rawBlocks.push({ type: "user_message", chars: text.length });
          }
        } else if (role === "assistant") {
          rawBlocks.push({ type: "response_text", chars: text.length });
        }
      } else if (btype === "thinking") {
        rawBlocks.push({
          type: "thinking",
          chars: (block.thinking || "").length,
        });
      } else if (btype === "tool_use") {
        rawBlocks.push({
          type: "tool_call",
          chars: JSON.stringify(block).length,
        });
      } else if (btype === "tool_result") {
        const rc = block.content;
        let chars = 50; // wrapper overhead
        if (typeof rc === "string") {
          chars += rc.length;
        } else if (Array.isArray(rc)) {
          for (const rb of rc) {
            chars += JSON.stringify(rb).length;
          }
        }
        rawBlocks.push({ type: "tool_result", chars });
      }
    }
  }

  // Merge adjacent same-type blocks
  const merged: { type: string; chars: number }[] = [];
  for (const block of rawBlocks) {
    if (merged.length > 0 && merged[merged.length - 1].type === block.type) {
      merged[merged.length - 1].chars += block.chars;
    } else {
      merged.push({ ...block });
    }
  }

  // Estimate tokens (chars/4) and scale to match actual API input total
  const actualInputTotal =
    apiTokens.input + apiTokens.cache_creation + apiTokens.cache_read;
  let totalEstTokens = 0;
  const withEst = merged.map((b) => {
    const est = Math.ceil(b.chars / 4);
    totalEstTokens += est;
    return { ...b, est_tokens: est };
  });

  const scaleFactor = totalEstTokens > 0 ? actualInputTotal / totalEstTokens : 0;
  const scaled = withEst.map((b) => ({
    ...b,
    est_tokens: Math.round(b.est_tokens * scaleFactor),
  }));

  // Fix rounding so scaled values sum to actualInputTotal
  const scaledSum = scaled.reduce((s, b) => s + b.est_tokens, 0);
  if (scaled.length > 0 && scaledSum !== actualInputTotal) {
    const largest = scaled.reduce((a, b) =>
      a.est_tokens > b.est_tokens ? a : b
    );
    largest.est_tokens += actualInputTotal - scaledSum;
  }

  // Cache waterfall on blocks: cache_read first, then cache_creation, then uncached
  let remainingCacheRead = apiTokens.cache_read;
  let remainingCacheCreation = apiTokens.cache_creation;

  const blocks: Block[] = scaled.map((b) => {
    let tokens = b.est_tokens;
    let cacheRead = 0;
    let cacheCreation = 0;
    let uncached = 0;

    if (remainingCacheRead > 0) {
      const take = Math.min(tokens, remainingCacheRead);
      cacheRead = take;
      remainingCacheRead -= take;
      tokens -= take;
    }

    if (tokens > 0 && remainingCacheCreation > 0) {
      const take = Math.min(tokens, remainingCacheCreation);
      cacheCreation = take;
      remainingCacheCreation -= take;
      tokens -= take;
    }

    uncached = tokens;

    return {
      type: b.type,
      chars: b.chars,
      est_tokens: b.est_tokens,
      cache_read: cacheRead,
      cache_creation: cacheCreation,
      uncached,
    };
  });

  // Add output block at the end (actual output_tokens, not estimated)
  blocks.push({
    type: "output",
    chars: 0,
    est_tokens: apiTokens.output,
    cache_read: 0,
    cache_creation: 0,
    uncached: 0,
  });

  return blocks;
}

// --- Cache waterfall ---

function applyCacheWaterfall(
  categories: Record<string, { chars: number }>,
  apiTokens: {
    input: number;
    cache_creation: number;
    cache_read: number;
  }
): Record<string, CategoryBreakdown> {
  // Estimate tokens per category (chars/4)
  const rawEstimates: { name: string; estTokens: number }[] = [];
  let totalEstTokens = 0;

  for (const cat of CATEGORY_ORDER) {
    const est = Math.ceil(categories[cat].chars / 4);
    rawEstimates.push({ name: cat, estTokens: est });
    totalEstTokens += est;
  }

  // Scale estimates to match actual API input total
  const actualInputTotal =
    apiTokens.input + apiTokens.cache_creation + apiTokens.cache_read;
  const scaleFactor = totalEstTokens > 0 ? actualInputTotal / totalEstTokens : 0;

  const scaled = rawEstimates.map((r) => ({
    name: r.name,
    estTokens: Math.round(r.estTokens * scaleFactor),
    chars: categories[r.name].chars,
  }));

  // Adjust rounding so scaled values sum to actualInputTotal
  const scaledSum = scaled.reduce((s, r) => s + r.estTokens, 0);
  if (scaled.length > 0 && scaledSum !== actualInputTotal) {
    // Add the difference to the largest category
    const largest = scaled.reduce((a, b) =>
      a.estTokens > b.estTokens ? a : b
    );
    largest.estTokens += actualInputTotal - scaledSum;
  }

  // Waterfall: consume cache_read first, then cache_creation, then uncached
  let remainingCacheRead = apiTokens.cache_read;
  let remainingCacheCreation = apiTokens.cache_creation;

  const result: Record<string, CategoryBreakdown> = {};

  for (const cat of scaled) {
    let tokens = cat.estTokens;
    let cacheRead = 0;
    let cacheCreation = 0;
    let uncached = 0;

    // Consume cache_read
    if (remainingCacheRead > 0) {
      const take = Math.min(tokens, remainingCacheRead);
      cacheRead = take;
      remainingCacheRead -= take;
      tokens -= take;
    }

    // Consume cache_creation
    if (tokens > 0 && remainingCacheCreation > 0) {
      const take = Math.min(tokens, remainingCacheCreation);
      cacheCreation = take;
      remainingCacheCreation -= take;
      tokens -= take;
    }

    // Remainder is uncached
    uncached = tokens;

    result[cat.name] = {
      chars: cat.chars,
      est_tokens: cat.estTokens,
      cache_read: cacheRead,
      cache_creation: cacheCreation,
      uncached,
    };
  }

  return result;
}

// --- Cost computation ---

function computeCost(apiTokens: {
  input: number;
  cache_creation: number;
  cache_read: number;
  output: number;
}): { cost: CallData["cost_usd"]; longContext: boolean } {
  const totalInput =
    apiTokens.input + apiTokens.cache_creation + apiTokens.cache_read;
  const longContext = totalInput > 200_000;
  const p = longContext ? PRICING.long : PRICING.standard;

  const input = round(apiTokens.input * p.input);
  const cache_creation = round(apiTokens.cache_creation * p.cache_write);
  const cache_read = round(apiTokens.cache_read * p.cache_read);
  const output = round(apiTokens.output * p.output);
  const total = round(input + cache_creation + cache_read + output);

  return {
    cost: { input, cache_creation, cache_read, output, total },
    longContext,
  };
}

function round(n: number): number {
  return Math.round(n * 10000) / 10000;
}

// --- Prefix extraction and diffing ---

function extractPrefix(requestBody: any): ExtractedPrefix {
  // System: concatenate all system block texts
  let system = "";
  const sys = requestBody.system;
  if (typeof sys === "string") {
    system = sys;
  } else if (Array.isArray(sys)) {
    system = sys.map((b: any) => b.text || "").join("");
  }

  // Tools: full JSON (matches cache serialization)
  const tools = requestBody.tools ? JSON.stringify(requestBody.tools) : "";

  // Tool names: sorted for structural diff
  const toolNames = (requestBody.tools || [])
    .map((t: any) => t.name || "")
    .filter(Boolean)
    .sort();

  // SDK-injected blocks: from messages[0] user content
  const sdkBlocks: string[] = [];
  const messages = requestBody.messages || [];
  if (messages.length > 0 && messages[0].role === "user") {
    const content = messages[0].content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === "text") {
          const text: string = block.text || "";
          const isSdkInjected =
            text.includes("<system-reminder>") ||
            text.startsWith("USD budget:");
          if (isSdkInjected) {
            sdkBlocks.push(text);
          }
        }
      }
    }
  }

  return { system, tools, toolNames, sdkBlocks };
}

function diffStrings(
  prev: string,
  curr: string
): { divergeAt: number; divergeCount: number; contextStr: string } | null {
  if (prev === curr) return null;

  const minLen = Math.min(prev.length, curr.length);
  const maxLen = Math.max(prev.length, curr.length);

  // Find all divergence regions
  const regions: { start: number; prevEnd: number; currEnd: number }[] = [];
  let i = 0;
  while (i < minLen) {
    if (prev[i] !== curr[i]) {
      const start = i;
      // Scan forward to find end of this divergence
      while (i < minLen && prev[i] !== curr[i]) i++;
      regions.push({ start, prevEnd: i, currEnd: i });
    } else {
      i++;
    }
  }

  // If one string is longer, that's a trailing divergence
  if (prev.length !== curr.length) {
    if (regions.length > 0) {
      const last = regions[regions.length - 1];
      if (last.prevEnd >= minLen - 10 || last.currEnd >= minLen - 10) {
        // Merge with trailing length diff
        last.prevEnd = prev.length;
        last.currEnd = curr.length;
      } else {
        regions.push({
          start: minLen,
          prevEnd: prev.length,
          currEnd: curr.length,
        });
      }
    } else {
      regions.push({
        start: minLen,
        prevEnd: prev.length,
        currEnd: curr.length,
      });
    }
  }

  if (regions.length === 0) return null;

  // Merge nearby regions (within 10 chars)
  const merged: typeof regions = [regions[0]];
  for (let r = 1; r < regions.length; r++) {
    const last = merged[merged.length - 1];
    if (regions[r].start - Math.max(last.prevEnd, last.currEnd) <= 10) {
      last.prevEnd = regions[r].prevEnd;
      last.currEnd = regions[r].currEnd;
    } else {
      merged.push(regions[r]);
    }
  }

  // Build context string from first merged region
  const first = merged[0];
  const CTX = 30;
  const contextStart = Math.max(0, first.start - CTX);
  const contextEnd = Math.min(maxLen, Math.max(first.prevEnd, first.currEnd) + CTX);

  const prevChunk = prev.slice(first.start, first.prevEnd);
  const currChunk = curr.slice(first.start, first.currEnd);

  const prefix = prev.slice(contextStart, first.start);
  const suffix = prev.slice(first.prevEnd, Math.min(prev.length, first.prevEnd + CTX));

  // Truncate chunks if too long
  const maxChunk = 60;
  const prevDisplay =
    prevChunk.length > maxChunk
      ? prevChunk.slice(0, maxChunk) + `…(${prevChunk.length})`
      : prevChunk;
  const currDisplay =
    currChunk.length > maxChunk
      ? currChunk.slice(0, maxChunk) + `…(${currChunk.length})`
      : currChunk;

  let contextStr: string;
  if (prevChunk.length === 0) {
    contextStr = `...${prefix}+[${currDisplay}]${suffix}...`;
  } else if (currChunk.length === 0) {
    contextStr = `...${prefix}-[${prevDisplay}]${suffix}...`;
  } else {
    contextStr = `...${prefix}{${prevDisplay} → ${currDisplay}}${suffix}...`;
  }

  return {
    divergeAt: first.start,
    divergeCount: merged.length,
    contextStr,
  };
}

function diffPrefixes(
  prev: ExtractedPrefix,
  curr: ExtractedPrefix
): PrefixMutation[] {
  const mutations: PrefixMutation[] = [];

  // Compare system
  const sysDiff = diffStrings(prev.system, curr.system);
  if (sysDiff) {
    mutations.push({
      section: "system",
      prev_len: prev.system.length,
      curr_len: curr.system.length,
      divergence_count: sysDiff.divergeCount,
      first_diverge_at: sysDiff.divergeAt,
      context: sysDiff.contextStr,
    });
  }

  // Compare tools
  const toolsDiff = diffStrings(prev.tools, curr.tools);
  if (toolsDiff) {
    const prevSet = new Set(prev.toolNames);
    const currSet = new Set(curr.toolNames);
    const added = curr.toolNames.filter((t) => !prevSet.has(t));
    const removed = prev.toolNames.filter((t) => !currSet.has(t));

    const mutation: PrefixMutation = {
      section: "tools",
      prev_len: prev.tools.length,
      curr_len: curr.tools.length,
      divergence_count: toolsDiff.divergeCount,
      first_diverge_at: toolsDiff.divergeAt,
      context: toolsDiff.contextStr,
    };
    if (added.length > 0) mutation.tools_added = added;
    if (removed.length > 0) mutation.tools_removed = removed;
    mutations.push(mutation);
  }

  // Compare SDK blocks
  const maxSdk = Math.max(prev.sdkBlocks.length, curr.sdkBlocks.length);
  for (let i = 0; i < maxSdk; i++) {
    const prevBlock = prev.sdkBlocks[i] || "";
    const currBlock = curr.sdkBlocks[i] || "";
    const sdkDiff = diffStrings(prevBlock, currBlock);
    if (sdkDiff) {
      mutations.push({
        section: "sdk_injected",
        section_index: i,
        prev_len: prevBlock.length,
        curr_len: currBlock.length,
        divergence_count: sdkDiff.divergeCount,
        first_diverge_at: sdkDiff.divergeAt,
        context: sdkDiff.contextStr,
      });
    }
  }

  return mutations;
}

// --- Main ---

async function main() {
  const rawDir = process.argv[2];
  if (!rawDir) {
    console.error("Usage: bun extract.ts <raw-dir>");
    process.exit(1);
  }

  const files = (await readdir(rawDir))
    .filter((f) => f.endsWith(".jsonl"))
    .sort();

  if (files.length === 0) {
    console.error("No .jsonl files found in", rawDir);
    process.exit(1);
  }

  // Parse all entries
  const entries: LogEntry[] = [];
  let parseErrors = 0;

  for (const file of files) {
    const content = await readFile(join(rawDir, file), "utf-8");
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      try {
        entries.push(JSON.parse(line));
      } catch {
        parseErrors++;
      }
    }
  }

  // Group by session
  const sessionMap = new Map<string, LogEntry[]>();
  for (const entry of entries) {
    const sid = entry.session_id || "unknown";
    if (!sessionMap.has(sid)) sessionMap.set(sid, []);
    sessionMap.get(sid)!.push(entry);
  }

  // Sort each session's calls by call_num
  for (const calls of sessionMap.values()) {
    calls.sort((a, b) => a.call_num - b.call_num);
  }

  // Build output
  const sessions: SessionData[] = [];

  for (const [sessionId, calls] of sessionMap) {
    const sessionCalls: CallData[] = [];
    let sessionCost = 0;
    let prevPrefix: ExtractedPrefix | null = null;

    // Limit to first 20 calls per session
    const limitedCalls = calls.slice(0, 20);

    for (const entry of limitedCalls) {
      const apiTokens = {
        input: entry.input_tokens || 0,
        cache_creation: entry.cache_creation_input_tokens || 0,
        cache_read: entry.cache_read_input_tokens || 0,
        output: entry.output_tokens || 0,
      };

      const rawCategories = classifyContent(entry.request_body || {});
      const categories = applyCacheWaterfall(rawCategories, apiTokens);
      const blocks = buildBlocks(entry.request_body || {}, apiTokens);
      const { cost, longContext } = computeCost(apiTokens);

      sessionCost += cost.total;

      sessionCalls.push({
        call_num: entry.call_num,
        ts: entry.ts,
        api_tokens: apiTokens,
        long_context: longContext,
        cost_usd: cost,
        categories,
        blocks,
        is_subagent: false, // set below after all calls are built
        output_tokens: apiTokens.output,
        message_count: entry.message_count || 0,
        tool_count: entry.tool_count || 0,
        tool_names: entry.tool_names || [],
        duration_ms: entry.duration_ms || 0,
        prefix_mutations: null, // set below after subagent detection
      });
    }

    // Detect subagent calls: most common tool_count = main agent
    const toolCountFreq = new Map<number, number>();
    for (const c of sessionCalls) {
      toolCountFreq.set(c.tool_count, (toolCountFreq.get(c.tool_count) || 0) + 1);
    }
    let mainToolCount = 0;
    let maxFreq = 0;
    for (const [tc, freq] of toolCountFreq) {
      if (freq > maxFreq) {
        maxFreq = freq;
        mainToolCount = tc;
      }
    }
    for (const c of sessionCalls) {
      if (c.tool_count !== mainToolCount && c.tool_count > 0) {
        c.is_subagent = true;
      }
    }

    // Now do prefix diffing (skip subagent calls)
    prevPrefix = null;
    for (let i = 0; i < sessionCalls.length; i++) {
      const call = sessionCalls[i];
      if (call.is_subagent) {
        call.prefix_mutations = null;
        continue;
      }
      const currentPrefix = extractPrefix(limitedCalls[i].request_body || {});
      if (prevPrefix === null) {
        call.prefix_mutations = null;
      } else {
        call.prefix_mutations = diffPrefixes(prevPrefix, currentPrefix);
      }
      prevPrefix = currentPrefix;
    }

    sessions.push({
      session_id: sessionId,
      first_ts: calls[0]?.ts || "",
      call_count: calls.length,
      total_cost_usd: round(sessionCost),
      calls: sessionCalls,
    });
  }

  // Sort sessions by first timestamp descending
  sessions.sort((a, b) => (b.first_ts > a.first_ts ? 1 : -1));

  const output = {
    generated_at: new Date().toISOString(),
    data_quality: {
      note: "Per-category breakdowns are ESTIMATED from chars/4. Cache attribution is ESTIMATED by prefix waterfall. Only API token totals and costs are ACTUAL. Output tokens cannot be split into thinking vs text.",
      files_processed: files.length,
      total_calls: entries.length,
      total_sessions: sessions.length,
      parse_errors: parseErrors,
    },
    sessions,
  };

  console.log(JSON.stringify(output, null, 2));

  // Summary to stderr
  const totalCost = sessions.reduce((s, sess) => s + sess.total_cost_usd, 0);
  console.error(
    `Processed ${entries.length} calls across ${sessions.length} sessions from ${files.length} files. Total cost: $${round(totalCost)}`
  );
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
