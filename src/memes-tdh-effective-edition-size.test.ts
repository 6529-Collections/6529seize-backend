import {
  getEffectiveMemeEditionSize,
  resolveEffectiveMemeEditionSizes
} from './memes-tdh-effective-edition-size';

describe('getEffectiveMemeEditionSize', () => {
  it('keeps actual edition sizes at or above the threshold', () => {
    expect(
      getEffectiveMemeEditionSize({
        actualEditionSize: 300,
        claimMaxEditionSize: 315
      })
    ).toBe(300);
  });

  it('uses claim max for under-threshold editions when claim max is below the research target', () => {
    expect(
      getEffectiveMemeEditionSize({
        actualEditionSize: 176,
        claimMaxEditionSize: 305
      })
    ).toBe(305);
  });

  it('caps under-threshold editions at the research target', () => {
    expect(
      getEffectiveMemeEditionSize({
        actualEditionSize: 176,
        claimMaxEditionSize: 315
      })
    ).toBe(310);
  });

  it('never lets stale claim max shrink actual minted supply', () => {
    expect(
      getEffectiveMemeEditionSize({
        actualEditionSize: 176,
        claimMaxEditionSize: 150
      })
    ).toBe(176);
  });

  it('falls back to actual edition size when claim max is missing', () => {
    expect(
      getEffectiveMemeEditionSize({
        actualEditionSize: 176,
        claimMaxEditionSize: null
      })
    ).toBe(176);
  });
});

describe('resolveEffectiveMemeEditionSizes', () => {
  it('prefers on-chain claim max over db claim max', async () => {
    const effective = await resolveEffectiveMemeEditionSizes({
      actualEditionSizes: { 516: 176 },
      fetchOnChainClaimMaxes: async () => new Map([[516, 305]]),
      fetchDbClaimMaxes: async () => new Map([[516, 315]])
    });

    expect(effective[516]).toBe(305);
  });

  it('falls back to db claim max when on-chain claim max is unavailable', async () => {
    const effective = await resolveEffectiveMemeEditionSizes({
      actualEditionSizes: { 516: 176 },
      fetchOnChainClaimMaxes: async () => new Map(),
      fetchDbClaimMaxes: async () => new Map([[516, 315]])
    });

    expect(effective[516]).toBe(310);
  });

  it('passes TDH block tags to the on-chain fetcher', async () => {
    const fetchOnChainClaimMaxes = jest.fn(async () => new Map([[516, 305]]));

    await resolveEffectiveMemeEditionSizes({
      actualEditionSizes: { 516: 176 },
      blockTag: 123456,
      fetchOnChainClaimMaxes,
      fetchDbClaimMaxes: async () => new Map()
    });

    expect(fetchOnChainClaimMaxes).toHaveBeenCalledWith([516], 123456);
  });
});
