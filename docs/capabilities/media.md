# Media — Image Generation & Editing

**Status:** Implemented (`31b0b13`, `d0e8a6a`)

Implements the media capability stack per [Design Standards](design-standards.md).

## Capability Stack

| Layer | Location | Notes |
|---|---|---|
| Skill | `plugins/skills/media/SKILL.md` (81 lines) | Prompt crafting, quality/speed matrix, editing pipeline, decision tree. |
| Lib code | N/A | No shared helpers needed. |
| MCP server | `src/mcp/media.ts` (314 lines, 1 tool) | Single `generate_image` tool with rich parameters. Dynamic timeout calculation. |
| External | Gemini API (`generateContent`) | `gemini-3-pro-image-preview` (quality) and `gemini-2.5-flash-image` (fast). |

**Availability:** host.ts and heartbeat.ts (`mcp__media__*`). Not available in cron.

## Tools

Single tool with rich parameters:

### `mcp__media__generate_image`

| Parameter | Type | Default | Notes |
|---|---|---|---|
| `prompt` | string (required) | — | Description or editing instructions |
| `filename` | string | auto-generated | Base name, extension auto-detected from output MIME |
| `reference_images` | string[] | — | Workspace/tmp paths for editing. Max 10. |
| `aspect_ratio` | enum | `"1:1"` | 10 ratios: `1:1`, `3:2`, `2:3`, `4:3`, `3:4`, `4:5`, `5:4`, `16:9`, `9:16`, `21:9` |
| `quality` | enum | `"max"` | `standard` (1K), `hd` (2K), `max` (4K) |
| `model` | enum | `"quality"` | `quality` (gemini-3-pro) or `fast` (gemini-2.5-flash) |
| `count` | number | 1 | 1-4 variations via parallel API calls |

## Design Decisions

### Skill carries the guidance, tool description is brief

The tool description is kept to 4 lines (purpose, modes, upload reminder, skill pointer). Reference tables for aspect ratios, quality tiers, and model options live in the skill where they're loaded on demand — not in the tool definition where they'd be fixed overhead on every API call.

The skill's unique value is in three areas the tool description can't carry:
1. **Prompt writing guidance** — the four dimensions (style, composition, lighting, mood) with examples of weak vs strong prompts.
2. **Quality/speed decision matrix** — when to use `fast`/`standard` vs `quality`/`max`.
3. **Cross-MCP editing pipeline** — `download_file` (slack) → `generate_image` with `reference_images` → `upload_file` (slack).

### Dynamic timeout calculation

Timeouts scale with quality, count, and whether reference images are present:
- Base: 30s. Quality scale: `standard` 1x, `hd` 2x, `max` 3x.
- Count scale: `1 + log2(count)` (sublinear — parallel requests).
- Edit scale: 1.5x when reference images present. Cap: 300s.

### Parallel generation for count > 1

Gemini's `generateContent` doesn't support `numberOfImages`, so `count > 1` fires parallel API calls. Each response's candidates are collected, and all image parts saved with `-1`, `-2` suffixes.

## Security Properties

- Reference images: symlink-resolved, workspace-or-`/tmp/`-restricted, 10MB per-image limit
- Magic byte validation (PNG, JPEG, GIF, WebP headers)
- Output saved to `{workDir}/media/` only
- Gemini API key passed via constructor

## Checklist

- [x] SKILL.md in `plugins/skills/media/` (81 lines)
- [x] Decision tree: 8 entries
- [x] Tool description: brief (4 lines), defers to skill
- [x] `allowedTools` in host.ts and heartbeat.ts
