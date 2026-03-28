/**
 * Markdown-to-plaintext stripping for outbound WeChat messages.
 *
 * WeChat renders messages as plain text, so markdown formatting characters
 * (bold, italic, code blocks, headers) add noise rather than visual emphasis.
 */

/**
 * Strip common markdown formatting from text.
 *
 * @param {string} text
 * @returns {string} Plain text with markdown syntax removed
 */
export function stripMarkdown(text) {
  if (!text) return text;

  let result = text;

  // Strip fenced code blocks: ```lang\ncode\n``` → code
  result = result.replace(/```[\w]*\n?([\s\S]*?)```/g, '$1');

  // Strip inline code: `code` → code
  result = result.replace(/`([^`]+)`/g, '$1');

  // Strip bold: **text** → text
  result = result.replace(/\*\*(.+?)\*\*/g, '$1');

  // Strip italic: *text* → text (but not ** which is bold)
  result = result.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '$1');

  // Strip links: [text](url) → text (url)
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)');

  // Strip headers: ## Header → Header
  result = result.replace(/^#{1,6}\s+/gm, '');

  // Strip bullet markers: - item → item (preserve indentation)
  result = result.replace(/^(\s*)[-*+]\s+/gm, '$1');

  return result;
}
