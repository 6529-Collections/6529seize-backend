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
