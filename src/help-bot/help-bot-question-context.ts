export const HELP_BOT_REPLIED_DROP_CONTEXT_PREFIX =
  'Context from the replied-to drop:';

export interface HelpBotQuestionContext {
  readonly primaryQuestion: string;
  readonly repliedToDropContext: string | null;
}

function normalizeContextQuestion(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

export function parseHelpBotQuestionContext(
  question: string
): HelpBotQuestionContext {
  const contextStart = question.indexOf(HELP_BOT_REPLIED_DROP_CONTEXT_PREFIX);
  if (contextStart === -1) {
    return {
      primaryQuestion: question.trim(),
      repliedToDropContext: null
    };
  }

  return {
    primaryQuestion: question.slice(0, contextStart).trim(),
    repliedToDropContext: question
      .slice(contextStart + HELP_BOT_REPLIED_DROP_CONTEXT_PREFIX.length)
      .trim()
  };
}

export function isHelpBotContextVerificationQuestion(text: string): boolean {
  const normalized = normalizeContextQuestion(text);
  return [
    /^(is|was|are|were) (this|that|it|these|those) (right|correct|true|accurate)$/,
    /^(is|was|are|were) (this|that|it|these|those) (wrong|incorrect|false)$/,
    /^(does|did) (this|that|it) (look|sound|seem) (right|correct|true|accurate)$/,
    /^can you (check|confirm|verify) (this|that|it)$/,
    /^is this$/,
    /^is that$/
  ].some((pattern) => pattern.test(normalized));
}
