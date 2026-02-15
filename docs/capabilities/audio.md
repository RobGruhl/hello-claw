# Audio — Whisper Speech-to-Text

**Status:** Implemented (`5d856ea`)

Implements the audio capability stack per [Design Standards](design-standards.md). Whisper-powered transcription of voice messages and audio files, with FFmpeg format conversion for non-native formats. Complements [Voice](voice.md) — together they give the agent ears and a mouth.

## Capability Stack

| Layer | Location | Notes |
|---|---|---|
| Skill | `plugins/skills/audio/SKILL.md` (~80 lines) | Auto-transcribe decision tree, cross-MCP workflow, response guidance. |
| MCP server | `src/mcp/audio.ts` (1 tool, server name `audio`) | transcribe. Path-restricted, magic byte validated, FFmpeg conversion. |
| External | OpenAI Whisper API + FFmpeg | `whisper-1` model, `verbose_json` response format. FFmpeg for ogg/flac/aiff conversion. |

**Availability:** host.ts and heartbeat.ts (`mcp__audio__*`). Not available in cron.

## Tools

| Tool | Purpose | Key Parameters |
|---|---|---|
| `transcribe` | Transcribe audio file to text | `file_path` (required), `language?` (ISO 639-1 hint), `prompt?` (domain terms) |

**Returns:** `Transcript (en, 12s):\n\n{text}` — language and duration metadata from Whisper's `verbose_json` response.

### Supported Formats

| Format | Whisper Native | FFmpeg Needed |
|---|---|---|
| MP3, M4A, WAV, WebM | Yes | No |
| OGG, FLAC, AIFF | No | Yes |

iPhone voice messages are `.m4a` — the primary use case works without FFmpeg.

## Design Decisions

### Single tool, intentionally simple

One tool that accepts a file path and returns text. No translation, segmentation, or diarization. The agent already has the intelligence to work with the transcript.

### Magic byte detection over extension matching

Files from Slack may have misleading extensions. The 12-byte header check is authoritative and prevents exfiltration of non-audio files through the Whisper API.

### FFmpeg graceful degradation

Checked once at MCP construction. If missing, Whisper-native formats still work. Non-native formats return a clear error with install instructions.

### Auto-transcribe behavior in skill

The skill's core value is teaching the agent to auto-transcribe voice messages without being asked. Voice messages are conversational input — they should be treated like text messages.

## Pipeline

```
User sends voice message → [ATTACHED FILES] metadata in prompt
  → mcp__slack__download_file → workspace/media/{filename}
  → mcp__audio__transcribe → "Transcript (en, 12s):\n\n{text}"
  → Agent responds to the content naturally
```

## Security Properties

- **Path validation.** Symlink-resolved, workspace-or-`/tmp/`-restricted.
- **Magic byte validation.** Only processes files with recognized audio signatures (7 formats).
- **Size limit.** 20MB cap. **Temp file cleanup.** FFmpeg output deleted in `finally` block.
- **No new sandbox exposure.** `api.openai.com` NOT in `allowedDomains`.
- Reuses `OPENAI_API_KEY` from oracle MCP. No new secrets, no new npm dependencies.

## Checklist

- [x] SKILL.md in `plugins/skills/audio/` (~80 lines)
- [x] Decision tree: 10 entries (auto-transcribe / ask-first / don't-transcribe)
- [x] Tool description: brief, defers to skill
- [x] `allowedTools` in host.ts and heartbeat.ts
- [x] No new npm dependencies or allowedDomains
