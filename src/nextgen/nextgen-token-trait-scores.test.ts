import fc from 'fast-check';
import { NextGenCollection, NextGenTokenTrait } from '@/entities/INextGen';
import {
  fetchNextGenCollections,
  fetchNextGenTokensForCollection,
  fetchNextGenTokenTraits,
  persistNextGenCollection,
  persistNextGenCollectionHodlRate,
  persistNextGenTraits,
  persistNextGenTraitScores
} from './nextgen.db';
import { MINT_TYPE_TRAIT } from './nextgen_constants';
import { refreshNextgenTokens } from './nextgen_tokens';

jest.mock('./nextgen.db', () => ({
  fetchNextGenCollections: jest.fn(),
  fetchNextGenTokensForCollection: jest.fn(),
  fetchNextGenTokenTraits: jest.fn(),
  persistNextGenCollection: jest.fn(),
  persistNextGenCollectionHodlRate: jest.fn(),
  persistNextGenTraits: jest.fn(),
  persistNextGenTraitScores: jest.fn()
}));

const mockedFetchNextGenCollections =
  fetchNextGenCollections as jest.MockedFunction<
    typeof fetchNextGenCollections
  >;
const mockedFetchNextGenTokensForCollection =
  fetchNextGenTokensForCollection as jest.MockedFunction<
    typeof fetchNextGenTokensForCollection
  >;
const mockedFetchNextGenTokenTraits =
  fetchNextGenTokenTraits as jest.MockedFunction<
    typeof fetchNextGenTokenTraits
  >;
const mockedPersistNextGenTraits = persistNextGenTraits as jest.MockedFunction<
  typeof persistNextGenTraits
>;
const mockedPersistNextGenCollectionHodlRate =
  persistNextGenCollectionHodlRate as jest.MockedFunction<
    typeof persistNextGenCollectionHodlRate
  >;
const mockedPersistNextGenTraitScores =
  persistNextGenTraitScores as jest.MockedFunction<
    typeof persistNextGenTraitScores
  >;
const mockedPersistNextGenCollection =
  persistNextGenCollection as jest.MockedFunction<
    typeof persistNextGenCollection
  >;

const mintTypeTraitLower = MINT_TYPE_TRAIT.toLowerCase();

const fakeEntityManager = {
  query: jest.fn().mockResolvedValue([{ maxSupply: 1000 }]),
  getRepository: jest.fn()
} as any;

/**
 * Verbatim pre-optimization pipeline: the O(T^2) per-row score computation of
 * processCollectionTraitScores plus the per-category-refiltering
 * calulateTokenRanks chain, kept as the reference implementation.
 */
function referenceTraitScorePipeline(tokenTraits: any[]): any[] {
  const tokenCount = new Set(tokenTraits.map((item) => item.token_id)).size;
  const traitsCount = new Set(
    tokenTraits
      .filter((t) => !t.trait.toLowerCase().startsWith(mintTypeTraitLower))
      .map((item) => item.trait)
  ).size;

  tokenTraits.forEach((tt) => {
    const name = tt.trait;
    const value = tt.value;

    tt.token_count = tokenCount;

    const sharedKey = tokenTraits.filter((other) => other.trait === name);
    tt.trait_count = new Set(sharedKey.map((item) => item.value)).size;

    tt.value_count = sharedKey.filter((other) => other.value === value).length;

    if (name.toLowerCase().startsWith(mintTypeTraitLower)) {
      tt.statistical_rarity = -1;
      tt.rarity_score = -1;
      tt.rarity_score_normalised = -1;
      tt.rarity_score_trait_count_normalised = -1;
      tt.statistical_rarity_normalised = -1;
      tt.single_trait_rarity_score_normalised = -1;
    } else {
      const sharedKeyValue = sharedKey.filter(
        (other) => other.value === value
      ).length;
      const valuesCountForTrait = new Set(sharedKey.map((item) => item.value))
        .size;

      const statisticalScore = sharedKeyValue / tokenCount;
      tt.statistical_rarity = statisticalScore;
      tt.single_trait_rarity_score_normalised =
        statisticalScore * valuesCountForTrait;
      tt.statistical_rarity_normalised =
        statisticalScore ** (1 / valuesCountForTrait);
      tt.rarity_score = tokenCount / sharedKeyValue;
      tt.rarity_score_normalised =
        ((1 / sharedKeyValue) * 1000000) / (traitsCount * valuesCountForTrait);
      tt.rarity_score_trait_count_normalised =
        ((1 / sharedKeyValue) * 1000000) /
        ((traitsCount + 1) * valuesCountForTrait);
    }
  });

  let rankedTraits = referenceCalulateTokenRanks(tokenTraits, 'rarity_score');
  rankedTraits = referenceCalulateTokenRanks(
    rankedTraits,
    'rarity_score_normalised'
  );
  rankedTraits = referenceCalulateTokenRanks(
    rankedTraits,
    'statistical_rarity'
  );
  rankedTraits = referenceCalulateTokenRanks(
    rankedTraits,
    'statistical_rarity_normalised'
  );
  rankedTraits = referenceCalulateTokenRanks(
    rankedTraits,
    'single_trait_rarity_score_normalised'
  );
  rankedTraits = referenceCalulateTokenRanks(
    rankedTraits,
    'rarity_score_trait_count_normalised'
  );
  return rankedTraits;
}

