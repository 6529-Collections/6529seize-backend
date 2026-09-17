import {
  fetchConsolidationGroupsForAddresses,
  fetchTransactionsAfterBlock
} from '@/db';
import { NFTOwner } from '@/entities/INFTOwner';
import {
  fetchAllNftOwners,
  getMaxNftOwnersBlockReference,
  getNftOwnersSyncBlock,
  persistConsolidatedNftOwners,
  persistNftOwners
} from './db.nft_owners';
import { consolidateNftOwners, updateNftOwners } from './nft_owners';
import {
  getActiveMembershipGlobalJobId,
  runMembershipGlobalSourceJob
} from '../membership/membership-producer-writes';

jest.mock('../membership/membership-producer-writes', () => ({
  getActiveMembershipGlobalJobId: jest.fn(),
  runMembershipGlobalSourceJob: jest.fn()
}));

jest.mock('@/db', () => ({
  fetchConsolidationGroupsForAddresses: jest.fn(),
  fetchMaxTransactionsBlockNumber: jest.fn(),
  fetchTransactionsAfterBlock: jest.fn()
}));

jest.mock('./db.nft_owners', () => ({
  fetchAllNftOwners: jest.fn(),
  getMaxNftOwnersBlockReference: jest.fn(),
  getNftOwnersSyncBlock: jest.fn(),
  persistConsolidatedNftOwners: jest.fn(),
  persistNftOwners: jest.fn(),
  setNftOwnersSyncBlock: jest.fn()
}));

const mockedFetchConsolidationGroupsForAddresses =
  fetchConsolidationGroupsForAddresses as jest.MockedFunction<
    typeof fetchConsolidationGroupsForAddresses
  >;
const mockedFetchAllNftOwners = fetchAllNftOwners as jest.MockedFunction<
  typeof fetchAllNftOwners
>;
const mockedPersistConsolidatedNftOwners =
  persistConsolidatedNftOwners as jest.MockedFunction<
    typeof persistConsolidatedNftOwners
  >;
const mockedGetActiveJob =
  getActiveMembershipGlobalJobId as jest.MockedFunction<
    typeof getActiveMembershipGlobalJobId
  >;
const mockedRunJob = runMembershipGlobalSourceJob as jest.MockedFunction<
  typeof runMembershipGlobalSourceJob
>;

const MEMES = '0xmemes';

function owner(wallet: string, tokenId: number, balance: number): NFTOwner {
  return {
    wallet,
    contract: MEMES,
    token_id: tokenId,
    balance,
    block_reference: 1
  } as NFTOwner;
}

describe('consolidateNftOwners', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedPersistConsolidatedNftOwners.mockResolvedValue(undefined);
  });

  it('fetches owners once per unique consolidation and sums member balances', async () => {
    mockedFetchConsolidationGroupsForAddresses.mockResolvedValue(
      new Map([
        ['0xalice-0xbob', ['0xalice', '0xbob']],
        ['0xloner', ['0xloner']]
      ])
    );
    const ownersByWallet: Record<string, NFTOwner[]> = {
      '0xalice': [owner('0xalice', 1, 2)],
      '0xbob': [owner('0xbob', 1, 3), owner('0xbob', 2, 1)],
      '0xloner': []
    };
    mockedFetchAllNftOwners.mockImplementation(async (_contracts, pk) =>
      (pk ?? []).flatMap((p) => ownersByWallet[p.toLowerCase()] ?? [])
    );

    await consolidateNftOwners(new Set(['0xalice', '0xbob', '0xloner']));

    // one owners fetch per unique consolidation, not per member address
    expect(mockedFetchAllNftOwners).toHaveBeenCalledTimes(2);

    const [upsertDelta, deleteDelta] =
      mockedPersistConsolidatedNftOwners.mock.calls[0];
    expect(deleteDelta).toEqual(new Set(['0xalice', '0xbob', '0xloner']));

    const byToken = new Map(
      upsertDelta.map((o: any) => [`${o.consolidation_key}_${o.token_id}`, o])
    );
    expect((byToken.get('0xalice-0xbob_1') as any).balance).toBe(5);
    expect((byToken.get('0xalice-0xbob_2') as any).balance).toBe(1);
    expect(byToken.has('0xloner_1')).toBe(false);
  });

  it('does nothing for an empty address set', async () => {
    await consolidateNftOwners(new Set());
    expect(mockedFetchConsolidationGroupsForAddresses).not.toHaveBeenCalled();
    expect(mockedPersistConsolidatedNftOwners).not.toHaveBeenCalled();
  });
});

describe('updateNftOwners source recovery', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (getMaxNftOwnersBlockReference as jest.Mock).mockResolvedValue(10);
    (getNftOwnersSyncBlock as jest.Mock).mockResolvedValue(10);
    mockedGetActiveJob.mockResolvedValue('nft-owners:10:20');
    mockedRunJob.mockImplementation(async (_jobId, _dims, _reason, write) =>
      write({})
    );
    mockedFetchConsolidationGroupsForAddresses.mockResolvedValue(new Map());
  });

  it('rebuilds a partially committed owner range instead of applying its delta twice', async () => {
    (fetchTransactionsAfterBlock as jest.Mock).mockResolvedValue([
      {
        transaction: '0xmint',
        from_address: '0x0000000000000000000000000000000000000000',
        to_address: '0xalice',
        contract: MEMES,
        token_id: 1,
        token_count: 1
      }
    ]);

    await updateNftOwners();

    expect(fetchTransactionsAfterBlock).toHaveBeenCalledWith(
      expect.any(Array),
      0,
      20
    );
    expect(fetchAllNftOwners).not.toHaveBeenCalled();
    expect(runMembershipGlobalSourceJob).toHaveBeenCalledWith(
      'nft-owners:10:20',
      ['OWNERSHIP'],
      'nft-owners-reconciled',
      expect.any(Function)
    );
    expect(persistNftOwners).toHaveBeenCalledWith(
      new Set(['0xalice']),
      expect.arrayContaining([
        expect.objectContaining({ wallet: '0xalice', balance: 1 })
      ]),
      true
    );
  });

  it('finishes a prior job after its sync marker advanced without replaying owner writes', async () => {
    (getNftOwnersSyncBlock as jest.Mock).mockResolvedValue(20);

    await updateNftOwners();

    expect(fetchTransactionsAfterBlock).not.toHaveBeenCalled();
    expect(runMembershipGlobalSourceJob).toHaveBeenCalledWith(
      'nft-owners:10:20',
      ['OWNERSHIP'],
      'nft-owners-reconciled',
      expect.any(Function)
    );
  });
});
