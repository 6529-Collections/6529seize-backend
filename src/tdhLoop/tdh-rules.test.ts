import { MemesSeason } from '@/entities/ISeason';
import {
  ADDITIONAL_CARD_SET_BOOST,
  ADDITIONAL_CARD_SET_RATIO,
  getAdjustedSeasons,
  getDefaultBoost,
  getTdhBoostRules,
  LAST_BOOSTED_MEMES_SEASON,
  MEMES_SEASON_SET_BOOST
} from './tdh-rules';

function season(id: number, startIndex: number, boost = 0.05): MemesSeason {
  return {
    id,
    start_index: startIndex,
    end_index: startIndex + 1,
    count: 2,
    name: `Season ${id}`,
    display: `SZN${id}`,
    boost
  };
}

function configuredFutureSeasons(): MemesSeason[] {
  return Array.from({ length: 22 }, (_, index) => {
    const id = index + 1;
    return season(
      id,
      index * 10 + 1,
      id <= LAST_BOOSTED_MEMES_SEASON ? MEMES_SEASON_SET_BOOST : 0
    );
  });
}

describe('tdh rules', () => {
  it('uses only seasons started by the snapshot Meme count', () => {
    const seasons = [season(1, 1), season(2, 3), season(3, 5)];

    expect(getAdjustedSeasons(seasons, 3).map((item) => item.id)).toEqual([
      1, 2
    ]);
  });

  it('keeps the current adjusted season out of active set bonuses', () => {
    const rules = getTdhBoostRules([season(1, 1), season(2, 3), season(3, 5)]);

    expect(rules.seasonSets.map((item) => item.season)).toEqual([1, 2]);
    expect(rules.fullCollection.firstSetBonus).toBe(0.1);
    expect(
      getDefaultBoost([season(1, 1), season(2, 3), season(3, 5)])
    ).toMatchObject({
      memes_szn1: { available: 0.05 },
      memes_szn2: { available: 0.05 },
      memes_card_sets: { available: 0.244051 }
    });
  });

  it('exposes the complete configured season and asymptotic set schedule', () => {
    const rules = getTdhBoostRules([]);

    expect(rules.seasonSchedule).toEqual({
      bonusPerSeason: MEMES_SEASON_SET_BOOST,
      lastBoostedSeason: LAST_BOOSTED_MEMES_SEASON,
      maxBonus: 1
    });
    expect(rules.fullCollection).toMatchObject({
      additionalSetInitialBonus: ADDITIONAL_CARD_SET_BOOST,
      additionalSetDecayRatio: ADDITIONAL_CARD_SET_RATIO,
      additionalSetsLimitBonus: 0.144051
    });
    expect(
      Math.round(
        (rules.baseMultiplier +
          rules.seasonSchedule.maxBonus +
          rules.fullCollection.additionalSetsLimitBonus +
          rules.gradients.maxBonus) *
          100
      ) / 100
    ).toBe(2.24);
  });

  it.each([
    {
      label: 'before Season 21 starts',
      eligibleMemesCount: 200,
      expectedLastActiveSeason: 19,
      expectedFullCollectionBonus: 0.95
    },
    {
      label: 'when Season 21 starts',
      eligibleMemesCount: 201,
      expectedLastActiveSeason: 20,
      expectedFullCollectionBonus: 1
    },
    {
      label: 'when Season 22 starts',
      eligibleMemesCount: 211,
      expectedLastActiveSeason: 20,
      expectedFullCollectionBonus: 1
    }
  ])(
    'activates the configured boundary $label',
    ({
      eligibleMemesCount,
      expectedLastActiveSeason,
      expectedFullCollectionBonus
    }) => {
      const adjustedSeasons = getAdjustedSeasons(
        configuredFutureSeasons(),
        eligibleMemesCount
      );
      const rules = getTdhBoostRules(adjustedSeasons);

      expect(rules.seasonSets[rules.seasonSets.length - 1]?.season).toBe(
        expectedLastActiveSeason
      );
      expect(rules.fullCollection.firstSetBonus).toBe(
        expectedFullCollectionBonus
      );
    }
  );

  it('does not activate preconfigured future seasons before their first Meme is eligible', () => {
    const adjustedSeasons = getAdjustedSeasons(configuredFutureSeasons(), 200);
    const rules = getTdhBoostRules(adjustedSeasons);

    expect(adjustedSeasons.map((item) => item.id)).toEqual(
      Array.from({ length: 20 }, (_, index) => index + 1)
    );
    expect(rules.seasonSets.some((item) => item.season >= 20)).toBe(false);
  });
});
