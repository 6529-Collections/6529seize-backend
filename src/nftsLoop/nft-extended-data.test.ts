import {
  fetchNftIdsRecordedInTdh,
  fetchAllMemeLabNFTs,
  fetchNftsForContract,
  getDataSource,
  persistLabExtendedData,
  persistMemesExtendedData,
  persistMemesSeasons
} from '../db';
import {
  LabExtendedData,
  LabNFT,
  MemesExtendedData,
  NFT
} from '../entities/INFT';
import {
  findMemeLabExtendedData,
  findMemesExtendedData
} from './nft-extended-data';
import {
  MEME_8_EDITION_BURN_ADJUSTMENT,
  NULL_ADDRESS,
  RESEARCH_6529_ADDRESS,
  SIX529_MUSEUM
} from '@/constants';

jest.mock('../db', () => ({
  fetchNftIdsRecordedInTdh: jest.fn(),
  fetchAllMemeLabNFTs: jest.fn(),
  fetchNftsForContract: jest.fn(),
  getDataSource: jest.fn(),
  persistLabExtendedData: jest.fn(),
  persistMemesExtendedData: jest.fn(),
  persistMemesSeasons: jest.fn()
}));

const mockedFetchNftIdsRecordedInTdh =
  fetchNftIdsRecordedInTdh as jest.MockedFunction<
    typeof fetchNftIdsRecordedInTdh
  >;
const mockedFetchNftsForContract = fetchNftsForContract as jest.MockedFunction<
  typeof fetchNftsForContract
>;
const mockedFetchAllMemeLabNFTs = fetchAllMemeLabNFTs as jest.MockedFunction<
  typeof fetchAllMemeLabNFTs
>;
const mockedGetDataSource = getDataSource as jest.MockedFunction<
  typeof getDataSource
>;
const mockedPersistMemesExtendedData =
  persistMemesExtendedData as jest.MockedFunction<
    typeof persistMemesExtendedData
  >;
const mockedPersistMemesSeasons = persistMemesSeasons as jest.MockedFunction<
  typeof persistMemesSeasons
>;
const mockedPersistLabExtendedData =
  persistLabExtendedData as jest.MockedFunction<typeof persistLabExtendedData>;

type Owner = {
  readonly contract: string;
  readonly token_id: number;
  readonly wallet: string;
  balance: number;
};

