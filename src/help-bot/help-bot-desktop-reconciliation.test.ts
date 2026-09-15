import {
  reconciliationStartingBlock,
  desktopReconciliationTurn,
  renderReconciliationTurn
} from './help-bot-desktop-reconciliation';
import type { HelpBotKnowledgeRecord } from './help-bot.knowledge';

describe('block-based reconciliation arithmetic', () => {
  it.each([
    [26000000, 25, 22840215],
    [26000000, 50, 19680430],
    [26000000, 75, 16520645],
    [26000000, 100, 13360860],
    [30000000, 25, 25840215],
    [13360860, 25, 13360860],
    [13360861, 25, 13360860]
  ])(
    'calculates checkpoint %i at %i%% as %i',
    (checkpoint, percentage, expected) => {
      expect(
        reconciliationStartingBlock(13360860, checkpoint, percentage as 25)
      ).toBe(expected);
    }
  );
  it.each([
    NaN,
    Infinity,
    -1,
    13360859,
    26000000.5,
    Number.MAX_SAFE_INTEGER + 1
  ])('rejects invalid checkpoint %s', (checkpoint) => {
    expect(reconciliationStartingBlock(13360860, checkpoint, 25)).toBeNull();
  });
  it('does not use the conversation range for an unrelated wallet question', () => {
    expect(
      desktopReconciliationTurn(
        'how do I back up my mobile wallet?',
        '6529 Desktop\nRange: 25% of blocks 13,360,860–26,000,000.'
      )
    ).toBeNull();
  });
  it('rejects a previous range whose minimum no longer matches the corpus', () => {
    expect(
      renderReconciliationTurn(
        { id: 'range', percentage: 25, minimum: 100, checkpoint: 1000 },
        {
          reconciliationMinBlock: 200,
          briefAnswer: '{{from_block}}'
        } as HelpBotKnowledgeRecord
      )
    ).toBeNull();
  });
});

describe('transaction reset conversation', () => {
  const range = '\nRange: 100% of blocks 13,360,860–26,000,000.';
  const instruction =
    'In 6529 Desktop, use transaction reset, then tell me when both workers are synced.' +
    range;
  const recalculate =
    'The transaction reset and resync are complete. In 6529 Desktop use Recalculate TDH Now. Once finished, do TDH and Merkle Root now match?' +
    range;

  it.each([
    ['still different', 'reset'],
    ['yes', 'success'],
    ['not recalculated, still different', 'recalculate'],
    ['maybe finished', 'recalculate']
  ])(
    'offers reset only after a completed full repair: %s',
    (question, stage) => {
      const prior = 'In 6529 Desktop use Recalculate TDH Now.' + range;
      expect(desktopReconciliationTurn(question, prior)?.id).toBe(
        'desktop.tdh-reconcile-' + stage
      );
    }
  );

  it.each([
    ['reset done', 'reset-progress'],
    ['only Transactions is synced', 'reset-progress'],
    ['Transactions synced', 'reset-progress'],
    ['both synced but NFTDelegation is behind', 'reset-progress'],
    ['both synced but NFTDelegation not yet', 'reset-progress'],
    ["Transactions synced but NFTDelegation isn't", 'reset-progress'],
    ['not both synced', 'reset-progress'],
    ['are both in sync?', 'reset-progress'],
    ['reset failed', 'reset-progress'],
    ['still syncing', 'reset-progress'],
    ['both synced', 'reset-recalculate'],
    ['they are in sync', 'reset-recalculate'],
    ['they reached that block', 'reset-recalculate'],
    ['yes', 'reset-recalculate'],
    ['synced', 'reset-recalculate'],
    [
      'reset done, both synced and recalculated, still different',
      'reset-diagnostics'
    ],
    ['reset done, both synced and recalculated, all good', 'success']
  ])('handles resync report %s', (question, stage) => {
    expect(desktopReconciliationTurn(question, instruction)?.id).toBe(
      'desktop.tdh-reconcile-' + stage
    );
  });

  it.each([
    ['yes', 'success'],
    ['it matches', 'success'],
    ['no', 'reset-diagnostics'],
    ['still different', 'reset-diagnostics'],
    ['done', 'reset-result'],
    ['not yet', 'reset-calculation-pending'],
    ['not recalculated, still different', 'reset-calculation-pending'],
    ['workers not synced, still different', 'reset-calculation-pending'],
    ['calculation failed', 'reset-calculation-pending']
  ])('handles post-reset recalculation report %s', (question, stage) => {
    expect(desktopReconciliationTurn(question, recalculate)?.id).toBe(
      'desktop.tdh-reconcile-' + stage
    );
  });

  it.each(['done', 'they finished', 'both completed'])(
    'accepts shorthand answering the explicit resync question: %s',
    (question) => {
      const prior =
        'After the transaction reset in 6529 Desktop, have Transactions and NFTDelegation both finished syncing?' +
        range;
      expect(desktopReconciliationTurn(question, prior)?.id).toBe(
        'desktop.tdh-reconcile-reset-recalculate'
      );
    }
  );

  it('keeps persistent failure at diagnostics rather than repeating reset', () => {
    const prior =
      'In 6529 Desktop, the transaction reset and recalculation did not fix it. Do not repeat the reset.' +
      range;
    expect(desktopReconciliationTurn('still different', prior)?.id).toBe(
      'desktop.tdh-reconcile-reset-diagnostics'
    );
    expect(desktopReconciliationTurn('it is fixed', prior)?.id).toBe(
      'desktop.tdh-reconcile-success'
    );
  });

  it.each([
    'how do I reset my mobile wallet?',
    'NFT reset',
    'the blocks are different'
  ])('leaves reset dialogue for %s', (question) => {
    expect(desktopReconciliationTurn(question, instruction)).toBeNull();
  });
});

describe('failed reconciliation does not advance recovery', () => {
  it.each([25, 50, 75, 100])(
    'retains the %i%% range when reconciliation fails',
    (percentage) => {
      const previous = `In 6529 Desktop, has reconciliation finished?\nRange: ${percentage}% of blocks 13,360,860–26,000,000.`;
      for (const question of [
        'reconciliation failed, recalculated but still different',
        'completed with errors',
        'it aborted'
      ]) {
        expect(desktopReconciliationTurn(question, previous)).toMatchObject({
          id: 'desktop.tdh-reconcile-progress',
          percentage,
          checkpoint: 26000000
        });
      }
    }
  );
  it('honors a reported reconciliation failure even after suggesting recalculation', () => {
    const previous =
      'In 6529 Desktop use Recalculate TDH Now.\nRange: 100% of blocks 13,360,860–26,000,000.';
    expect(
      desktopReconciliationTurn(
        'reconciliation actually failed, still different',
        previous
      )?.id
    ).toBe('desktop.tdh-reconcile-progress');
  });
});
