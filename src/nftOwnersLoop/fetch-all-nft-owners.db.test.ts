import 'reflect-metadata';
import { connect, disconnect, getDataSource } from '@/db';
import { NFTOwner } from '@/entities/INFTOwner';
import { fetchAllNftOwners } from './db.nft_owners';

const MEMES = '0xmemescontract';
const OTHER = '0xothercontract';

function owner(
  wallet: string,
  contract: string,
  tokenId: number,
  balance: number
): NFTOwner {
  const o = new NFTOwner();
  o.wallet = wallet;
  o.contract = contract;
  o.token_id = tokenId;
  o.balance = balance;
  o.block_reference = 100;
  return o;
}

function rowKey(o: NFTOwner): string {
  return `${o.wallet.toLowerCase()}|${o.contract.toLowerCase()}|${Number(
    o.token_id
  )}|${o.balance}`;
}

function sortedKeys(owners: NFTOwner[]): string[] {
  return owners.map(rowKey).sort((a, b) => a.localeCompare(b));
}

describe('fetchAllNftOwners', () => {
  beforeAll(async () => {
    // the nft_owners table is entity-synced (no migration creates it), so let
    // TypeORM create it in this worker's test database
    await connect([NFTOwner], true);
  });

  afterAll(async () => {
    await disconnect();
  });

  beforeEach(async () => {
    const repo = getDataSource().getRepository(NFTOwner);
    await repo.clear();
    await repo.insert([
      owner('0xalice', MEMES, 1, 2),
      owner('0xalice', OTHER, 1, 5),
      owner('0xbob', MEMES, 2, 1),
      owner('0xbob', OTHER, 3, 4),
      owner('0xcarol', MEMES, 1, 7)
    ]);
  });

  it('returns everything when no filters are given', async () => {
    const result = await fetchAllNftOwners();
    expect(result).toHaveLength(5);
  });

  it('filters by contract only', async () => {
    const result = await fetchAllNftOwners([MEMES]);
    expect(sortedKeys(result)).toEqual([
      `0xalice|${MEMES}|1|2`,
      `0xbob|${MEMES}|2|1`,
      `0xcarol|${MEMES}|1|7`
    ]);
  });

  it('filters by wallet only', async () => {
    const result = await fetchAllNftOwners(undefined, ['0xalice']);
    expect(sortedKeys(result)).toEqual([
      `0xalice|${MEMES}|1|2`,
      `0xalice|${OTHER}|1|5`
    ]);
  });

  it('applies BOTH filters when contracts and wallets are given (regression: the contract filter used to be silently dropped)', async () => {
    const result = await fetchAllNftOwners([MEMES], ['0xalice', '0xbob']);

    // pre-fix behavior returned 0xalice/0xbob rows of ALL contracts (4 rows,
    // including the two OTHER-contract rows); the intersection is 2 rows
    expect(sortedKeys(result)).toEqual([
      `0xalice|${MEMES}|1|2`,
      `0xbob|${MEMES}|2|1`
    ]);
  });
});
