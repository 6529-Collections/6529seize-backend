import type { TokenTDH } from '@/entities/ITDH';
import {
  addTokensToIndex,
  calculateTokenTdhChanges
} from './tdh-history-changes';
import type { TokenIndex } from './tdh-history-changes';

function token(
  id: number,
  tdh: number,
  tdhRaw: number,
  balance: number
): TokenTDH {
  return {
    id,
    tdh,
    tdh__raw: tdhRaw,
    balance,
    hodl_rate: 1,
    days_held_per_edition: []
  };
}

function previousIndex(tokens: TokenTDH[], boost: number): TokenIndex {
  const index: TokenIndex = new Map();
  addTokensToIndex(index, tokens, boost);
  return index;
}

describe('calculateTokenTdhChanges', () => {
  it('treats undefined token arrays as empty snapshots', () => {
    const index: TokenIndex = new Map();

    addTokensToIndex(index, undefined, 1.5);

    expect(index.size).toBe(0);
    expect(calculateTokenTdhChanges(undefined, 1.5, index)).toEqual({
      tdhCreated: 0,
      tdhDestroyed: 0,
      boostedTdhCreated: 0,
      boostedTdhDestroyed: 0,
      rawTdhCreated: 0,
      rawTdhDestroyed: 0,
      balanceCreated: 0,
      balanceDestroyed: 0
    });
  });

  it('records normal daily accrual as created TDH', () => {
    const changes = calculateTokenTdhChanges(
      [token(1, 110, 11, 1)],
      1.5,
      previousIndex([token(1, 100, 10, 1)], 1.5)
    );

    expect(changes).toEqual({
      tdhCreated: 10,
      tdhDestroyed: 0,
      boostedTdhCreated: 15,
      boostedTdhDestroyed: 0,
      rawTdhCreated: 1,
      rawTdhDestroyed: 0,
      balanceCreated: 0,
      balanceDestroyed: 0
    });
  });

  it('records a partial edition sale when the card remains held', () => {
    const changes = calculateTokenTdhChanges(
      [token(34, 8501, 796, 1)],
      1.47,
      previousIndex([token(34, 21189, 1984, 2)], 1.47)
    );

    expect(changes).toEqual({
      tdhCreated: 0,
      tdhDestroyed: 12688,
      boostedTdhCreated: 0,
      boostedTdhDestroyed: 18652,
      rawTdhCreated: 0,
      rawTdhDestroyed: 1188,
      balanceCreated: 0,
      balanceDestroyed: 1
    });
  });

  it('records the previous value when the last copy leaves', () => {
    const changes = calculateTokenTdhChanges(
      [],
      1.42,
      previousIndex([token(118, 8089, 749, 1)], 1.47)
    );

    expect(changes).toEqual({
      tdhCreated: 0,
      tdhDestroyed: 8089,
      boostedTdhCreated: 0,
      boostedTdhDestroyed: 11891,
      rawTdhCreated: 0,
      rawTdhDestroyed: 749,
      balanceCreated: 0,
      balanceDestroyed: 1
    });
  });

  it('uses each snapshot boost when recording a boost reduction', () => {
    const changes = calculateTokenTdhChanges(
      [token(1, 1010, 101, 1)],
      1.4,
      previousIndex([token(1, 1000, 100, 1)], 1.5)
    );

    expect(changes).toEqual({
      tdhCreated: 10,
      tdhDestroyed: 0,
      boostedTdhCreated: 0,
      boostedTdhDestroyed: 86,
      rawTdhCreated: 1,
      rawTdhDestroyed: 0,
      balanceCreated: 0,
      balanceDestroyed: 0
    });
  });

  it('aggregates previous entries when consolidations merge', () => {
    const index: TokenIndex = new Map();
    addTokensToIndex(index, [token(1, 100, 10, 1)], 1.2);
    addTokensToIndex(index, [token(1, 200, 20, 1)], 1.3);

    const changes = calculateTokenTdhChanges(
      [token(1, 310, 31, 2)],
      1.4,
      index
    );

    expect(changes).toEqual({
      tdhCreated: 10,
      tdhDestroyed: 0,
      boostedTdhCreated: 54,
      boostedTdhDestroyed: 0,
      rawTdhCreated: 1,
      rawTdhDestroyed: 0,
      balanceCreated: 0,
      balanceDestroyed: 0
    });
  });

  it('keeps net changes equal to the difference between snapshot totals', () => {
    const index = previousIndex(
      [token(4, 8239, 627, 1), token(34, 8555, 801, 1)],
      1.42
    );
    const currentTokens = [token(34, 8565, 802, 1)];
    const changes = calculateTokenTdhChanges(currentTokens, 1.41, index);

    const previousBoostedTotal =
      Math.round(8239 * 1.42) + Math.round(8555 * 1.42);
    const currentBoostedTotal = Math.round(8565 * 1.41);

    expect(changes.boostedTdhCreated - changes.boostedTdhDestroyed).toBe(
      currentBoostedTotal - previousBoostedTotal
    );
  });
});
