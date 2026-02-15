---
name: media
description: >
  Image generation and editing via Gemini. Relevant when someone asks to
  create, generate, edit, or modify images, illustrations, art, wallpapers,
  or visual content.
allowed-tools: mcp__media__*
---

# Media — Image Generation & Editing

Gemini-powered image generation and editing through a single tool (`generate_image`) with rich parameters. Generated images save to the channel's `workspace/media/` directory. Always upload results to Slack immediately after generating.

## Prompt Writing

This is where most of the quality comes from. A good prompt is specific about four dimensions:

**Style** — Name it explicitly. Examples: watercolor, photorealistic, vector illustration, pixel art, oil painting, pencil sketch, 3D render, flat design, comic book, art nouveau, vaporwave, Studio Ghibli-inspired, isometric.

**Composition** — Where things are and how the frame is arranged. Examples: centered portrait, wide establishing shot, close-up detail, bird's eye view, symmetrical layout, rule of thirds, negative space emphasis, full body shot.

**Lighting** — Sets the entire mood. Examples: natural daylight, golden hour, dramatic side-lighting, soft diffused, neon glow, backlit silhouette, candlelight, overcast flat, harsh noon sun, studio three-point.

**Mood** — The emotional register. Examples: serene, vibrant, mysterious, playful, melancholic, cozy, epic, whimsical, unsettling, nostalgic.

A weak prompt: "a cat"
A strong prompt: "a tabby cat curled up on a windowsill, watercolor style, soft morning light streaming through sheer curtains, warm and cozy mood, close-up composition with bokeh background"

**For editing prompts:** Describe what to CHANGE, not what's already there. "Make the sky a sunset orange" not "there's a blue sky, change it to orange." Be specific about the transformation.

## Quality & Speed

Don't duplicate the tool description's tables — just know when to pick what:

| Goal | Model | Quality | Why |
|------|-------|---------|-----|
| Quick draft / iteration | `fast` | `standard` | See the idea fast, refine later |
| Share-worthy final | `quality` | `max` | Best possible output |
| Batch variations (3-4) | `fast` | `standard` | Cheaper and faster at scale |
| Editing with references | `quality` | `max` | Edits need precision |
| User said "quick" or "rough" | `fast` | `standard` | Respect the speed request |

**Rule of thumb:** Iterate with `fast`/`standard`, finalize with `quality`/`max`. When in doubt, use the defaults (`quality`/`max`) — better to be slow and good than fast and mediocre.

## Image Editing Pipeline

Editing requires a cross-MCP workflow. The agent can't edit images directly — it downloads, generates with references, and uploads:

1. **Download** the user's image: `mcp__slack__download_file` (uses file ID from `[ATTACHED FILES]` metadata)
2. **Generate** with editing instructions: `mcp__media__generate_image` with the downloaded path in `reference_images`
3. **Upload** the result: `mcp__slack__upload_file` to share back

**Restrictions:**
- Reference images must be in workspace or `/tmp/` (security boundary)
- Max 10MB per reference image
- Supported formats: PNG, JPEG, GIF, WebP
- Max 10 reference images per call
- Magic bytes are validated — renaming a non-image file won't work

## Decision Tree

| Situation | Action | Notes |
|---|---|---|
| "Make me an image of..." | `generate_image` with defaults | `quality` model, `max` quality — best output |
| "Quick sketch of..." / "rough draft" | `generate_image` with `fast` / `standard` | Speed over quality |
| "Edit this image to..." | Download first, then `generate_image` with `reference_images` | Must download before editing |
| "Make a few variations" | `generate_image` with `count: 3-4`, `fast` model | Batch is cheaper with fast |
| "I need a wallpaper" | Ask what device, then set aspect ratio | `9:16` phone, `16:9` desktop |
| "Make it wider / taller" | Re-generate with different `aspect_ratio` | Can't crop existing — must regenerate |
| Timeout or slow generation | Suggest `fast` model or `standard` quality | Reduce parameters to reduce time |
| "Make it more [adjective]" | Re-generate with stronger prompt language | Emphasize the desired quality in the prompt |
| User attaches image with no instructions | Ask what they want done with it | Don't assume — could be edit, variation, or unrelated |

## Communication Values

- **Always upload immediately** — never just say "I generated an image." The user wants to see it.
- **Descriptive initial_comment** on uploads — what it is, what settings were used, what to try next.
- **When generation fails or times out**, explain what happened and offer alternatives (lower quality, simpler prompt, different model).
- **For edits, confirm intended changes** before generating — misunderstandings waste a slow API call.
- **Show the prompt you used** when sharing results, so the user can iterate on it.
- **When generating variations**, upload all of them and let the user pick favorites.
