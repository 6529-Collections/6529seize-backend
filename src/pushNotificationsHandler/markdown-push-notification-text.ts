import MarkdownIt from 'markdown-it';
import { isSupportedMediaUrl } from '@/pushNotificationsHandler/push-notification-text';

// Parse Markdown without rendering HTML or enabling typographic substitutions.
const markdown = new MarkdownIt({ html: false, linkify: false });

function inlineText(tokens: MarkdownIt.Token[]): string {
  const parts: string[] = [];
  let hideMediaLink = false;
  for (const token of tokens) {
    if (token.type === 'link_open') {
      hideMediaLink = isSupportedMediaUrl(String(token.attrGet('href') ?? ''));
      if (hideMediaLink) parts.push(' ');
    } else if (token.type === 'link_close') {
      hideMediaLink = false;
    } else if (!hideMediaLink) {
      parts.push(inlineTokenText(token));
    }
  }
  return parts.join('');
}

function inlineTokenText(token: MarkdownIt.Token): string {
  switch (token.type) {
    case 'text':
    case 'code_inline':
      return token.content;
    case 'softbreak':
    case 'hardbreak':
      return '\n';
    case 'image':
      return ' ';
    default:
      return '';
  }
}

function blockText(tokens: MarkdownIt.Token[]): string {
  const parts: string[] = [];
  const lists: Array<{ next: number | null }> = [];
  let tableCell = 0;
  for (const token of tokens) {
    switch (token.type) {
      case 'bullet_list_open':
        lists.push({ next: null });
        break;
      case 'ordered_list_open':
        lists.push({ next: Number(token.attrGet('start') ?? 1) });
        break;
      case 'bullet_list_close':
      case 'ordered_list_close':
        lists.pop();
        break;
      case 'list_item_open': {
        const list = lists[lists.length - 1];
        parts.push(list?.next == null ? '• ' : `${list.next++}. `);
        break;
      }
      case 'inline':
        parts.push(inlineText(token.children ?? []));
        break;
      case 'code_block':
      case 'fence':
        parts.push(token.content, '\n');
        break;
      case 'tr_open':
        tableCell = 0;
        break;
      case 'td_open':
      case 'th_open':
        if (tableCell++ > 0) parts.push(' | ');
        break;
      case 'td_close':
      case 'th_close':
        break;
      default:
        if (token.block && token.nesting !== 1) parts.push('\n');
    }
  }
  return parts.join('');
}

/** Plain-text preview only; the stored drop and its in-app Markdown are unchanged. */
export function formatDropMarkdownForPush(input: string): string {
  return blockText(markdown.parse(input, {}))
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .filter((line) => line.length > 0)
    .join('\n');
}