describe('nft extended data', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedFetchNftIdsRecordedInTdh.mockResolvedValue(new Set());
    mockedPersistMemesExtendedData.mockResolvedValue(undefined);
    mockedPersistMemesSeasons.mockResolvedValue(undefined);
    mockedPersistLabExtendedData.mockResolvedValue(undefined);
  });

  it('keeps Memes that are not recorded in TDH out of rank calculations', async () => {
    const ownersById = new Map<number, Owner[]>([
      [1, [owner(1, '0x111', 50), owner(1, '0x222', 50)]],
      [2, [owner(2, '0x333', 1), owner(2, '0x444', 1), owner(2, '0x555', 1)]],
      [3, [owner(3, '0x666', 200)]]
    ]);
    mockOwners(ownersById);
    mockedFetchNftsForContract.mockResolvedValue([
      memeNft(1),
      memeNft(2),
      memeNft(3)
    ]);
    mockedFetchNftIdsRecordedInTdh.mockResolvedValue(new Set([1, 3]));

    await findMemesExtendedData();

    expect(mockedFetchNftIdsRecordedInTdh).toHaveBeenCalledTimes(1);
    expect(mockedFetchNftIdsRecordedInTdh).toHaveBeenCalledWith(
      '0x33FD426905F149f8376e227d0C9D3340AaD17aF1',
      [1, 2, 3]
    );
    expect(mockedPersistMemesExtendedData).toHaveBeenCalledTimes(1);
    const saved = keyedById(
      mockedPersistMemesExtendedData.mock.calls[0][0] as MemesExtendedData[]
    );

    expect(saved[1].recorded_in_tdh).toBe(true);
    expect(saved[1].edition_size_rank).toBe(1);
    expect(saved[1].hodlers_rank).toBe(1);
    expect(saved[1].ranked_collection_size).toBe(2);

    expect(saved[2].recorded_in_tdh).toBe(false);
    expect(saved[2].edition_size_rank).toBe(-1);
    expect(saved[2].hodlers_rank).toBe(-1);
    expect(saved[2].ranked_collection_size).toBeNull();

    expect(saved[3].recorded_in_tdh).toBe(true);
    expect(saved[3].edition_size_rank).toBe(2);
    expect(saved[3].hodlers_rank).toBe(2);
    expect(saved[3].ranked_collection_size).toBe(2);
  });

  it('keeps legacy Meme ranking when TDH recorded rows are empty', async () => {
    const ownersById = new Map<number, Owner[]>([
      [1, [owner(1, '0x111', 100)]],
      [2, [owner(2, '0x222', 10)]]
    ]);
    mockOwners(ownersById);
    mockedFetchNftsForContract.mockResolvedValue([memeNft(1), memeNft(2)]);
    mockedFetchNftIdsRecordedInTdh.mockResolvedValue(new Set());

    await findMemesExtendedData();

    const saved = keyedById(
      mockedPersistMemesExtendedData.mock.calls[0][0] as MemesExtendedData[]
    );

    expect(saved[1].recorded_in_tdh).toBeNull();
    expect(saved[1].edition_size_rank).toBe(2);
    expect(saved[1].ranked_collection_size).toBeNull();
    expect(saved[2].recorded_in_tdh).toBeNull();
    expect(saved[2].edition_size_rank).toBe(1);
    expect(saved[2].ranked_collection_size).toBeNull();
  });

  it('keeps legacy Meme ranking when TDH recorded lookup fails', async () => {
    const ownersById = new Map<number, Owner[]>([
      [1, [owner(1, '0x111', 100)]],
      [2, [owner(2, '0x222', 10)]]
    ]);
    mockOwners(ownersById);
    mockedFetchNftsForContract.mockResolvedValue([memeNft(1), memeNft(2)]);
    mockedFetchNftIdsRecordedInTdh.mockRejectedValue(
      new Error('tdh unavailable')
    );

    await findMemesExtendedData();

    const saved = keyedById(
      mockedPersistMemesExtendedData.mock.calls[0][0] as MemesExtendedData[]
    );

    expect(saved[1].recorded_in_tdh).toBeNull();
    expect(saved[1].edition_size_rank).toBe(2);
    expect(saved[1].ranked_collection_size).toBeNull();
    expect(saved[2].recorded_in_tdh).toBeNull();
    expect(saved[2].edition_size_rank).toBe(1);
    expect(saved[2].ranked_collection_size).toBeNull();
  });

  it('uses edition size floor for Meme edition size ranking', async () => {
    const ownersById = new Map<number, Owner[]>([
      [1, [owner(1, '0x111', 100)]],
      [2, [owner(2, '0x222', 200)]]
    ]);
    mockOwners(ownersById);
    mockedFetchNftsForContract.mockResolvedValue([
      memeNft(1, 305),
      memeNft(2, 200)
    ]);
    mockedFetchNftIdsRecordedInTdh.mockResolvedValue(new Set([1, 2]));

    await findMemesExtendedData();

    const saved = keyedById(
      mockedPersistMemesExtendedData.mock.calls[0][0] as MemesExtendedData[]
    );

    expect(saved[1].edition_size).toBe(100);
    expect(saved[1].edition_size_rank).toBe(2);
    expect(saved[2].edition_size).toBe(200);
    expect(saved[2].edition_size_rank).toBe(1);
  });

  it('continues ranking Meme Lab extended data without TDH eligibility', async () => {
    const ownersById = new Map<number, Owner[]>([
      [1, [owner(1, '0x111', 100)]],
      [2, [owner(2, '0x222', 10)]]
    ]);
    mockOwners(ownersById);
    mockedFetchAllMemeLabNFTs.mockResolvedValue([labNft(1), labNft(2)]);

    await findMemeLabExtendedData();

    expect(mockedFetchNftIdsRecordedInTdh).not.toHaveBeenCalled();
    expect(mockedPersistLabExtendedData).toHaveBeenCalledTimes(1);
    const saved = keyedById(
      mockedPersistLabExtendedData.mock.calls[0][0] as LabExtendedData[]
    );

    expect(saved[1].edition_size_rank).toBe(2);
    expect(saved[2].edition_size_rank).toBe(1);
    expect(saved[1]).toMatchObject({
      research_holdings: 0,
      edition_size_ex_research: 100,
      edition_size_ex_museum_and_research: 100
    });
  });

  it('calculates research and union-excluded supply without changing cleaned supply', async () => {
    const ownersById = new Map<number, Owner[]>([
      [
        1,
        [
          owner(1, '0xordinary', 5),
          owner(1, NULL_ADDRESS, 2),
          owner(1, SIX529_MUSEUM.toLowerCase(), 3),
          owner(1, RESEARCH_6529_ADDRESS.toUpperCase(), 4)
        ]
      ]
    ]);
    mockOwners(ownersById);
    mockedFetchNftsForContract.mockResolvedValue([memeNft(1)]);
    mockedFetchNftIdsRecordedInTdh.mockResolvedValue(new Set([1]));

    await findMemesExtendedData();

    const saved = keyedById(
      mockedPersistMemesExtendedData.mock.calls[0][0] as MemesExtendedData[]
    );
    expect(saved[1]).toMatchObject({
      edition_size: 14,
      edition_size_not_burnt: 12,
      edition_size_cleaned: 9,
      museum_holdings: 3,
      research_holdings: 4,
      edition_size_ex_research: 8,
      edition_size_ex_museum_and_research: 5
    });
  });

  it('keeps the Meme 8 burn adjustment in all supply calculations', async () => {
    const ownersById = new Map<number, Owner[]>([
      [8, [owner(8, NULL_ADDRESS, 3000), owner(8, '0xordinary', 10)]]
    ]);
    mockOwners(ownersById);
    mockedFetchNftsForContract.mockResolvedValue([memeNft(8)]);
    mockedFetchNftIdsRecordedInTdh.mockResolvedValue(new Set([8]));

    await findMemesExtendedData();

    const saved = keyedById(
      mockedPersistMemesExtendedData.mock.calls[0][0] as MemesExtendedData[]
    );
    expect(saved[8]).toMatchObject({
      edition_size: 3010 + MEME_8_EDITION_BURN_ADJUSTMENT,
      burnt: 3000 + MEME_8_EDITION_BURN_ADJUSTMENT,
      edition_size_not_burnt: 10,
      edition_size_cleaned: 10,
      edition_size_ex_research: 10,
      edition_size_ex_museum_and_research: 10
    });
  });

  it('shares lower-is-better supply and research ranks and leaves non-TDH Memes unranked', async () => {
    const ownersById = new Map<number, Owner[]>([
      [1, [owner(1, '0xone', 5), owner(1, RESEARCH_6529_ADDRESS, 2)]],
      [2, [owner(2, '0xtwo', 5), owner(2, RESEARCH_6529_ADDRESS, 2)]],
      [3, [owner(3, '0xthree', 7), owner(3, RESEARCH_6529_ADDRESS, 4)]],
      [4, [owner(4, '0xfour', 1)]]
    ]);
    mockOwners(ownersById);
    mockedFetchNftsForContract.mockResolvedValue([
      memeNft(1),
      memeNft(2),
      memeNft(3),
      memeNft(4)
    ]);
    mockedFetchNftIdsRecordedInTdh.mockResolvedValue(new Set([1, 2, 3]));

    await findMemesExtendedData();

    const saved = keyedById(
      mockedPersistMemesExtendedData.mock.calls[0][0] as MemesExtendedData[]
    );
    for (const field of [
      'edition_size_rank',
      'edition_size_not_burnt_rank',
      'edition_size_cleaned_rank',
      'edition_size_ex_research_rank',
      'edition_size_ex_museum_and_research_rank',
      'research_holdings_rank'
    ] as const) {
      expect(saved[1][field]).toBe(1);
      expect(saved[2][field]).toBe(1);
      expect(saved[3][field]).toBe(3);
      expect(saved[4][field]).toBe(-1);
    }
  });
});

