import type { HelpBotKnowledgeRecord } from './help-bot.knowledge';

export const MAX_DESKTOP_ANSWER_CHARACTERS = 6000;
export const MAX_DESKTOP_ANSWER_TOKENS = 1600;

export function isDesktopKnowledgeRecord(
  record: HelpBotKnowledgeRecord
): boolean {
  return (
    record.id.startsWith('desktop.') && record.tags.includes('desktop-core')
  );
}

// Identify the local application, not ordinary desktop-browser layout questions.
// Routes, menu labels, schedules, and recovery instructions remain corpus-owned.
export function isDesktopSupportQuestion(question: string): boolean {
  if (
    /\b(?:mobile|android|ios|website|browser)\b/i.test(question) &&
    !/\b(?:core|6529 desktop|desktop app|desktop node)\b/i.test(question)
  ) {
    return false;
  }
  return [
    /\b(?:what is core|6529 core|6529\s+desktop)\b/i,
    /\bdesktop\s+(?:app|application|node|wallets?)\b/i,
    /\bcore\s+(?:app|wallets?|workers?|rpc|tdh|ipfs|recovery)\b/i,
    /\b(?:in|with|using|about|start|setup|explain|describe)\s+core\b/i,
    /\b(?:my\s+node|rpc\s+providers?|nftdelegation|my\s+ipfs)\b/i,
    /\b(?:reconcile\s+(?:transactions|full\s+history)|recalculate\s+tdh)\b/i,
    /\b(?:nfts?|trx|transactions?)\s+(?:worker|full\s+recovery)\b/i
  ].some((pattern) => pattern.test(question));
}

export function desktopQuestionWithContext(
  question: string,
  previousBotAnswer?: string | null
): string | null {
  if (isDesktopSupportQuestion(question)) {
    return question;
  }
  if (
    !previousBotAnswer ||
    !isDesktopSupportQuestion(previousBotAnswer) ||
    /\b(?:mobile|android|ios|website|browser|on the web|on 6529\.io)\b/i.test(
      question
    ) ||
    !/\b(?:it|that|this|there|these|those|reset|reconcile|rebuild|refresh|worker|rpc|tdh|ipfs|wallet|sync|merkle)\b/i.test(
      question
    )
  ) {
    return null;
  }
  const scopedQuestion = `6529 Desktop Core: ${question}`;
  // A new explicit topic should not be outweighed by the previous long guide.
  // A pronoun-only follow-up still needs the subject of that guide.
  return /\b(?:reset|reconcile|rebuild|refresh|worker|rpc|tdh|ipfs|wallet|sync|merkle)\b/i.test(
    question
  )
    ? scopedQuestion
    : `${scopedQuestion}\n${previousBotAnswer}`;
}