function referenceCalulateTokenRanks(startingTraits: any[], field: string) {
  const categories = new Set<string>(startingTraits.map((tt) => tt.trait));
  const rankedTokens = Array.from(categories).map((category) => {
    const traits = startingTraits.filter((tt) => tt.trait === category);
    return referenceRanksForCategory(traits, field);
  });
  return rankedTokens.flat();
}

function referenceRanksForCategory(startingTraits: any[], field: string) {
  const tokenTraits = [...startingTraits] as any[];
  const sortedTraits = tokenTraits.sort((a, b) => b[field] - a[field]);

  let currentRank = 1;
  let previousValue = sortedTraits[0][field];

  sortedTraits.forEach((tt) => {
    if (tt[field] !== previousValue) {
      currentRank += 1;
      previousValue = tt[field];
    }
    tt[`${field}_rank`] = currentRank;
  });

  return sortedTraits;
}

const TRAITS = ['Background', 'Palette', MINT_TYPE_TRAIT, 'Size'];
const VALUES = ['Alpha', 'Beta', 'Gamma', 'None Big', 'Delta'];

const traitRowArb: fc.Arbitrary<any> = fc.record({
  token_id: fc.integer({ min: 1, max: 25 }),
  trait: fc.constantFrom(...TRAITS),
  value: fc.constantFrom(...VALUES)
});

describe('refreshNextgenTokens trait scores', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    fakeEntityManager.query.mockResolvedValue([{ maxSupply: 1000 }]);
    mockedFetchNextGenCollections.mockResolvedValue([
      { id: 1, name: 'Test Collection' } as NextGenCollection
    ]);
    // empty token list keeps processTokens inert; this suite targets the
    // trait-score pipeline feeding persistNextGenTraits
    mockedFetchNextGenTokensForCollection.mockResolvedValue([]);
    mockedPersistNextGenTraits.mockResolvedValue(undefined);
    mockedPersistNextGenCollectionHodlRate.mockResolvedValue(undefined);
    mockedPersistNextGenTraitScores.mockResolvedValue(undefined);
    mockedPersistNextGenCollection.mockResolvedValue(undefined);
  });

  it('persists exactly the rows (content and order) of the pre-optimization pipeline', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(traitRowArb, { minLength: 1, maxLength: 60 }),
        async (rows) => {
          const actualInput = rows.map((r) => ({ ...r, collection_id: 1 }));
          const referenceInput = rows.map((r) => ({ ...r, collection_id: 1 }));

          mockedPersistNextGenTraits.mockClear();
          mockedFetchNextGenTokenTraits.mockResolvedValue(
            actualInput as NextGenTokenTrait[]
          );

          await refreshNextgenTokens(fakeEntityManager);

          const expected = referenceTraitScorePipeline(referenceInput);
          expect(mockedPersistNextGenTraits).toHaveBeenCalledTimes(1);
          const persisted = mockedPersistNextGenTraits.mock.calls[0][1];
          expect(persisted).toEqual(expected);
        }
      ),
      { numRuns: 40 }
    );
  });

  it('marks mint-type traits with -1 scores while still counting their values', async () => {
    const rows = [
      {
        token_id: 1,
        trait: MINT_TYPE_TRAIT,
        value: 'Airdrop',
        collection_id: 1
      },
      { token_id: 2, trait: MINT_TYPE_TRAIT, value: 'Mint', collection_id: 1 },
      { token_id: 1, trait: 'Background', value: 'Alpha', collection_id: 1 },
      { token_id: 2, trait: 'Background', value: 'Alpha', collection_id: 1 }
    ];
    mockedFetchNextGenTokenTraits.mockResolvedValue(
      rows as unknown as NextGenTokenTrait[]
    );

    await refreshNextgenTokens(fakeEntityManager);

    const persisted = mockedPersistNextGenTraits.mock.calls[0][1] as any[];
    const mintRows = persisted.filter((r) => r.trait === MINT_TYPE_TRAIT);
    expect(mintRows).toHaveLength(2);
    mintRows.forEach((r) => {
      expect(r.rarity_score).toBe(-1);
      expect(r.trait_count).toBe(2);
      expect(r.value_count).toBe(1);
    });
    const backgroundRows = persisted.filter((r) => r.trait === 'Background');
    backgroundRows.forEach((r) => {
      expect(r.value_count).toBe(2);
      expect(r.trait_count).toBe(1);
      expect(r.statistical_rarity).toBe(1);
    });
  });
});
