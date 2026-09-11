import { formatHelpBotMarkdownLink } from '@/help-bot/help-bot-response-text';
import type { HelpBotKnowledgeRecord } from '@/help-bot/help-bot.knowledge';
import {
  MAX_DESKTOP_ANSWER_CHARACTERS,
  MAX_DESKTOP_BRIEF_CHARACTERS,
  wantsDetailedDesktopAnswer
} from '@/help-bot/help-bot-desktop-knowledge';

/** Links are corpus-owned and appended once, independently of model formatting. */
export function composeDesktopAnswer(
  text: string,
  record: HelpBotKnowledgeRecord
): string {
  const body = text
    .replace(/\n*More info:[^\n]*/gi, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/https?:\/\/[^\s)]+/g, '')
    .trim();
  if (!body) return '';
  const links = Array.from(
    new Map((record.answerLinks ?? []).map((link) => [link.url, link])).values()
  );
  const footer = links.map(formatHelpBotMarkdownLink).join(' | ');
  return footer ? `${body}\n\nMore info: ${footer}` : body;
}

/** Fallbacks are authored short answers; only an explicit depth request can enumerate facts. */
export function desktopFallbackAnswer(
  record: HelpBotKnowledgeRecord,
  question: string
): string {
  const detailed = wantsDetailedDesktopAnswer(question);
  const answer = composeDesktopAnswer(
    detailed
      ? record.facts.map((fact, index) => `${index + 1}. ${fact}`).join('\n\n')
      : (record.briefAnswer ??
          'Which part of 6529 Desktop (Core) do you need help with? Please describe what you see or the step you are trying to complete.'),
    record
  );
  const limit = detailed
    ? MAX_DESKTOP_ANSWER_CHARACTERS
    : MAX_DESKTOP_BRIEF_CHARACTERS;
  if (answer.length <= limit) return answer;
  return 'Which setup or troubleshooting step in 6529 Desktop should we focus on? I could not fit its complete instructions safely into this reply.';
}

export function normalizeDesktopAnswer(
  text: string,
  record: HelpBotKnowledgeRecord,
  question: string
): string {
  const answer = composeDesktopAnswer(text, record);
  const limit = wantsDetailedDesktopAnswer(question)
    ? MAX_DESKTOP_ANSWER_CHARACTERS
    : MAX_DESKTOP_BRIEF_CHARACTERS;
  return answer && answer.length <= limit
    ? answer
    : desktopFallbackAnswer(record, question);
}
