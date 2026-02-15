/**
 * Voice MCP Server - ElevenLabs Text-to-Speech
 * Runs in the host process (OUTSIDE the sandbox) so it has network access for API calls
 *
 * Uses ElevenLabs v3 model with inline audio tags for expressive delivery.
 * Raw fetch — no npm dependency (matches oracle.ts pattern).
 */

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import { checkRateLimit } from '../lib/rate-limit.js';

interface VoiceMcpOptions {
  elevenlabsApiKey: string;
  workDir: string;
  defaultVoiceId: string;
}

const ELEVENLABS_BASE = 'https://api.elevenlabs.io/v1';

function computeTimeout(textLength: number): number {
  // Base 30s + 15ms per char, capped at 3 minutes
  return Math.min(30_000 + textLength * 15, 180_000);
}

function estimateDuration(textLength: number): number {
  // ~150 words per minute, ~5 chars per word → ~750 chars per minute
  return Math.round(textLength / 750 * 60);
}

export function createVoiceMcp({ elevenlabsApiKey, workDir, defaultVoiceId }: VoiceMcpOptions) {
  return createSdkMcpServer({
    name: 'voice',
    version: '1.0.0',
    tools: [
      tool(
        'speak',
        `Generate speech audio from text using ElevenLabs. Saves MP3 to workspace.
Supports v3 audio tags for expression. After generating, use upload_file to share.
See voice skill for audio tag reference and writing guidance.`,
        {
          text: z.string().max(5000).describe('Speech text with optional v3 audio tags. Max 5000 chars.'),
          voice_id: z.string().optional().describe('Override default voice ID'),
          filename: z.string().optional().describe('Output filename base (default: voice-{timestamp}.mp3)'),
          model_id: z.string().optional().describe('ElevenLabs model (default: eleven_v3)'),
        },
        async (args) => {
          if (!elevenlabsApiKey) {
            return {
              content: [{ type: 'text' as const, text: 'ELEVENLABS_API_KEY not set. Cannot generate speech.' }],
              isError: true,
            };
          }

          const limit = checkRateLimit('voice', 100);
          if (!limit.allowed) {
            return { content: [{ type: 'text' as const, text: limit.message }], isError: true };
          }

          const voiceId = args.voice_id || defaultVoiceId;
          if (!voiceId) {
            return {
              content: [{ type: 'text' as const, text: 'No voice ID configured. Set ELEVENLABS_VOICE_ID in .env or pass voice_id.' }],
              isError: true,
            };
          }

          const modelId = args.model_id || 'eleven_v3';

          try {
            console.log(`[voice] Generating speech (${args.text.length} chars, voice=${voiceId}, model=${modelId})`);

            const timeout = computeTimeout(args.text.length);
            const response = await fetch(`${ELEVENLABS_BASE}/text-to-speech/${voiceId}`, {
              method: 'POST',
              headers: {
                'xi-api-key': elevenlabsApiKey,
                'Content-Type': 'application/json',
                'Accept': 'audio/mpeg',
              },
              signal: AbortSignal.timeout(timeout),
              body: JSON.stringify({
                text: args.text,
                model_id: modelId,
              }),
            });

            if (!response.ok) {
              const errText = await response.text();
              throw new Error(`ElevenLabs API error (${response.status}): ${errText}`);
            }

            // Save MP3 to workspace
            const outputDir = path.join(workDir, 'media');
            fs.mkdirSync(outputDir, { recursive: true });

            const timestamp = Date.now();
            const baseName = args.filename
              ? path.basename(args.filename).replace(/\.mp3$/i, '')
              : `voice-${timestamp}`;
            const filename = `${baseName}.mp3`;
            const outputPath = path.resolve(outputDir, filename);

            const buffer = Buffer.from(await response.arrayBuffer());
            fs.writeFileSync(outputPath, buffer);

            const durationEstimate = estimateDuration(args.text.length);
            console.log(`[voice] Saved: ${outputPath} (${buffer.length} bytes, ~${durationEstimate}s)`);

            return {
              content: [{
                type: 'text' as const,
                text: `Audio saved: ${outputPath}\n\nDuration: ~${durationEstimate}s | ${args.text.length} chars\n\nUse mcp__slack__upload_file to share.`,
              }],
            };
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            let hint = '';
            if (message.includes('timed out') || message.includes('TimeoutError') || message.includes('abort')) {
              hint = ' Try shorter text — long passages take longer to synthesize.';
            }
            console.error(`[voice] Failed:`, message);
            return {
              content: [{
                type: 'text' as const,
                text: `Speech generation failed: ${message}${hint}`,
              }],
              isError: true,
            };
          }
        },
      ),
    ],
  });
}
