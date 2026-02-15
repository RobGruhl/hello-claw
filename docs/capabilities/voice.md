# Voice — ElevenLabs Text-to-Speech

**Status:** Implemented (`ffc7cbc`)

Implements the voice capability stack per [Design Standards](design-standards.md). ElevenLabs v3 TTS with inline audio tags for expressive delivery. Generated MP3 audio plays inline in Slack on iPhone. Complements [Audio](audio.md) — together they give the agent ears and a mouth.

## Capability Stack

| Layer | Location | Notes |
|---|---|---|
| Skill | `plugins/skills/voice/SKILL.md` (~120 lines) | When-to-speak decision tree, audio tag reference, speech writing guidance. |
| MCP server | `src/mcp/voice.ts` (1 tool, server name `voice`) | speak. Raw fetch, MP3 output to workspace/media/. |
| External | ElevenLabs v3 TTS API | `eleven_v3` model. Audio tags for expression, no voice_settings. |

**Availability:** host.ts (`mcp__voice__*`). Not available in heartbeat or cron (voice is conversational).

## Tools

### `mcp__voice__speak`

| Parameter | Type | Default | Notes |
|---|---|---|---|
| `text` | string (required) | — | Speech text with optional v3 audio tags. Max 5000 chars. |
| `voice_id` | string | `ELEVENLABS_VOICE_ID` env | Override default voice |
| `filename` | string | `voice-{timestamp}.mp3` | Output base name |
| `model_id` | string | `eleven_v3` | ElevenLabs model |

**Returns:** `Audio saved: {path}\n\nDuration: ~{estimate}s | {charCount} chars\n\nUse mcp__slack__upload_file to share.`

## v3 Audio Tags

| Tag | Effect | Best for |
|---|---|---|
| `[whispers]` | Intimate, quiet delivery | Personal moments, gentle encouragement |
| `[slow]` | Deliberate, measured pace | Emphasis, gravity, savoring a moment |
| `[fast]` | Quick, energetic delivery | Excitement, urgency |
| `[pause]` | Brief silence | Between thoughts, dramatic effect |
| `[long pause]` | Extended silence | Major transitions |
| `[monotone]` | Flat, even delivery | Deadpan humor, reciting facts |
| `[calm]` | Relaxed, warm tone | Reassurance, soothing |
| `[confused]` | Uncertain, searching | Genuine puzzlement |
| `[thoughtful]` | Reflective, considered | Weighing ideas, philosophical |

Tags prepend to text: `[whispers] [slow] Hello there.` Combinations work. Tags can shift mid-text.

## Voice Palette

Default voice set via `ELEVENLABS_VOICE_ID`. Override per-call with `voice_id`.

| Voice | Character | Best for |
|---|---|---|
| Lily (default) | British, warm raspy, sophisticated | Expressive narration, versatile |
| Rachel | American, calm, young | Soothing, reassuring |
| Nicole | American, whisper, young | Intimate moments |
| George | British, raspy, distinguished | Authoritative, thoughtful |
| Brian | American, deep, grounded | Gravitas, dramatic readings |

## Design Decisions

### Tool description is brief; skill carries the detail

The tool description is 3 lines (purpose, audio tag support, upload reminder). The full audio tag reference, voice palette, and writing guidance live in the skill. This follows the [context thinning principle](design-standards.md) — tool descriptions are fixed overhead on every API call, while skills load on demand.

### v3 model uses audio tags, not voice_settings

Critical insight: for `eleven_v3`, expressiveness comes entirely from inline audio tags in the text. No `voice_settings` parameter. Validated in hello-elevenlabs reference project.

### Pipeline

```
Agent decides to speak → crafts speech text with audio tags
  → mcp__voice__speak → ElevenLabs v3 API → MP3 saved to workspace/media/
  → mcp__slack__upload_file → playable audio in Slack (inline on iPhone)
```

Cross-MCP pattern identical to image generation (generate → upload), documented in [Media](media.md).

### Communication values

- Voice is a spice, not the main dish. One voice message per conversation is often right.
- Always pair voice with text context (initial_comment on upload).
- Write speech text for listening, not reading — shorter, more natural.
- 1-3 sentences is the sweet spot. Over 30 seconds and attention drifts.

## Security Properties

- **No file input.** Text-only — no path traversal or exfiltration.
- **Text length limit.** 5000 chars max via zod.
- **API key management.** `ELEVENLABS_API_KEY` through SECRETS capture/strip.
- **No new sandbox exposure.** `api.elevenlabs.io` NOT in `allowedDomains`.
- No npm dependencies.

## Checklist

- [x] SKILL.md in `plugins/skills/voice/` (~120 lines)
- [x] Decision tree: 12 entries
- [x] Tool description: brief (3 lines), defers to skill
- [x] `allowedTools` in host.ts (`mcp__voice__*`)
- [x] No new npm dependencies or allowedDomains
