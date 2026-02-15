/**
 * Audio MCP Server - Whisper Speech-to-Text
 * Runs in the host process (OUTSIDE the sandbox) so it has network access for API calls
 *
 * Transcribes audio files using OpenAI Whisper API. Handles format conversion
 * via FFmpeg for non-native formats. Raw fetch — no npm dependency.
 */

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

interface AudioMcpOptions {
  openaiApiKey: string;
  workDir: string;
}

// Formats Whisper accepts natively (no conversion needed)
const WHISPER_NATIVE_FORMATS = new Set(['mp3', 'm4a', 'wav', 'webm']);

// All supported formats (native + those we can convert via FFmpeg)
const ALL_SUPPORTED_FORMATS = new Set(['mp3', 'm4a', 'wav', 'webm', 'ogg', 'flac', 'aiff']);

interface FormatDetection {
  format: string;
  needsConversion: boolean;
}

/**
 * Detect audio format from magic bytes (12-byte header).
 * Returns null if not a recognized audio format.
 */
function detectAudioFormat(header: Buffer): FormatDetection | null {
  // MP3: ID3 tag or sync word
  if (
    (header[0] === 0x49 && header[1] === 0x44 && header[2] === 0x33) || // ID3
    (header[0] === 0xFF && (header[1] & 0xE0) === 0xE0)                 // sync
  ) {
    return { format: 'mp3', needsConversion: false };
  }

  // WAV: RIFF....WAVE
  if (
    header.subarray(0, 4).toString() === 'RIFF' &&
    header.subarray(8, 12).toString() === 'WAVE'
  ) {
    return { format: 'wav', needsConversion: false };
  }

  // OGG: OggS
  if (header.subarray(0, 4).toString() === 'OggS') {
    return { format: 'ogg', needsConversion: true };
  }

  // FLAC: fLaC
  if (header.subarray(0, 4).toString() === 'fLaC') {
    return { format: 'flac', needsConversion: true };
  }

  // M4A/MP4: ftyp at offset 4
  if (header.subarray(4, 8).toString() === 'ftyp') {
    return { format: 'm4a', needsConversion: false };
  }

  // WebM: EBML magic (0x1A 0x45 0xDF 0xA3)
  if (header[0] === 0x1A && header[1] === 0x45 && header[2] === 0xDF && header[3] === 0xA3) {
    return { format: 'webm', needsConversion: false };
  }

  // AIFF: FORM....AIFF
  if (
    header.subarray(0, 4).toString() === 'FORM' &&
    header.subarray(8, 12).toString() === 'AIFF'
  ) {
    return { format: 'aiff', needsConversion: true };
  }

  return null;
}

