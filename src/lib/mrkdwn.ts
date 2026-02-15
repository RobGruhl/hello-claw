/**
 * Convert GitHub-flavored Markdown to Slack mrkdwn.
 *
 * Preserves code blocks and inline code, then converts:
 *   **bold**  / __bold__  → *bold*
 *   ***bold italic***     → *_bold italic_*
 *   ~~strike~~            → ~strike~
 *   ### heading           → *heading*
 *   [text](url)           → <url|text>
 *   ![alt](url)           → <url|alt>
 *   --- / *** / ___       → ———
 *
 * Standalone *italic* is left as-is (Slack renders *x* as bold,
 * which is an acceptable trade-off since Claude rarely uses it).
 */
export function markdownToMrkdwn(text: string): string {
  const preserved: string[] = [];
  let result = text;

  // --- Protect code from conversion ---

  // Fenced code blocks (``` ... ```)
  result = result.replace(/```[\s\S]*?```/g, (m) => {
    preserved.push(m);
    return `\x00P${preserved.length - 1}\x00`;
  });

  // Inline code (` ... `)
  result = result.replace(/`[^`\n]+`/g, (m) => {
    preserved.push(m);
    return `\x00P${preserved.length - 1}\x00`;
  });

  // --- Conversions (order matters) ---

  // Headings → bold (must precede bold conversion)
  result = result.replace(/^#{1,6}\s+(.+)$/gm, '*$1*');

  // Bold+italic: ***text*** → *_text_*
  result = result.replace(/\*{3}(.+?)\*{3}/g, '*_$1_*');

  // Bold: **text** or __text__ → *text*
  result = result.replace(/\*{2}(.+?)\*{2}/g, '*$1*');
  result = result.replace(/__(.+?)__/g, '*$1*');

  // Strikethrough: ~~text~~ → ~text~
  result = result.replace(/~~(.+?)~~/g, '~$1~');

  // Images: ![alt](url) → <url|alt>  (before links)
  result = result.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<$2|$1>');

  // Links: [text](url) → <url|text>
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<$2|$1>');

  // Horizontal rules
  result = result.replace(/^[-*_]{3,}$/gm, '———');

  // --- Restore preserved blocks ---
  result = result.replace(/\x00P(\d+)\x00/g, (_, i) => preserved[parseInt(i)]);

  return result;
}
