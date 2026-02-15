# Slack mrkdwn Formatting Reference

Slack uses its own markup language called "mrkdwn" — similar to Markdown but with important differences. Messages sent via `send_message` are automatically converted from common Markdown patterns, but it's better to write native mrkdwn.

## Supported Formatting

| Format | Syntax | Example |
|---|---|---|
| Bold | `*text*` | *bold text* |
| Italic | `_text_` | _italic text_ |
| Strikethrough | `~text~` | ~struck text~ |
| Inline code | `` `code` `` | `code` |
| Code block | ` ```code``` ` | Multi-line code |
| Blockquote | `> text` | Indented quote |
| Link | `<url\|display text>` | Clickable link |
| User mention | `<@U123ABC>` | @mention |
| Channel link | `<#C123ABC>` | #channel |
| Emoji | `:emoji_name:` | Emoji icon |
| Bullet list | `•` or `-` at line start | Unordered list |

## Not Supported in Slack

These common Markdown patterns do NOT work in Slack:

| Don't use | Use instead |
|---|---|
| `**bold**` | `*bold*` |
| `__italic__` | `_italic_` |
| `~~strike~~` | `~strike~` |
| `[text](url)` | `<url\|text>` |
| `![alt](img)` | `upload_file` |
| `# Heading` | `*Bold line*` on its own |
| `\| table \|` | Bold labels with bullet lists |
| `1. ordered` | Manual numbering: `1. item` |
| `---` rules | Blank line or bold separator |

## Formatting Tips

**Instead of headings:** Use a `*bold line*` on its own line.

**Instead of tables:** Use `*bold labels*` with short lines or bullet lists:
```
*Status:* Running
*Uptime:* 4 hours
*Errors:* None
```

**Instead of ordered lists:** Manually number with plain text:
```
1. First item
2. Second item
3. Third item
```

**Code blocks:** Triple backticks work, but don't add a language identifier — Slack ignores them.

**Line breaks:** Single newlines are preserved in Slack. No need for `<br>` or double-space tricks.

## Automatic Conversion

The `send_message` tool runs text through `markdownToMrkdwn()` which handles common conversions automatically:
- `**bold**` → `*bold*`
- `[text](url)` → `<url|text>`
- `~~strike~~` → `~strike~`
- Heading markers (`# `) → bold text

But it's cleaner to write native mrkdwn when you can — the converter handles the common cases but edge cases can slip through.
