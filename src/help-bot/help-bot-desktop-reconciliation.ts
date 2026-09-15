import type { HelpBotKnowledgeRecord } from './help-bot.knowledge';
import { affirmativeReport } from './help-bot-desktop-knowledge';

export type ReconciliationPortion = 25 | 50 | 75 | 100;
export interface DesktopReconciliationTurn {
  id: string;
  percentage: ReconciliationPortion;
  checkpoint?: number;
  minimum?: number;
}

const RANGE = /^Range: (25|50|75|100)% of blocks ([\d,]+)–([\d,]+)\.$/m;
const PREFIX = 'desktop.tdh-reconcile-';

/** Include at least the requested portion of the indexed block interval. */
export function reconciliationStartingBlock(
  minimum: number,
  checkpoint: number,
  percentage: ReconciliationPortion
): number | null {
  if (
    !Number.isSafeInteger(minimum) ||
    minimum < 0 ||
    !Number.isSafeInteger(checkpoint) ||
    checkpoint < minimum ||
    ![25, 50, 75, 100].includes(percentage)
  )
    return null;
  const first = BigInt(minimum);
  return Number(
    first +
      ((BigInt(checkpoint) - first) * BigInt(100 - percentage)) / BigInt(100)
  );
}

function numberFromText(value: string): number {
  return Number(value.replace(/,/g, ''));
}

