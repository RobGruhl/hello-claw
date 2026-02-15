/**
 * Media MCP Server - Image generation and media handling
 * Runs in the host process (OUTSIDE the sandbox) so it has network access for API calls
 */

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import { checkRateLimit } from '../lib/rate-limit.js';

interface MediaMcpOptions {
  geminiApiKey: string;
  workDir: string;
}

const MODEL_MAP: Record<string, string> = {
  quality: 'gemini-3-pro-image-preview',
  fast: 'gemini-2.5-flash-image',
};

const QUALITY_MAP: Record<string, string> = {
  standard: '1K',
  hd: '2K',
  max: '4K',
};

const TIMEOUT_QUALITY_SCALE: Record<string, number> = {
  standard: 1,
  hd: 2,
  max: 3,
};

const MIME_TO_EXT: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
};

function computeTimeout(quality: string, count: number, hasImages: boolean): number {
  const base = 30_000;
  const qualityScale = TIMEOUT_QUALITY_SCALE[quality] || 2.5;
  const countScale = 1 + Math.log2(Math.max(count, 1));
  const editScale = hasImages ? 1.5 : 1;
  return Math.min(Math.round(base * qualityScale * countScale * editScale), 300_000);
}

function stripExtension(filename: string): string {
  const ext = path.extname(filename);
  return ext ? filename.slice(0, -ext.length) : filename;
}

