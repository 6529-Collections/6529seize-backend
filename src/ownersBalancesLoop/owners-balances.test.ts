import {
  fetchAllSeasons,
  fetchTransactionAddressesFromBlock,
  fetchWalletConsolidationKeysViewForWallet
} from '../db';
import { NFTOwner } from '../entities/INFTOwner';
import { MemesSeason } from '../entities/ISeason';
import {
  fetchAllNftOwners,
  getMaxNftOwnersBlockReference
} from '../nftOwnersLoop/db.nft_owners';
import {
  fetchAllOwnerBalancesWallets,
  fetchRefreshOutdatedBalances,
  getMaxOwnerBalancesBlockReference,
  persistConsolidatedOwnerBalances,
  persistOwnerBalances
} from './db.owners_balances';
import {
  consolidateOwnerBalances,
  updateOwnerBalances
} from './owners_balances';

jest.mock('../db', () => ({
  fetchAllSeasons: jest.fn(),
  fetchTransactionAddressesFromBlock: jest.fn(),
  fetchWalletConsolidationKeysViewForWallet: jest.fn()
}));

jest.mock('./db.owners_balances', () => ({
  fetchAllOwnerBalancesWallets: jest.fn(),
  fetchRefreshOutdatedBalances: jest.fn(),
  getMaxOwnerBalancesBlockReference: jest.fn(),
  persistConsolidatedOwnerBalances: jest.fn(),
  persistOwnerBalances: jest.fn()
}));

jest.mock('../nftOwnersLoop/db.nft_owners', () => ({
  fetchAllNftOwners: jest.fn(),
  getMaxNftOwnersBlockReference: jest.fn()
}));

const mockedFetchAllSeasons = fetchAllSeasons as jest.MockedFunction<
  typeof fetchAllSeasons
>;
const mockedFetchTransactionAddressesFromBlock =
  fetchTransactionAddressesFromBlock as jest.MockedFunction<
    typeof fetchTransactionAddressesFromBlock
  >;
const mockedFetchWalletConsolidationKeysViewForWallet =
  fetchWalletConsolidationKeysViewForWallet as jest.MockedFunction<
    typeof fetchWalletConsolidationKeysViewForWallet
  >;
const mockedFetchAllNftOwners = fetchAllNftOwners as jest.MockedFunction<
  typeof fetchAllNftOwners
>;
const mockedGetMaxNftOwnersBlockReference =
  getMaxNftOwnersBlockReference as jest.MockedFunction<
    typeof getMaxNftOwnersBlockReference
  >;
const mockedFetchAllOwnerBalancesWallets =
  fetchAllOwnerBalancesWallets as jest.MockedFunction<
    typeof fetchAllOwnerBalancesWallets
  >;
const mockedFetchRefreshOutdatedBalances =
  fetchRefreshOutdatedBalances as jest.MockedFunction<
    typeof fetchRefreshOutdatedBalances
  >;
const mockedGetMaxOwnerBalancesBlockReference =
  getMaxOwnerBalancesBlockReference as jest.MockedFunction<
    typeof getMaxOwnerBalancesBlockReference
  >;
const mockedPersistConsolidatedOwnerBalances =
  persistConsolidatedOwnerBalances as jest.MockedFunction<
    typeof persistConsolidatedOwnerBalances
  >;
const mockedPersistOwnerBalances = persistOwnerBalances as jest.MockedFunction<
  typeof persistOwnerBalances
>;

const MEMES = '0x33FD426905F149f8376e227d0C9D3340AaD17aF1';

function season(id: number, startIndex: number, endIndex: number): MemesSeason {
  return {
    id,
    start_index: startIndex,
    end_index: endIndex,
    count: endIndex - startIndex + 1,
    name: `SZN${id}`,
    display: `SZN${id}`
  } as MemesSeason;
}

function owner(wallet: string, tokenId: number, balance: number): NFTOwner {
  return {
    wallet,
    contract: MEMES.toLowerCase(),
    token_id: tokenId,
    balance,
    block_reference: 200
  } as NFTOwner;
}

// DB collation is case-insensitive: mimic wallet IN (...) matching accordingly
function ownersForWallets(fixture: NFTOwner[], pk?: string[]): NFTOwner[] {
  if (!pk) {
    return fixture;
  }
  const lowered = pk.map((p) => p.toLowerCase());
  return fixture.filter((o) => lowered.includes(o.wallet.toLowerCase()));
}

