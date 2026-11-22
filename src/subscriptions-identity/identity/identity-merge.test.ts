import { MergeChoice, MergeState, mergeStates } from './identity-merge';

jest.mock('@/sql-executor', () => ({ sqlExecutor: {} }));

const T1 = '2026-11-20 10:00:00.123456';
const T2 = '2026-11-21 11:00:00.000000';
const AT = '2026-11-26 12:00:00.000000';

const choice = (
  tokenId: number,
  subscribed: boolean,
  automatic: boolean,
  count: number,
  updatedAt: string
): MergeChoice => ({
  contract: '0xmemes',
  tokenId,
  subscribed,
  subscribedCount: count,
  automaticSubscription: automatic,
  createdAt: T1,
  updatedAt
});

describe('the one merge rule (O2)', () => {
  const survivor: MergeState = {
    balance: { balance: 0.25, createdAt: T1, updatedAt: T1 },
    mode: {
      automatic: false,
      subscribeAllEditions: true,
      createdAt: T1,
      updatedAt: T1
    },
    choices: [choice(580, true, false, 2, T2), choice(581, false, false, 1, T2)]
  };
  const joining: MergeState = {
    balance: { balance: 0.5, createdAt: T2, updatedAt: T2 },
    mode: {
      automatic: true,
      subscribeAllEditions: false,
      createdAt: T2,
      updatedAt: T2
    },
    choices: [choice(580, true, true, 1, T1), choice(582, true, true, 1, T2)]
  };

  it('sums balances and writes a fresh mode at the merge time, keeping either flag', () => {
    const merged = mergeStates([survivor, joining], AT);
    expect(merged.balance).toEqual({
      balance: 0.75,
      createdAt: AT,
      updatedAt: AT
    });
    expect(merged.mode).toEqual({
      automatic: true,
      subscribeAllEditions: true,
      createdAt: AT,
      updatedAt: AT
    });
  });

  it('combines choices for one card as the legacy merge does, to the microsecond', () => {
    const merged = mergeStates([survivor, joining], AT);
    expect(merged.choices).toEqual([
      // The manual request sets the count; the earlier priority time stays.
      { ...choice(580, true, false, 2, T1) },
      choice(581, false, false, 1, T2),
      choice(582, true, true, 1, T2)
    ]);
  });

  it('gives the same result wherever it runs: the cut and a later fold', () => {
    expect(mergeStates([survivor, joining], AT)).toEqual(
      mergeStates([survivor, joining], AT)
    );
    // No balance at all: no balance row, still a fresh mode row.
    expect(
      mergeStates(
        [
          { balance: null, mode: null, choices: [] },
          { balance: null, mode: null, choices: [] }
        ],
        AT
      )
    ).toEqual({
      balance: null,
      mode: {
        automatic: false,
        subscribeAllEditions: false,
        createdAt: AT,
        updatedAt: AT
      },
      choices: []
    });
  });
});
