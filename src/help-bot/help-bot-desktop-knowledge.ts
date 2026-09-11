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

/** Select local-app support while keeping explicit mobile/browser use outside Core. */
export function isDesktopSupportQuestion(question: string): boolean {
  const comparesLocalTdh =
    hasDesktopSupportTopic(question) &&
    /\b(?:tdh|merkle)\b/i.test(question) &&
    /\b(?:compare|compared|comparison|different|differs|mismatch|versus|vs)\b/i.test(
      question
    ) &&
    !/\b(?:mobile|android|ios)\b/i.test(question);
  if (
    /\b(?:on|in|using|use|for)\s+(?:(?:the|my|a)\s+)?(?:mobile|android|ios|website|browser|web|6529\.io)\b/i.test(
      question
    ) &&
    !comparesLocalTdh
  ) {
    return false;
  }
  if (
    /\b(?:mobile|android|ios|website|browser)\b/i.test(question) &&
    !/\b(?:core|6529 desktop|desktop app|desktop node)\b/i.test(question)
  ) {
    return false;
  }
  return hasDesktopSupportTopic(question);
}

function hasDesktopSupportTopic(question: string): boolean {
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

/** Resolve a follow-up topic; the caller carries the validated scope into retrieval. */
export function desktopQuestionWithContext(
  question: string,
  previousBotAnswer?: string | null
): string | null {
  if (isDesktopSupportQuestion(question)) {
    return question;
  }
  if (
    !previousBotAnswer ||
    !hasDesktopSupportTopic(previousBotAnswer) ||
    /\b(?:mobile|android|ios|website|browser|web|6529\.io)\b/i.test(question) ||
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
