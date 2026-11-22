import 'reflect-metadata';
import { MEMES_CONTRACT, NULL_ADDRESS, TRANSACTIONS_TABLE } from '@/constants';
import { findVolumesForContract } from '@/db';
import { sqlExecutor } from '@/sql-executor';

const BUYER = `0x${'1'.padStart(40, '0')}`;

/** A sale of card `tokenId` for `value` ETH, `daysAgo` days ago by block time. */
async function sale(
  n: number,
  tokenId: number,
  value: number,
  daysAgo: number
) {
  await sqlExecutor.execute(
    `INSERT INTO ${TRANSACTIONS_TABLE} (created_at, transaction, block,
       transaction_date, from_address, to_address, contract, token_id,
       token_count, value, primary_proceeds, royalties, gas_gwei, gas_price,
       gas_price_gwei, gas)
     VALUES (NOW(), :hash, :block, DATE_SUB(NOW(), INTERVAL :daysAgo DAY),
       :from, :to, :contract, :tokenId, 1, :value, 0, 0, 0, 0, 0, 0)`,
    {
      hash: `0x${n.toString(16).padStart(64, '0')}`,
      block: 100 + n,
      daysAgo,
      from: NULL_ADDRESS,
      to: BUYER,
      contract: MEMES_CONTRACT,
      tokenId,
      value
    }
  );
}

describe('NFT volume windows', () => {
  const env = process.env;

  beforeEach(async () => {
    process.env = { ...env };
    await sqlExecutor.execute(`DELETE FROM ${TRANSACTIONS_TABLE}`);
    // Every row was written just now, as after a rebuild of the index.
    await sale(1, 1, 1, 0);
    await sale(2, 1, 2, 3);
    await sale(3, 1, 4, 20);
    await sale(4, 1, 8, 60);
  });

  afterEach(async () => {
    await sqlExecutor.execute(`DELETE FROM ${TRANSACTIONS_TABLE}`);
  });

  afterAll(() => {
    process.env = env;
  });

  it('counts by block time with the rebuild fixes on', async () => {
    process.env.FEATURE_ETH_INDEX_REBUILD_FIXES = 'true';
    const volumes = await findVolumesForContract(MEMES_CONTRACT);
    expect(volumes.get(1)).toEqual({
      total_volume_last_24_hours: 1,
      total_volume_last_7_days: 3,
      total_volume_last_1_month: 7,
      total_volume: 15
    });
  });

  it('counts by when the row was written by default', async () => {
    delete process.env.FEATURE_ETH_INDEX_REBUILD_FIXES;
    const volumes = await findVolumesForContract(MEMES_CONTRACT);
    expect(volumes.get(1)).toEqual({
      total_volume_last_24_hours: 15,
      total_volume_last_7_days: 15,
      total_volume_last_1_month: 15,
      total_volume: 15
    });
  });
});