describe('updateOwnerBalances (incremental)', () => {
  // wallet case in nft_owners intentionally differs from the transaction
  // addresses to prove case-insensitive matching survived the Map rewrite
  const fixture: NFTOwner[] = [
    owner('0xAliceAA', 1, 2),
    owner('0xaliceaa', 2, 3),
    owner('0xBobBB', 1, 1)
  ];

  beforeEach(() => {
    jest.clearAllMocks();
    mockedGetMaxOwnerBalancesBlockReference.mockResolvedValue(100);
    mockedGetMaxNftOwnersBlockReference.mockResolvedValue(200);
    mockedFetchAllSeasons.mockResolvedValue([season(1, 1, 2)]);
    mockedFetchRefreshOutdatedBalances.mockResolvedValue([]);
    mockedFetchTransactionAddressesFromBlock.mockResolvedValue([
      { from_address: '0xALICEaa', to_address: '0xbobbb' },
      { from_address: '0xGoneCC', to_address: '0xALICEaa' }
    ]);
    mockedFetchAllNftOwners.mockImplementation(async (_contracts, pk) =>
      ownersForWallets(fixture, pk)
    );
    mockedFetchWalletConsolidationKeysViewForWallet.mockImplementation(
      async (addresses) =>
        addresses
          .filter((a) => ['0xaliceaa', '0xbobbb'].includes(a.toLowerCase()))
          .map(
            (a) =>
              ({
                address: a.toLowerCase(),
                consolidation_key: '0xaliceaa-0xbobbb'
              }) as any
          )
    );
    mockedPersistOwnerBalances.mockResolvedValue(undefined);
    mockedPersistConsolidatedOwnerBalances.mockResolvedValue(undefined);
  });

  it('aggregates the same owned NFTs per address as the previous per-address filter', async () => {
    await updateOwnerBalances(false);

    expect(mockedPersistOwnerBalances).toHaveBeenCalledTimes(1);
    const [ownersBalances, ownersBalancesMemes, deleteDelta] =
      mockedPersistOwnerBalances.mock.calls[0];

    const byWallet = new Map(ownersBalances.map((b: any) => [b.wallet, b]));
    expect(byWallet.size).toBe(2);

    const alice = byWallet.get('0xaliceaa') as any;
    expect(alice.total_balance).toBe(5);
    expect(alice.memes_balance).toBe(5);
    expect(alice.unique_memes).toBe(2);
    expect(alice.memes_cards_sets).toBe(2);

    const bob = byWallet.get('0xbobbb') as any;
    expect(bob.total_balance).toBe(1);
    expect(bob.unique_memes).toBe(1);
    expect(bob.memes_cards_sets).toBe(0);

    expect(deleteDelta).toEqual(new Set(['0xgonecc']));

    const seasonRows = ownersBalancesMemes.filter(
      (m: any) => m.wallet === '0xaliceaa'
    );
    expect(seasonRows).toEqual([
      expect.objectContaining({ season: 1, balance: 5, unique: 2, sets: 2 })
    ]);
  });

  it('resolves consolidation keys through one batched view query with identical fallback semantics', async () => {
    await updateOwnerBalances(false);

    expect(
      mockedFetchWalletConsolidationKeysViewForWallet
    ).toHaveBeenCalledTimes(1);
    const queried =
      mockedFetchWalletConsolidationKeysViewForWallet.mock.calls[0][0];
    expect([...queried].sort((a, b) => a.localeCompare(b))).toEqual([
      '0xaliceaa',
      '0xbobbb',
      '0xgonecc'
    ]);

    const [consolidatedBalances] =
      mockedPersistConsolidatedOwnerBalances.mock.calls[0];
    const keys = consolidatedBalances
      .map((b: any) => b.consolidation_key)
      .sort((a: string, b: string) => a.localeCompare(b));
    // consolidated wallets resolve through the view; unknown wallet falls back
    // to itself, exactly like the old per-address [0]-or-fallback logic
    expect(keys).toEqual(['0xaliceaa-0xbobbb', '0xgonecc']);
  });
});

describe('consolidateOwnerBalances chunking', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedFetchAllSeasons.mockResolvedValue([season(1, 1, 2)]);
    mockedFetchAllNftOwners.mockResolvedValue([]);
    mockedFetchWalletConsolidationKeysViewForWallet.mockResolvedValue([]);
    mockedPersistConsolidatedOwnerBalances.mockResolvedValue(undefined);
    mockedFetchAllOwnerBalancesWallets.mockResolvedValue([]);
  });

  it('splits the consolidation key lookup into 5000-address chunks', async () => {
    const addresses = new Set<string>();
    for (let i = 0; i < 5001; i++) {
      addresses.add(`0xwallet${i}`);
    }

    await consolidateOwnerBalances(addresses, false);

    expect(
      mockedFetchWalletConsolidationKeysViewForWallet
    ).toHaveBeenCalledTimes(2);
    expect(
      mockedFetchWalletConsolidationKeysViewForWallet.mock.calls[0][0]
    ).toHaveLength(5000);
    expect(
      mockedFetchWalletConsolidationKeysViewForWallet.mock.calls[1][0]
    ).toHaveLength(1);
  });
});
