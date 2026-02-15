---
name: voice
description: >
  Text-to-speech voice generation via ElevenLabs. Use when someone asks you to
  speak, say something aloud, send a voice message, or when a moment calls for
  expressive audio delivery over plain text.
allowed-tools: mcp__voice__*
---

# Voice — ElevenLabs Text-to-Speech

Generate expressive audio messages using ElevenLabs v3. MP3 files save to the workspace — upload to Slack for inline playback on mobile.

## Tools

All tools are prefixed `mcp__voice__`.

- **speak** — Convert text to speech with optional audio tags for expressive delivery. Saves MP3 to `workspace/media/`. Upload the result with `mcp__slack__upload_file`.

## When to Speak vs Type

This is the most important decision. Without guidance, you'll either never use voice or overuse it. Voice is a spice, not the main dish.

### Use Voice

| Situation | Why |
|---|---|
| User says "say this" / "speak" / "voice message" | Explicit request — always honor it |
| Personal emotional moment (encouragement, celebration) | Voice carries warmth that text cannot |
| Morning greeting or daily check-in | Sets a warm tone for the day |
| Creative expression (poetry, story, dramatic reading) | Performance benefits from voice |

### Use Text

| Situation | Why |
|---|---|
| Code, technical content, or debugging | Code must be readable, not audible |
| Long explanations or lists | Information density needs text |
| Links, URLs, file paths | Cannot click an audio link |
| Quick factual answers | Voice adds latency for no benefit |
| Multiple back-and-forth exchanges | Text for most, voice for emphasis only |

### Ask First

| Situation | Why |
|---|---|
| User sounds stressed or overwhelmed | A calm voice can be grounding — but audio may not suit the moment |
| You're unsure if audio is appropriate | Better to ask than to send unwanted audio |

## Audio Tags (v3)

The `eleven_v3` model supports inline tags that control emotional delivery. Tags go before the text they modify and can combine.

| Tag | Effect | When to use |
|---|---|---|
| `[whispers]` | Intimate, quiet | Personal moments, gentle encouragement |
| `[slow]` | Deliberate pace | Emphasis, gravity |
| `[fast]` | Quick, energetic | Excitement, urgency |
| `[pause]` | Brief silence | Between thoughts |
| `[long pause]` | Extended silence | Major transitions, letting something land |
| `[monotone]` | Flat delivery | Deadpan humor, reciting facts |
| `[calm]` | Relaxed, warm | Reassurance, soothing |
| `[confused]` | Uncertain | Genuine puzzlement |
| `[thoughtful]` | Reflective | Weighing ideas, philosophical |

**Combinations work:** `[calm] [slow] Take a breath. You're doing fine.`

**Tags can shift mid-text:** `[calm] Good morning. [pause] I've been thinking about what you said yesterday. [thoughtful] I think you were right.`

## Writing for the Ear

Speech text is different from message text. Write for listening, not reading.

- **Shorter sentences.** Break up complex thoughts. Pauses between ideas.
- **Natural rhythm.** Read it aloud in your head — does it flow?
- **1-3 sentences is the sweet spot.** Over 30 seconds and attention drifts.
- **Use tags for emotion**, not exclamation marks. `[whispers] I'm proud of you` lands harder than "I'm proud of you!!!"
- **No markdown, no formatting.** Plain speech text only. Audio tags are the only markup.

## Voice Selection

Default voice is configured via `ELEVENLABS_VOICE_ID`. You can override per-call with `voice_id` when the moment calls for a different register.

| Voice | Character | Best for |
|---|---|---|
| Lily (default) | British, warm raspy | Versatile — handles most moods |
| Rachel | American, calm | Soothing, reassuring |
| Nicole | American, whisper | Intimate moments |
| George | British, distinguished | Authoritative, thoughtful |
| Brian | American, deep | Gravitas, dramatic readings |
| Callum | American, intense | Energy and edge |
| Charlotte | English-Swedish, alluring | Mysterious, playful |

Usually just use the default. Override when a different emotional register would genuinely serve the moment.

## Delivery Pipeline

Same cross-MCP pattern as image generation:

1. `mcp__voice__speak` — generates MP3, returns file path
2. `mcp__slack__upload_file` — uploads with `initial_comment` for text context

**Always include `initial_comment`** — the user should be able to read or listen, their choice. The comment is your text version; the audio is the expressive version.

## Communication Values

- **One voice message per conversation is often right.** Don't make every reply audio.
- **Pair voice with text context.** Always set `initial_comment` on upload.
- **When generation fails, fall back to text.** Don't retry — just say what you were going to say.
- **Don't narrate your own messages.** Voice is for moments that benefit from expression, not for reading back what you already typed.
- **Non-English content:** Set `model_id` to `eleven_multilingual_v2` for non-English speech.
