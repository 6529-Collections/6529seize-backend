const mockGetClaimForToken = jest.fn();
const mockContract = jest.fn(() => ({
  getClaimForToken: mockGetClaimForToken
}));

jest.mock('ethers', () => ({
  ethers: {
    Contract: mockContract,
    JsonRpcProvider: jest.fn()
  }
}));

import {
  fetchOnChainMemeClaimMaxEditionSizes,
  getCalculationEditionSize,
  getMemeEditionSizeFloor,
  resolveMemeEditionSizeFloors
} from './memes-edition-size-floor';

beforeEach(() => {
  mockContract.mockClear();
  mockGetClaimForToken.mockReset();
});

afterEach(() => {
  jest.useRealTimers();
});

describe('getMemeEditionSizeFloor', () => {
  it('uses claim max for the floor when claim max is below the cap', () => {
    expect(getMemeEditionSizeFloor(305)).toBe(305);
  });

  it('caps the floor at the research floor cap', () => {
    expect(getMemeEditionSizeFloor(315)).toBe(310);
  });

  it('ignores invalid claim maxes', () => {
    expect(getMemeEditionSizeFloor(0)).toBeNull();
  });

  it('allows the floor to be below actual supply', () => {
    expect(getMemeEditionSizeFloor(315)).toBe(310);
  });
});

describe('getCalculationEditionSize', () => {
  it('uses the floor when actual supply is below the floor', () => {
    expect(
      getCalculationEditionSize({
        supply: 301,
        edition_size_floor: 310
      })
    ).toBe(310);
  });

  it('uses actual supply when actual supply is above the floor', () => {
    expect(
      getCalculationEditionSize({
        supply: 320,
        edition_size_floor: 310
      })
    ).toBe(320);
  });

  it('does not let stale claim data shrink the calculation size', () => {
    expect(
      getCalculationEditionSize({
        supply: 176,
        edition_size_floor: 150
      })
    ).toBe(176);
  });
});

describe('resolveMemeEditionSizeFloors', () => {
  it('resolves floors from on-chain claim maxes', async () => {
    const floors = await resolveMemeEditionSizeFloors({
      tokenIds: [516, 517],
      fetchOnChainClaimMaxes: async () =>
        new Map([
          [516, 305],
          [517, 315]
        ])
    });

    expect(floors).toEqual({
      516: 305,
      517: 310
    });
  });

  it('omits tokens without on-chain claim maxes', async () => {
    const floors = await resolveMemeEditionSizeFloors({
      tokenIds: [516, 517],
      fetchOnChainClaimMaxes: async () => new Map([[516, 315]])
    });

    expect(floors).toEqual({
      516: 310
    });
  });

  it('does not fetch when there are no token ids', async () => {
    const fetchOnChainClaimMaxes = jest.fn(async () => new Map());

    await expect(
      resolveMemeEditionSizeFloors({
        tokenIds: [],
        fetchOnChainClaimMaxes
      })
    ).resolves.toEqual({});

    expect(fetchOnChainClaimMaxes).not.toHaveBeenCalled();
  });
});

describe('fetchOnChainMemeClaimMaxEditionSizes', () => {
  it('times out a hung token claim fetch without blocking other tokens', async () => {
    jest.useFakeTimers();
    try {
      mockGetClaimForToken.mockImplementation(
        (_contract: string, tokenId: number) => {
          if (tokenId === 516) {
            return new Promise(() => undefined);
          }
          return Promise.resolve([0, { totalMax: 305 }]);
        }
      );

      const claimMaxesPromise = fetchOnChainMemeClaimMaxEditionSizes(
        [516, 517],
        {} as never
      );

      await Promise.resolve();
      jest.advanceTimersByTime(10_000);

      await expect(claimMaxesPromise).resolves.toEqual(new Map([[517, 305]]));
      expect(mockGetClaimForToken).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });
});
