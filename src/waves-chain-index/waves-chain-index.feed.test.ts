import { ChainFeedBlock } from '@/chain-gateway/chain-gateway.types';
import {
  emptyFeedEffects,
  feedEffects,
  WAVES_FEED_FAMILIES
} from './waves-chain-index.feed';

const id = (n: number | string) => `0x${String(n).padStart(64, '0')}`;

function block(
  height: number,
  records: {
    family: string;
    keyFields: Record<string, unknown>;
    valueFields?: Record<string, unknown> | null;
  }[]
): ChainFeedBlock {
  return {
    height,
    slot: height,
    root: id(0),
    time: height * 1000,
    records: records.map((record) => ({
      family: record.family,
      name: 'record',
      key: '0x',
      value: record.valueFields === null ? null : '0x',
      keyFields: record.keyFields,
      valueFields: record.valueFields === undefined ? {} : record.valueFields
    }))
  };
}

describe('feedEffects', () => {
  it('maps each family to what to read again', () => {
    const effects = feedEffects({
      blocks: [
        block(10, [
          { family: '0x0401', keyFields: { groupId: id(1) } },
          { family: '0x0402', keyFields: { groupId: id(2) } },
          { family: '0x0404', keyFields: { groupId: id(3), member: id(9) } },
          { family: '0x0403', keyFields: { scopeId: id(4), role: 'admin' } },
          { family: '0x0501', keyFields: { waveId: id(5) } },
          { family: '0x0502', keyFields: { waveId: id(6), version: 2 } },
          { family: '0x0601', keyFields: { decisionId: id(7) } },
          { family: '0x0602', keyFields: { decisionId: id(8), pauseId: 1 } },
          { family: '0x060d', keyFields: { decisionId: id(10), version: 1 } },
          { family: '0x0614', keyFields: { decisionId: id(11), at: 5 } },
          { family: '0x0603', keyFields: { entryId: id(12) } },
          { family: '0x0604', keyFields: { entryId: id(13), seq: 1 } },
          { family: '0x060B', keyFields: { pollId: id(14) } },
          { family: '0x060c', keyFields: { pollId: id(15), cid: id(1) } }
        ])
      ]
    });
    expect(Array.from(effects.groups)).toEqual([id(1), id(2), id(3)]);
    expect(Array.from(effects.roleWaves)).toEqual([id(4)]);
    expect(Array.from(effects.waves)).toEqual([id(5), id(6)]);
    expect(Array.from(effects.decisions)).toEqual([
      id(7),
      id(8),
      id(10),
      id(11)
    ]);
    expect(Array.from(effects.leaderboards)).toEqual([
      id(7),
      id(8),
      id(10),
      id(11)
    ]);
    expect(Array.from(effects.entries)).toEqual([id(12), id(13)]);
    expect(Array.from(effects.polls)).toEqual([id(14), id(15)]);
  });

  it('takes votes from the record, the last one per key, deletions as null', () => {
    const effects = feedEffects({
      blocks: [
        block(20, [
          {
            family: '0x0607',
            keyFields: { voter: id('A'), decisionId: id(1), entryId: id(2) },
            valueFields: { value: '5', updatedHeight: 20, index: 0 }
          },
          {
            family: '0x0607',
            keyFields: { voter: id('B'), decisionId: id(1), entryId: id(2) },
            valueFields: { value: '-3', updatedHeight: 20, index: 1 }
          }
        ]),
        block(21, [
          {
            family: '0x0607',
            keyFields: { voter: id('A'), decisionId: id(1), entryId: id(2) },
            valueFields: null
          }
        ])
      ]
    });
    expect(Array.from(effects.votes.values())).toEqual([
      {
        decisionId: id(1),
        entryId: id(2),
        voter: id('a'),
        value: null,
        updatedHeight: 21
      },
      {
        decisionId: id(1),
        entryId: id(2),
        voter: id('b'),
        value: '-3',
        updatedHeight: 20
      }
    ]);
    expect(Array.from(effects.leaderboards)).toEqual([id(1)]);
  });

  it('reads results by decision and result time, and the decision again', () => {
    const effects = feedEffects({
      blocks: [
        block(30, [
          { family: '0x060a', keyFields: { id: id(7), D: 1_764_000_000_000 } },
          { family: '0x060a', keyFields: { id: 'bad', D: 1 } }
        ])
      ]
    });
    expect(Array.from(effects.results.values())).toEqual([
      { decisionId: id(7), resultTime: 1_764_000_000_000 }
    ]);
    expect(Array.from(effects.decisions)).toEqual([id(7)]);
  });

  it('takes wave REP ratings only (target kind 2)', () => {
    const effects = feedEffects({
      blocks: [
        block(40, [
          {
            family: '0x0701',
            keyFields: {
              rater: id(1),
              matter: 3,
              targetKind: 2,
              target: id(5),
              category: id(6)
            }
          },
          {
            family: '0x0701',
            keyFields: {
              rater: id(1),
              matter: 1,
              targetKind: 1,
              target: id(8),
              category: id(6)
            }
          }
        ])
      ]
    });
    expect(Array.from(effects.repWaves)).toEqual([id(5)]);
  });

  it('ignores other families and ids it cannot read, and folds pages', () => {
    const into = emptyFeedEffects();
    feedEffects(
      {
        blocks: [
          block(50, [
            { family: '0x0201', keyFields: { principalId: id(1) } },
            { family: '0x0501', keyFields: { waveId: 'not-an-id' } }
          ])
        ]
      },
      into
    );
    feedEffects(
      {
        blocks: [
          block(51, [{ family: '0x0501', keyFields: { waveId: id(2) } }])
        ]
      },
      into
    );
    expect(Array.from(into.waves)).toEqual([id(2)]);
    expect(into.groups.size).toBe(0);
  });

  it('asks the feed for lowercase family codes', () => {
    for (const family of WAVES_FEED_FAMILIES) {
      expect(family).toMatch(/^0x0[4-7][0-9a-f]{2}$/);
    }
  });
});
