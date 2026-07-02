import {
  getCalculationEditionSize,
  getMemeEditionSizeFloor,
  resolveMemeEditionSizeFloors
} from './memes-edition-size-floor';

describe('getMemeEditionSizeFloor', () => {
  it('uses claim max for the floor when claim max is below the cap', () => {
    expect(
      getMemeEditionSizeFloor({
        actualEditionSize: 176,
        claimMaxEditionSize: 305
      })
    ).toBe(305);
  });

  it('caps the floor at the research floor cap', () => {
    expect(
      getMemeEditionSizeFloor({
        actualEditionSize: 176,
        claimMaxEditionSize: 315
      })
    ).toBe(310);
  });

  it('falls back to actual edition size when claim max is missing', () => {
    expect(
      getMemeEditionSizeFloor({
        actualEditionSize: 176,
        claimMaxEditionSize: null
      })
    ).toBe(176);
  });

  it('allows the floor to be below actual supply', () => {
    expect(
      getMemeEditionSizeFloor({
        actualEditionSize: 320,
        claimMaxEditionSize: 315
      })
    ).toBe(310);
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
      actualEditionSizes: { 516: 176, 517: 301 },
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
      actualEditionSizes: { 516: 176, 517: 301 },
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
        actualEditionSizes: {},
        fetchOnChainClaimMaxes
      })
    ).resolves.toEqual({});

    expect(fetchOnChainClaimMaxes).not.toHaveBeenCalled();
  });
});
