import type { HelpBotKnowledgeRecord } from './help-bot.knowledge';

export const MAX_DESKTOP_ANSWER_CHARACTERS = 6000;
export const MAX_DESKTOP_ANSWER_TOKENS = 1600;
export const MAX_DESKTOP_BRIEF_CHARACTERS = 1200;
export const MAX_DESKTOP_BRIEF_TOKENS = 350;

export function isDesktopKnowledgeRecord(
  record: HelpBotKnowledgeRecord
): boolean {
  return (
    record.id.startsWith('desktop.') && record.tags.includes('desktop-core')
  );
}

/** Depth is opt-in; asking how to do something does not request the whole manual. */
export function wantsDetailedDesktopAnswer(question: string): boolean {
  return /\b(?:in depth|in detail|detailed|full guide|complete guide|all (?:the )?steps|full walkthrough)\b/i.test(
    question
  );
}

function hasDesktopSupportTopic(question: string): boolean {
  return [
    /\b6529\s+(?:desktop|core)\b/i,
    /\bdesktop\s+(?:app|application|node|wallets?|tdh|merkle)\b/i,
    /\bcore\s+(?:app|wallets?|workers?|rpc|tdh|ipfs|recovery)\b/i,
    /\b(?:in|with|using|about|start|setup|explain|describe|what is|installed|downloaded|opened)\s+core\b/i,
    /\bmy\s+node\b/i
  ].some((pattern) => pattern.test(question));
}

function hasMismatch(question: string): boolean {
  return /\b(?:out of sync|mismatch|different|differs?|not match|doesn't match|doesnt match|does not match|don't match|dont match|do not match|not matching|still wrong)\b/i.test(
    question.replace(/’/g, "'")
  );
}

function isReferenceComparison(question: string): boolean {
  return (
    hasMismatch(question) ||
    /\b(?:compare|compared|comparison|versus|vs)\b/i.test(question)
  );
}

function excludesDesktop(question: string, desktopContext: boolean): boolean {
  if (/\b(?:mobile|android|ios|browser)\b/i.test(question)) return true;
  return (
    /\b(?:website|web|6529\.io)\b/i.test(question) &&
    !(desktopContext && isReferenceComparison(question))
  );
}

/** A named mobile wallet stays mobile even when the user uses the former Core name. */
export function isMobileWalletQuestion(question: string): boolean {
  return (
    /\b(?:mobile|android|ios)\b/i.test(question) &&
    /\bwallets?\b/i.test(question) &&
    !/\b(?:desktop|computer|browser|website|web)\b|6529\.io/i.test(question)
  );
}

/** Normalize search terms, preserving explicit cross-platform questions for clarification. */
export function normalizeMobileWalletQuestion(question: string): string {
  if (!isMobileWalletQuestion(question)) return question;
  return question
    .replace(/\b(?:6529\s+)?core\s+(?=(?:app\s+)?wallets?\b)/gi, '')
    .replace(/\b(?:android|ios)\b/gi, 'mobile')
    .replace(/\bmobile\s+app\s+(?=wallets?\b)/gi, 'mobile ')
    .replace(
      /\b(wallets?)\s+(?:in|on)\s+(?:the\s+)?(?:6529\s+)?mobile(?:\s+app)?\b/gi,
      'mobile $1'
    );
}

/** Explicit app/node context is required; RPC terminology alone is ambiguous. */
export function isDesktopSupportQuestion(question: string): boolean {
  return hasDesktopSupportTopic(question) && !excludesDesktop(question, true);
}

export function isAmbiguousDesktopQuestion(question: string): boolean {
  return (
    !hasDesktopSupportTopic(question) &&
    !/\b(?:mobile|android|ios|browser|website|web|6529\.io)\b/i.test(
      question
    ) &&
    /\b(?:rpc\s+providers?|reconcile\s+(?:transactions|full\s+history))\b/i.test(
      question
    )
  );
}

/** Carry local scope across symptom replies, without adding the previous guide to ranking. */
export function desktopQuestionWithContext(
  question: string,
  previousBotAnswer?: string | null
): string | null {
  const hasContext =
    !!previousBotAnswer && hasDesktopSupportTopic(previousBotAnswer);
  if (excludesDesktop(question, hasContext || hasDesktopSupportTopic(question)))
    return null;
  if (hasDesktopSupportTopic(question)) return question;
  if (
    !hasContext ||
    ![
      /\b(?:it|that|this|there|these|those|both|same|still)\b/i,
      /\b(?:reset|reconcil\w*|rebuild|refresh|worker|rpc|tdh|ipfs)\b/i,
      /\b(?:wallet|sync|merkle|block|caught up|missing)\b/i
    ].some((pattern) => pattern.test(question))
  )
    return null;
  return `6529 Desktop: ${question}`;
}

/** Inspect clauses conservatively: uncertain or negated reports cannot advance repair. */
function affirmativeReport(question: string, action: RegExp): boolean {
  // Keep question marks attached so shorthand questions cannot confirm progress.
  const clauses = question.replace(/’/g, "'").split(/[,;.!]|\bbut\b|(?<=\?)/i);
  const matching = clauses.filter((clause) => action.test(clause));
  const uncertain =
    /\b(?:not|never|no|if|should|can|could|would|maybe|unsure|whether)\b|n't\b|\?/i;
  return (
    matching.length > 0 &&
    matching.every(
      (clause) =>
        !uncertain.test(clause) &&
        !/^\s*(?:who|what|when|where|why|which|how)\b/i.test(clause) &&
        !/^\s*(?:have|has|had|did|do|does|are|is|was|were)\b/i.test(clause)
    )
  );
}

