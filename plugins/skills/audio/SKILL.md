---
name: audio
description: >
  Audio transcription via Whisper. Relevant when someone sends a voice message,
  audio file, recording, or asks to transcribe, listen to, or understand audio content.
allowed-tools: mcp__audio__*
---

# Audio — Whisper Speech-to-Text

Transcribe audio files using OpenAI Whisper. Handles iPhone voice messages (.m4a), desktop recordings, and other audio formats. Files outside Whisper's native format list are auto-converted via FFmpeg.

## Tools

All tools are prefixed `mcp__audio__`.

- **transcribe** — Convert audio file to text. Accepts `file_path` (required), `language` (ISO 639-1 hint), and `prompt` (domain-specific term guidance). Returns transcript with detected language and duration.

Cross-MCP workflow: Use `mcp__slack__download_file` first to fetch audio from Slack, then pass the returned path to `transcribe`.

## When to Transcribe

This is the key decision. Voice messages are just text messages sent by voice — treat them accordingly.

### Auto-Transcribe (No Need to Ask)

| Situation | Action |
|---|---|
| Voice message (Slack voice clip) | Transcribe, respond to the content naturally |
| Short audio file (<2 min) attached to a message | Transcribe, respond to content |
| "Transcribe this" / "What does this say?" | Transcribe immediately |
| "What did they say?" | Transcribe, answer the question |
| "Summarize this recording" | Transcribe, then summarize |

### Ask First

| Situation | Why |
|---|---|
| Long audio (podcast, meeting recording, >5 min) | May be expensive / slow — confirm intent |
| Video file with audio track | Not supported — explain limitation |
| Multiple audio files at once | Confirm they want all transcribed |

### Don't Transcribe

| Situation | Why |
|---|---|
| Music files | Whisper transcribes speech, not music |
| Sound effects / ambient audio | No meaningful speech to transcribe |
| Video files | Audio-only — suggest extracting audio first |

## Workflow

The standard pipeline for Slack voice messages:

1. **`mcp__slack__download_file`** — fetch the audio file by file ID (from `[ATTACHED FILES]` metadata)
2. **`mcp__audio__transcribe`** — transcribe the downloaded file
3. **Respond naturally** — reply to the *content* of what was said, don't just dump the transcript

## Language and Accuracy

- **Non-English audio:** Set `language` parameter if you know the language (e.g., `"es"` for Spanish). Improves accuracy significantly.
- **Domain-specific terms:** Use `prompt` parameter to prime Whisper with expected vocabulary. Example: `"Discussion about Kubernetes, kubectl, and Helm charts"`.
- **Garbled output:** If the transcript seems wrong, note quality issues honestly. Don't pretend the transcript is clear when it isn't.

## Communication Values

- **Respond to the content, not the medium.** A voice message saying "can you check the deploy?" gets the same response as a text message saying it. Don't say "I transcribed your voice message and it says..."
- **Summarize long transcripts.** If the audio is >30 seconds, lead with a brief summary before the full text (if needed at all).
- **Voice messages = text messages.** The user chose voice for convenience, not because they want a different interaction pattern.
- **Acknowledge processing time.** For files >1 minute, a brief "let me listen to that" is fine.
- **Pair with voice replies when appropriate.** If someone sends a voice message and the reply would benefit from warmth, consider using `mcp__voice__speak` for the response.