function checkpointReply(question: string): number | undefined {
  const text = question
    .trim()
    .replace(/^(?:it says|it's|its)\s+/i, '')
    .replace(
      /^(?:my |the )?(?:latest block in db|checkpoint|transaction checkpoint)(?: is|:)?\s*/i,
      ''
    );
  const match = /^(\d+|\d{1,3}(?:,\d{3})+)[.!]?$/.exec(text);

  return match ? numberFromText(match[1]) : undefined;
}

function readRange(previous: string): DesktopReconciliationTurn | null {
  const match = RANGE.exec(previous);
  if (!match) return null;
  return {
    id: '',
    percentage: Number(match[1]) as ReconciliationPortion,
    minimum: numberFromText(match[2]),
    checkpoint: numberFromText(match[3])
  };
}

function reportsFailure(question: string): boolean {
  return (
    /\b(?:still (?:the )?same|different|differs?|mismatch|wrong)\b/i.test(
      question
    ) ||
    /\b(?:does not|doesn't|doesnt|not) match\b/i.test(question) ||
    /^(?:no|nope)[.!]*$/i.test(question.trim())
  );
}

function reportsSuccess(question: string): boolean {
  return affirmativeReport(
    question,
    /\b(?:matches|matching|fixed|worked|all match|all good|looks good|sorted)\b/i
  );
}

function deniesCompletion(question: string): boolean {
  return (
    /\b(?:not yet|haven't|havent|didn't|didnt|did not|unsure|maybe|not sure|still running|in progress|behind|stalled|stuck|only one)\b|\?/i.test(
      question
    ) ||
    /\b(?:not|never) (?:yet )?(?:done|finished|completed|recalculated|reconciled|synced|caught up|in sync)\b/i.test(
      question
    )
  );
}

function isYes(question: string): boolean {
  return /^(?:yes|yep|yeah|correct)[.!]*$/i.test(question.trim());
}

function reportsExecutionFailure(question: string): boolean {
  return /\b(?:errors?|failed|failing|crashed|aborted)\b/i.test(question);
}

function nextRange(
  state: DesktopReconciliationTurn
): DesktopReconciliationTurn {
  return state.percentage === 100
    ? { ...state, id: `${PREFIX}reset` }
    : {
        ...state,
        id: `${PREFIX}range`,
        percentage: (state.percentage + 25) as ReconciliationPortion
      };
}

function afterRecalculation(
  question: string,
  state: DesktopReconciliationTurn
): DesktopReconciliationTurn {
  if (
    (reportsSuccess(question) && !reportsFailure(question)) ||
    isYes(question)
  )
    return { ...state, id: `${PREFIX}success` };
  if (reportsFailure(question)) return nextRange(state);
  return { ...state, id: `${PREFIX}result` };
}

/** Range/progress comes from the immediately preceding authored reply, not invented node state. */
export function desktopReconciliationTurn(
  question: string,
  previous = ''
): DesktopReconciliationTurn | null {
  if (
    !/6529 Desktop/i.test(previous) ||
    /\b(?:wallet|mobile|android|ios|ipfs|rpc|nfts?|refresh)\b/i.test(
      question
    ) ||
    (/\breset\b/i.test(question) && !/transaction reset/i.test(previous))
  )
    return null;
  // A new snapshot comparison overrides the earlier matching-block context.
  if (
    /\bdifferent (?:last )?blocks?\b/i.test(question) ||
    /\bblocks? (?:values )?(?:are |is )?different\b/i.test(question) ||
    /\bblocks? (?:do not|don't|does not|doesn't) match\b/i.test(question)
  )
    return null;
  const state = readRange(previous);
  if (!state) {
    if (
      !/most recent 25%/i.test(previous) ||
      !/Latest block in DB/i.test(previous)
    )
      return null;
    if (affirmativeReport(question, /\breconciled\b/i)) return null;
    return {
      id: `${PREFIX}range`,
      percentage: 25,
      checkpoint: checkpointReply(question)
    };
  }
  if (/transaction reset/i.test(previous))
    return continueReset(question, previous, state);
  const updatedCheckpoint = checkpointReply(question);
  if (updatedCheckpoint !== undefined)
    return { ...state, id: `${PREFIX}range`, checkpoint: updatedCheckpoint };
  // Questions about other subjects leave this bounded dialogue.
  if (/^(?:what is|explain|tell me about|where is)\b/i.test(question.trim()))
    return null;
  return continueRange(question, previous, state);
}

function continueRange(
  question: string,
  previous: string,
  state: DesktopReconciliationTurn
): DesktopReconciliationTurn {
  const askedForResult =
    /Recalculate TDH Now|Do TDH and Merkle Root now match/i.test(previous);
  if (reportsExecutionFailure(question)) {
    const calculationFailed = askedForResult && !/\breconcil/i.test(question);
    return {
      ...state,
      id: `${PREFIX}${calculationFailed ? 'calculation-pending' : 'progress'}`
    };
  }
  if (deniesCompletion(question))
    return {
      ...state,
      id: `${PREFIX}${askedForResult ? 'recalculate' : 'progress'}`
    };
  const done = affirmativeReport(
    question,
    /\b(?:done|finished|completed|reconciled)\b/i
  );
  const recalculated = affirmativeReport(question, /\brecalculated\b/i);
  if (askedForResult) return afterRecalculation(question, state);
  if (done && recalculated) return afterRecalculation(question, state);
  if (
    done ||
    (/Has reconciliation finished/i.test(previous) && isYes(question))
  )
    return { ...state, id: `${PREFIX}recalculate` };
  return { ...state, id: `${PREFIX}progress` };
}

function continueReset(
  question: string,
  previous: string,
  state: DesktopReconciliationTurn
): DesktopReconciliationTurn {
  if (/Do not repeat the reset/i.test(previous))
    return {
      ...state,
      id: `${PREFIX}${reportsSuccess(question) && !reportsFailure(question) ? 'success' : 'reset-diagnostics'}`
    };
  const askedForResult =
    /Recalculate TDH Now|Do TDH and Merkle Root now match/i.test(previous);
  if (
    deniesCompletion(question) ||
    /\b(?:error|failed|failing|only|still syncing|isn't|aren't|isnt|arent)\b/i.test(
      question
    )
  )
    return {
      ...state,
      id: `${PREFIX}${askedForResult ? 'reset-calculation-pending' : 'reset-progress'}`
    };
  if (askedForResult) return afterResetRecalculation(question, state);
  const synced = reportsResetResync(question, previous);
  if (synced && affirmativeReport(question, /\brecalculated\b/i))
    return afterResetRecalculation(question, state);
  if (synced || isYes(question))
    return { ...state, id: `${PREFIX}reset-recalculate` };
  return { ...state, id: `${PREFIX}reset-progress` };
}

function reportsResetResync(question: string, previous: string): boolean {
  if (
    /have Transactions and NFTDelegation both finished syncing/i.test(
      previous
    ) &&
    /^(?:(?:they|both)(?: are| have)? )?(?:done|finished|completed)[.!]*$/i.test(
      question.trim()
    )
  )
    return true;
  if (
    !affirmativeReport(
      question,
      /\b(?:synced|caught up|in sync|reached (?:that|the|target) block)\b/i
    )
  )
    return false;
  return (
    /\b(?:both|they|workers|all|Transactions and NFTDelegation)\b/i.test(
      question
    ) || /^(?:synced|caught up|in sync)[.!]*$/i.test(question.trim())
  );
}

function afterResetRecalculation(
  question: string,
  state: DesktopReconciliationTurn
): DesktopReconciliationTurn {
  if (
    (reportsSuccess(question) && !reportsFailure(question)) ||
    isYes(question)
  )
    return { ...state, id: `${PREFIX}success` };
  return {
    ...state,
    id: `${PREFIX}${reportsFailure(question) ? 'reset-diagnostics' : 'reset-result'}`
  };
}

/** Templates and the supported minimum are corpus-owned; all arithmetic is deterministic. */
export function renderReconciliationTurn(
  turn: DesktopReconciliationTurn,
  record: HelpBotKnowledgeRecord
): string | null {
  const minimum = record.reconciliationMinBlock;
  const checkpoint = turn.checkpoint;
  if (minimum === undefined || checkpoint === undefined) return null;
  if (turn.minimum !== undefined && turn.minimum !== minimum) return null;
  const from = reconciliationStartingBlock(
    minimum,
    checkpoint,
    turn.percentage
  );
  if (from === null || !record.briefAnswer) return null;
  const values: Record<string, string> = {
    percentage: String(turn.percentage),
    minimum_block: minimum.toLocaleString('en-US'),
    checkpoint: checkpoint.toLocaleString('en-US'),
    from_block: from.toLocaleString('en-US')
  };
  const answer = record.briefAnswer.replace(
    /\{\{(\w+)\}\}/g,
    (token, name: string) => values[name] ?? token
  );
  return /\{\{/.test(answer) ? null : answer;
}