export function createAudioMcp({ openaiApiKey, workDir }: AudioMcpOptions) {
  // Check FFmpeg availability once at construction
  let ffmpegAvailable = false;
  execFileAsync('ffmpeg', ['-version'])
    .then(() => {
      ffmpegAvailable = true;
      console.log('[audio] FFmpeg available for format conversion');
    })
    .catch(() => {
      console.log('[audio] FFmpeg not found — only Whisper-native formats (mp3, m4a, wav, webm) supported');
    });

  return createSdkMcpServer({
    name: 'audio',
    version: '1.0.0',
    tools: [
      tool(
        'transcribe',
        `Transcribe an audio file to text using OpenAI Whisper.

Supports: mp3, m4a, wav, webm (native), ogg, flac, aiff (converted via FFmpeg).
iPhone voice messages are .m4a — works directly. Android/desktop may send .ogg (needs FFmpeg).

The file must be in the workspace or /tmp/. Use mcp__slack__download_file first to fetch
audio from Slack, then pass the returned path here.

Returns transcript text with detected language and duration metadata.`,
        {
          file_path: z.string().describe('Path to the audio file (must be in workspace or /tmp/)'),
          language: z.string().optional().describe('ISO 639-1 language code hint (e.g., "en", "es", "ja"). Improves accuracy for non-English audio.'),
          prompt: z.string().max(500).optional().describe('Optional prompt to guide transcription — helps with domain-specific terms, names, or jargon.'),
        },
        async (args) => {
          if (!openaiApiKey) {
            return {
              content: [{ type: 'text' as const, text: 'OPENAI_API_KEY not set. Cannot transcribe audio.' }],
              isError: true,
            };
          }

          let tmpPath: string | null = null;

          try {
            // --- Path validation (matches media.ts pattern) ---
            const resolvedWorkDir = path.resolve(workDir);
            const resolved = path.resolve(args.file_path);
            if (!fs.existsSync(resolved)) {
              return {
                content: [{ type: 'text' as const, text: `File not found: ${args.file_path}` }],
                isError: true,
              };
            }
            const realPath = fs.realpathSync(resolved);
            if (!realPath.startsWith(resolvedWorkDir) && !realPath.startsWith('/tmp/')) {
              return {
                content: [{ type: 'text' as const, text: `File must be in workspace or /tmp/: ${args.file_path}` }],
                isError: true,
              };
            }

            // --- Size check ---
            const stat = fs.statSync(realPath);
            if (stat.size > 20 * 1024 * 1024) {
              return {
                content: [{ type: 'text' as const, text: `File too large (${Math.round(stat.size / 1024 / 1024)}MB). Whisper limit is 20MB.` }],
                isError: true,
              };
            }
            if (stat.size === 0) {
              return {
                content: [{ type: 'text' as const, text: `File is empty: ${args.file_path}` }],
                isError: true,
              };
            }

            // --- Magic byte detection ---
            const header = Buffer.alloc(12);
            const fd = fs.openSync(realPath, 'r');
            fs.readSync(fd, header, 0, 12, 0);
            fs.closeSync(fd);

            const detection = detectAudioFormat(header);
            if (!detection) {
              return {
                content: [{ type: 'text' as const, text: `Not a recognized audio format (checked magic bytes). Supported: ${[...ALL_SUPPORTED_FORMATS].join(', ')}` }],
                isError: true,
              };
            }

            console.log(`[audio] Detected format: ${detection.format} (${stat.size} bytes, conversion needed: ${detection.needsConversion})`);

            // --- Format conversion if needed ---
            let audioPath = realPath;
            if (detection.needsConversion) {
              if (!ffmpegAvailable) {
                return {
                  content: [{ type: 'text' as const, text: `Format "${detection.format}" requires FFmpeg for conversion, but FFmpeg is not installed. Install with: brew install ffmpeg` }],
                  isError: true,
                };
              }

              tmpPath = `/tmp/claude-audio-${Date.now()}.wav`;
              console.log(`[audio] Converting ${detection.format} → wav via FFmpeg`);

              await execFileAsync('ffmpeg', [
                '-i', realPath,
                '-ar', '16000',
                '-ac', '1',
                '-c:a', 'pcm_s16le',
                '-y',
                tmpPath,
              ], { timeout: 30_000 });

              audioPath = tmpPath;
            }

            // --- Whisper API call ---
            console.log(`[audio] Transcribing: ${audioPath}`);

            const audioBuffer = fs.readFileSync(audioPath);
            const ext = detection.needsConversion ? 'wav' : detection.format;
            const blob = new Blob([audioBuffer], { type: `audio/${ext}` });

            const formData = new FormData();
            formData.append('file', blob, `audio.${ext}`);
            formData.append('model', 'whisper-1');
            formData.append('response_format', 'verbose_json');
            if (args.language) formData.append('language', args.language);
            if (args.prompt) formData.append('prompt', args.prompt);

            const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
              method: 'POST',
              headers: {
                'Authorization': `Bearer ${openaiApiKey}`,
              },
              signal: AbortSignal.timeout(120_000),
              body: formData,
            });

            if (!response.ok) {
              const errText = await response.text();
              throw new Error(`Whisper API error (${response.status}): ${errText}`);
            }

            const result = await response.json() as {
              text: string;
              language?: string;
              duration?: number;
            };

            const lang = result.language || 'unknown';
            const duration = result.duration ? `${Math.round(result.duration)}s` : 'unknown';
            console.log(`[audio] Transcribed: ${lang}, ${duration}, ${result.text.length} chars`);

            return {
              content: [{
                type: 'text' as const,
                text: `Transcript (${lang}, ${duration}):\n\n${result.text}`,
              }],
            };
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            let hint = '';
            if (message.includes('timed out') || message.includes('TimeoutError') || message.includes('abort')) {
              hint = ' The file may be very long — Whisper has a 2-minute timeout for large files.';
            }
            console.error(`[audio] Failed:`, message);
            return {
              content: [{
                type: 'text' as const,
                text: `Transcription failed: ${message}${hint}`,
              }],
              isError: true,
            };
          } finally {
            // Clean up temp file
            if (tmpPath) {
              try { fs.unlinkSync(tmpPath); } catch { /* best-effort */ }
            }
          }
        },
      ),
    ],
  });
}