function mockOwners(ownersById: Map<number, Owner[]>) {
  mockedGetDataSource.mockReturnValue({
    getRepository: jest.fn(() => ({
      find: jest.fn(({ where }: { where: { token_id: number } }) =>
        Promise.resolve(ownersById.get(where.token_id) ?? [])
      )
    }))
  } as any);
}

function keyedById<T extends { id: number }>(rows: T[]): Record<number, T> {
  return rows.reduce<Record<number, T>>((acc, row) => {
    acc[row.id] = row;
    return acc;
  }, {});
}

function memeNft(id: number, editionSizeFloor = 0): NFT {
  return {
    id,
    contract: '0xmemes',
    edition_size_floor: editionSizeFloor,
    metadata: {
      attributes: [
        { trait_type: 'Type - Season', value: '1' },
        { trait_type: 'Type - Meme', value: String(id) },
        { trait_type: 'Meme Name', value: `Meme ${id}` }
      ]
    }
  } as NFT;
}

function labNft(id: number): LabNFT {
  return {
    id,
    contract: '0xlab',
    name: `Lab ${id}`,
    meme_references: [],
    metadata: {
      attributes: [
        { trait_type: 'COLLECTION', value: 'Meme Lab' },
        { trait_type: 'WEBSITE', value: 'None' }
      ]
    }
  } as unknown as LabNFT;
}

function owner(tokenId: number, wallet: string, balance: number): Owner {
  return {
    contract: '0xcontract',
    token_id: tokenId,
    wallet,
    balance
  };
}