/** A suggestion, question, or negated action is not evidence of completion. */
function reportsRecalculation(question: string): boolean {
  return affirmativeReport(question, /\brecalculated\b/i);
}

function confirmsSameBlock(question: string, previousBotAnswer = ''): boolean {
  // In a reply to an asserted mismatch, "no block is same" corrects the bot.
  // Keep ordinary negations and plural "no blocks are the same" conservative.
  const text = question.replace(/\b(?:last|values)\s+/gi, '');
  const correction = /\bdifferent last block values mean\b/i.test(
    previousBotAnswer.replace(/\*/g, '')
  )
    ? text.replace(/^no\s+(?=(?:the\s+)?block\s+is\s+(?:the\s+)?same\b)/i, '')
    : text;
  return affirmativeReport(
    correction,
    /\b(?:same block|blocks? (?:are |is )?(?:the )?(?:identical|same|matches|match))\b/i
  );
}

function isDesktopMismatchQuestion(
  question: string,
  previousBotAnswer: string
): boolean {
  if (
    /\b(?:wallet|ipfs|rpc)\b/i.test(question) &&
    !/\b(?:tdh|merkle|node)\b/i.test(question)
  )
    return false;
  // Definition/navigation questions about blocks are not diagnostic progress reports.
  if (
    /^(?:what|where|explain|define)\b/i.test(question.trim()) &&
    /\bblocks?\b/i.test(question) &&
    !hasMismatch(question)
  )
    return false;
  const context = `${previousBotAnswer} ${question}`;
  return (
    /\b(?:tdh|merkle|node|block)\b/i.test(context) &&
    (hasMismatch(question) ||
      (hasMismatch(previousBotAnswer) &&
        /\b(?:same|both|tdh|merkle|block|caught up|recalculated|reconciled|still|it|done)\b/i.test(
          question
        )))
  );
}

function initialMismatchRecord(
  question: string,
  previousBotAnswer: string
): string {
  if (
    [
      /\bblocks? (?:values )?(?:are|is) different\b/i,
      /(?:^|[,;.!:]|\bbut\b)\s*(?:the )?(?:last )?blocks? (?:values )?different\b/i,
      /\bdifferent (?:last )?blocks?\b/i,
      /\bblocks? (?:do not|don't|does not|doesn't) match\b/i
    ].some((pattern) => pattern.test(question))
  )
    return 'desktop.tdh-block-mismatch';
  const sameBlock =
    confirmsSameBlock(question, previousBotAnswer) ||
    (!/\bblocks?\b/i.test(question) &&
      /\b(?:the Last Block values match|at the same Last Block)\b/i.test(
        previousBotAnswer
      ));
  if (!sameBlock) return 'desktop.tdh-out-of-sync';
  if (
    affirmativeReport(
      question,
      /\b(?:both|workers) (?:are )?(?:synced|caught up)\b/i
    )
  )
    return 'desktop.tdh-recalculate';
  return 'desktop.tdh-check-workers';
}

/** Select the next corpus-owned response using reported progress, never inferred device state. */
export function desktopRecordIdForQuestion(
  question: string,
  previousBotAnswer?: string | null
): string | undefined {
  if (isPostInstallationQuestion(question)) return 'desktop.after-installation';
  if (
    /^(?:what (?:is|is the)|explain|describe|tell me about)\s+(?:6529\s+)?core[?.!]*$/i.test(
      question.trim()
    )
  )
    return 'desktop.legacy-core-name';
  if (
    /^(?:what (?:is|is the)|explain|describe|tell me about)\s+(?:6529\s+)?desktop(?: app)?[?.!]*$/i.test(
      question.trim()
    )
  )
    return 'desktop.overview';
  if (!isDesktopMismatchQuestion(question, previousBotAnswer ?? ''))
    return undefined;
  const recalculated =
    reportsRecalculation(question) ||
    (!/\brecalculat\w*\b/i.test(question) &&
      /\b(?:you have already recalculated|since recalculation did not resolve)\b/i.test(
        previousBotAnswer ?? ''
      ));
  if (
    affirmativeReport(
      question,
      /\b(?:reconciled|reconciliation (?:has )?(?:finished|completed|done)|ran (?:the )?reconciliation)\b/i
    )
  ) {
    return reportsRecalculation(question)
      ? 'desktop.tdh-repair-diagnostics'
      : 'desktop.tdh-after-reconciliation';
  }
  if (recalculated) {
    return confirmsSameBlock(question, previousBotAnswer ?? '')
      ? 'desktop.tdh-same-block-mismatch'
      : 'desktop.tdh-after-recalculation';
  }
  return initialMismatchRecord(question, previousBotAnswer ?? '');
}

/** Installation alone must not override a specific wallet, RPC, or error question. */
function isPostInstallationQuestion(question: string): boolean {
  const text = question.replace(/’/g, "'").trim();
  const installation = /\b(?:installed|opened)\b/i;
  const nextStep =
    /\b(?:now what|what (?:do i do |comes )?next|what now|next steps?|get started|getting started|how do i start)\b/i;
  const specificTopic =
    /\b(?:wallets?|rpc|tdh|merkle|ipfs|errors?|crash\w*|fail\w*|stuck|sync\w*|connect\w*|pair\w*)\b/i;
  return (
    installation.test(text) &&
    nextStep.test(text) &&
    !specificTopic.test(text) &&
    !/\b(?:not|never|haven't|havent|can't|cant|couldn't|couldnt)\b/i.test(text)
  );
}