export function createMediaMcp({ geminiApiKey, workDir }: MediaMcpOptions) {
  return createSdkMcpServer({
    name: 'media',
    version: '1.0.0',
    tools: [
      tool(
        'generate_image',
        `Generate or edit images using Gemini. Returns file path(s) in workspace/media/.
Generate: describe what you want. Edit: provide reference_images + instructions.
After generating, use mcp__slack__upload_file to share.
See media skill for prompt guidance, aspect ratios, quality tiers.`,
        {
          prompt: z.string().describe('Description of the image to generate, or editing instructions when reference_images are provided'),
          filename: z.string().optional().describe('Output filename base (extension auto-detected from output format)'),
          reference_images: z.array(z.string()).optional().describe(
            'File paths of reference images for editing/composition (from download_file). Max 10.'
          ),
          aspect_ratio: z.enum(['1:1', '3:2', '2:3', '4:3', '3:4', '4:5', '5:4', '16:9', '9:16', '21:9']).optional()
            .describe('Aspect ratio (default: 1:1)'),
          quality: z.enum(['standard', 'hd', 'max']).optional()
            .describe('Quality tier: standard=1K, hd=2K, max=4K (default: max)'),
          model: z.enum(['quality', 'fast']).optional()
            .describe('Model: quality=best output, fast=quicker (default: quality)'),
          count: z.number().int().min(1).max(4).optional()
            .describe('Number of image variations to generate, 1-4 (default: 1)'),
        },
        async (args) => {
          if (!geminiApiKey) {
            return {
              content: [{ type: 'text' as const, text: 'GEMINI_API_KEY not set. Cannot generate images.' }],
              isError: true,
            };
          }

          const limit = checkRateLimit('media', 100);
          if (!limit.allowed) {
            return { content: [{ type: 'text' as const, text: limit.message }], isError: true };
          }

          try {
            // Build parts array: reference images first, then text prompt
            const parts: Array<{ text: string } | { inlineData: { mimeType: string; data: string } }> = [];
            const resolvedWorkDir = path.resolve(workDir);

            if (args.reference_images && args.reference_images.length > 0) {
              if (args.reference_images.length > 10) {
                return {
                  content: [{ type: 'text' as const, text: 'Too many reference images (max 10).' }],
                  isError: true,
                };
              }

              const mimeMap: Record<string, string> = {
                '.png': 'image/png',
                '.jpg': 'image/jpeg',
                '.jpeg': 'image/jpeg',
                '.gif': 'image/gif',
                '.webp': 'image/webp',
              };

              for (const imgPath of args.reference_images) {
                const resolved = path.resolve(imgPath);
                if (!fs.existsSync(resolved)) {
                  return {
                    content: [{ type: 'text' as const, text: `Reference image not found: ${imgPath}` }],
                    isError: true,
                  };
                }
                // Resolve symlinks to prevent symlink-based exfiltration (C-3)
                const realPath = fs.realpathSync(resolved);
                if (!realPath.startsWith(resolvedWorkDir) && !realPath.startsWith('/tmp/')) {
                  return {
                    content: [{ type: 'text' as const, text: `Reference image must be in workspace or /tmp: ${imgPath}` }],
                    isError: true,
                  };
                }
                const stat = fs.statSync(realPath);
                if (stat.size > 10 * 1024 * 1024) {
                  return {
                    content: [{ type: 'text' as const, text: `Reference image too large (max 10MB): ${imgPath}` }],
                    isError: true,
                  };
                }
                const ext = path.extname(realPath).toLowerCase();
                const mimeType = mimeMap[ext];
                if (!mimeType) {
                  return {
                    content: [{ type: 'text' as const, text: `Unsupported image format (${ext}). Use png/jpg/gif/webp: ${imgPath}` }],
                    isError: true,
                  };
                }
                // Validate magic bytes to ensure file is actually an image
                const header = Buffer.alloc(12);
                const fd = fs.openSync(realPath, 'r');
                fs.readSync(fd, header, 0, 12, 0);
                fs.closeSync(fd);
                const isValidImage =
                  (header[0] === 0x89 && header[1] === 0x50 && header[2] === 0x4E && header[3] === 0x47) || // PNG
                  (header[0] === 0xFF && header[1] === 0xD8 && header[2] === 0xFF) || // JPEG
                  (header.subarray(0, 6).toString() === 'GIF87a' || header.subarray(0, 6).toString() === 'GIF89a') || // GIF
                  (header.subarray(0, 4).toString() === 'RIFF' && header.subarray(8, 12).toString() === 'WEBP'); // WebP
                if (!isValidImage) {
                  return {
                    content: [{ type: 'text' as const, text: `File is not a valid image (bad magic bytes): ${imgPath}` }],
                    isError: true,
                  };
                }
                const data = fs.readFileSync(realPath).toString('base64');
                parts.push({ inlineData: { mimeType, data } });
              }
            }

            // Text prompt last — editing instructions when images present, generation prompt otherwise
            const hasImages = parts.length > 0;
            parts.push({ text: hasImages ? args.prompt : `Generate an image: ${args.prompt}` });

            // Resolve parameters with defaults
            const quality = args.quality || 'max';
            const modelKey = args.model || 'quality';
            const count = args.count || 1;
            const modelId = MODEL_MAP[modelKey];
            const timeout = computeTimeout(quality, count, hasImages);

            // Build generationConfig with imageConfig for image-specific params
            const imageConfig: Record<string, string> = {
              imageSize: QUALITY_MAP[quality],
            };
            if (args.aspect_ratio) {
              imageConfig.aspectRatio = args.aspect_ratio;
            }

            const generationConfig = {
              responseModalities: ['IMAGE', 'TEXT'],
              imageConfig,
            };

            const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent`;
            const requestBody = JSON.stringify({
              contents: [{ parts }],
              generationConfig,
            });

            // For count > 1, make parallel API calls (generateContent doesn't support numberOfImages)
            const requests = Array.from({ length: count }, () =>
              fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-goog-api-key': geminiApiKey },
                signal: AbortSignal.timeout(timeout),
                body: requestBody,
              })
            );

            const responses = await Promise.all(requests);

            type GeminiResponse = {
              candidates?: Array<{
                content?: {
                  parts?: Array<{
                    inlineData?: { mimeType: string; data: string };
                    text?: string;
                  }>;
                };
              }>;
            };

            // Collect image parts from ALL responses and candidates
            const allImageParts: Array<{ mimeType: string; data: string }> = [];
            const errors: string[] = [];

            for (const response of responses) {
              if (!response.ok) {
                const errText = await response.text();
                errors.push(`Gemini API error (${response.status}, model: ${modelId}): ${errText}`);
                continue;
              }

              const data = await response.json() as GeminiResponse;
              for (const candidate of data.candidates || []) {
                for (const part of candidate.content?.parts || []) {
                  if (part.inlineData?.mimeType?.startsWith('image/')) {
                    allImageParts.push(part.inlineData);
                  }
                }
              }
            }

            if (allImageParts.length === 0) {
              const detail = errors.length > 0
                ? errors.join('\n')
                : 'No image in response. Try rephrasing your prompt or being more specific.';
              return {
                content: [{
                  type: 'text' as const,
                  text: `No image generated. ${detail}`,
                }],
                isError: true,
              };
            }

            // Save images to workspace
            const outputDir = path.join(workDir, 'media');
            fs.mkdirSync(outputDir, { recursive: true });
            const timestamp = Date.now();
            const savedPaths: string[] = [];

            for (let i = 0; i < allImageParts.length; i++) {
              const imgData = allImageParts[i];
              // Detect actual extension from MIME type
              const ext = MIME_TO_EXT[imgData.mimeType] || '.jpg';
              const baseName = args.filename
                ? stripExtension(path.basename(args.filename))
                : `generated-${timestamp}`;
              const suffix = allImageParts.length > 1 ? `-${i + 1}` : '';
              const filename = `${baseName}${suffix}${ext}`;
              const outputPath = path.resolve(outputDir, filename);

              const buffer = Buffer.from(imgData.data, 'base64');
              fs.writeFileSync(outputPath, buffer);
              savedPaths.push(outputPath);
            }

            const pathList = savedPaths.join('\n');
            const plural = savedPaths.length > 1 ? `${savedPaths.length} images` : 'Image';
            return {
              content: [{
                type: 'text' as const,
                text: `${plural} saved:\n${pathList}\n\nUse mcp__slack__upload_file to share.`,
              }],
            };
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            let hint = '';
            if (message.includes('timed out') || message.includes('TimeoutError') || message.includes('abort')) {
              hint = ' Try quality: "standard" or model: "fast" for faster generation.';
            }
            return {
              content: [{
                type: 'text' as const,
                text: `Image generation failed: ${message}${hint}`,
              }],
              isError: true,
            };
          }
        }
      ),
    ],
  });
}
