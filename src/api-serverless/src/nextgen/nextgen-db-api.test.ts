import { IDENTITIES_TABLE } from '@/constants';
import { sqlExecutor } from '@/sql-executor';
import { fetchNextGenCollectionTraitSetsUltimate } from './nextgen.db-api';

jest.mock('@/sql-executor', () => ({
  sqlExecutor: {
    execute: jest.fn()
  }
}));

const executeMock = sqlExecutor.execute as jest.MockedFunction<
  typeof sqlExecutor.execute
>;

describe('fetchNextGenCollectionTraitSetsUltimate', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('builds valid SQL for ultimate trait sets', async () => {
    executeMock
      .mockResolvedValueOnce([
        { trait: 'Palette', trait_count: 3 },
        { trait: 'Size', trait_count: 2 },
        { trait: 'Traced', trait_count: 2 }
      ])
      .mockResolvedValueOnce([{ count: 1 }])
      .mockResolvedValueOnce([
        {
          owner: '0xowner',
          normalised_handle: 'owner',
          handle: 'Owner',
          level: 0,
          tdh: 10,
          xtdh: 5,
          rep_score: 1,
          consolidation_display: 'owner',
          palette_sets: 3,
          size_sets: 2,
          traced_sets: 2
        }
      ]);

    await expect(
      fetchNextGenCollectionTraitSetsUltimate(1, 'Palette,Size,Traced', 10, 1)
    ).resolves.toMatchObject({
      count: 1,
      page: 1,
      next: false
    });

    expect(executeMock).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('collection_id = :collectionId'),
      {
        traits: ['Palette', 'Size', 'Traced'],
        collectionId: 1
      }
    );

    const countSql = executeMock.mock.calls[1][0] as string;
    expect(countSql).toContain(`${IDENTITIES_TABLE}.rep as rep_score,`);
    expect(countSql).toContain(`${IDENTITIES_TABLE}.rep,`);
    expect(countSql).toContain(`${IDENTITIES_TABLE}.xtdh as xtdh`);
    expect(countSql).toContain(`${IDENTITIES_TABLE}.xtdh`);
  });

  it('returns an empty page when requested traits do not all exist', async () => {
    executeMock.mockResolvedValueOnce([
      { trait: 'Palette', trait_count: 3 },
      { trait: 'Size', trait_count: 2 }
    ]);

    await expect(
      fetchNextGenCollectionTraitSetsUltimate(1, 'Palette,Size,Traced', 10, 1)
    ).resolves.toEqual({
      count: 0,
      page: 1,
      next: false,
      data: []
    });

    expect(executeMock).toHaveBeenCalledTimes(1);
  });
});
