import 'reflect-metadata';
import {
  MANIFOLD,
  MEMES_CONTRACT,
  MEMES_MINT_PRICE,
  MEMES_MINT_STATS_TABLE,
  NFTS_TABLE,
  TRANSACTIONS_TABLE
} from '@/constants';
import { connect, disconnect } from '@/db';
import { MemesMintStat } from '@/entities/IMemesMintStat';
import { writeClosedMemesMintStats } from '@/memes-mint-stats/memes-mint-stats.rebuild';
import {
  dbSupplier,
  setSqlExecutor,
  SqlExecutor,
  sqlExecutor
} from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import { Time } from '@/time';

const WALLET = '0x0000000000000000000000000000000000000001';
const OTHER_CONTRACT = '0x0000000000000000000000000000000000000009';
const NOW = Time.fromDate(new Date('2026-01-10T12:00:00Z'));

/** Inserts a row, filling the columns that take no default with zeros. */
async function insertFilled(
  table: string,
  row: Record<string, unknown>
): Promise<void> {
  const columns = await sqlExecutor.execute<{
    name: string;
    nullable: string;
    def: string | null;
    type: string;
    extra: string;
  }>(
    `select column_name as name, is_nullable as nullable,
       column_default as def, data_type as type, extra
     from information_schema.columns
     where table_schema = database() and table_name = :table`,
    { table }
  );
  const full: Record<string, unknown> = { ...row };
  for (const column of columns) {
    if (
      column.name in full ||
      column.nullable !== 'NO' ||
      column.def !== null ||
      /auto_increment|generated/i.test(column.extra)
    ) {
      continue;
    }
    if (/int|double|decimal|float|bit/i.test(column.type)) {
      full[column.name] = 0;
    } else if (/timestamp|datetime|date/i.test(column.type)) {
      full[column.name] = new Date('2026-01-01T00:00:00Z');
    } else if (/json/i.test(column.type)) {
      full[column.name] = '{}';
    } else {
      full[column.name] = '';
    }
  }
  const names = Object.keys(full);
  await sqlExecutor.execute(
    `insert into ${table} (${names.map((name) => `\`${name}\``).join(', ')})
     values (${names.map((name) => `:${name}`).join(', ')})`,
    full
  );
}

async function card(
  id: number,
  mintDate: string | null,
  contract = MEMES_CONTRACT
): Promise<void> {
  await insertFilled(NFTS_TABLE, {
    id,
    contract,
    mint_date: mintDate ? new Date(mintDate) : null
  });
}

async function paidMint(tokenId: number, count: number): Promise<void> {
  await insertFilled(TRANSACTIONS_TABLE, {
    transaction: `0x${String(tokenId).padStart(64, '0')}`,
    block: 100 + tokenId,
    transaction_date: new Date('2026-01-02T18:00:00Z'),
    from_address: MANIFOLD,
    to_address: WALLET,
    contract: MEMES_CONTRACT,
    token_id: tokenId,
    token_count: count,
    value: MEMES_MINT_PRICE * count,
    eth_price_usd: 3000
  });
}

async function statRows(): Promise<Record<string, unknown>[]> {
  return sqlExecutor.execute(
    // The entity stores total_count in mint_count and mint_count in
    // direct_mint_count.
    `select id, mint_date, mint_count as total_count,
       direct_mint_count as mint_count, subscriptions_count, proceeds_eth,
       proceeds_usd, artist_split_eth, artist_split_usd
     from ${MEMES_MINT_STATS_TABLE} order by id`
  );
}

describeWithSeed('memes mint stats rebuild', [], () => {
  // The writer runs in a TypeORM transaction and passes its query runner to
  // the SQL executor, as the NFT loop and the rebuild step run it: the app's
  // executor from connect(), which takes either kind of connection.
  let appExecutor: SqlExecutor;

  beforeAll(async () => {
    await connect([MemesMintStat]);
    appExecutor = dbSupplier();
  });

  afterAll(async () => {
    await disconnect();
  });

  beforeEach(async () => {
    setSqlExecutor(appExecutor);
    // Closed on 3 Jan 17:00 UTC.
    await card(1, '2026-01-02T00:00:00Z');
    await paidMint(1, 2);
    // Closes on 10 Jan 17:00 UTC, after NOW.
    await card(2, '2026-01-09T00:00:00Z');
    await paidMint(2, 1);
    // No mint date yet.
    await card(3, null);
    // Not a Memes card.
    await card(1, '2026-01-02T00:00:00Z', OTHER_CONTRACT);
  });

  it('writes a row for each Memes card whose mint has closed', async () => {
    expect(await writeClosedMemesMintStats(NOW)).toBe(1);
    const rows = await statRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: 1,
      total_count: 2,
      mint_count: 2,
      subscriptions_count: 0
    });
    expect(Number(rows[0].proceeds_eth)).toBeCloseTo(MEMES_MINT_PRICE * 2, 10);
    expect(Number(rows[0].proceeds_usd)).toBeCloseTo(
      MEMES_MINT_PRICE * 2 * 3000,
      2
    );
    expect(new Date(rows[0].mint_date as string).toISOString()).toBe(
      '2026-01-02T00:00:00.000Z'
    );
  });

  it('leaves rows that exist and writes the same rows again from empty', async () => {
    await writeClosedMemesMintStats(NOW);
    const first = await statRows();
    expect(await writeClosedMemesMintStats(NOW)).toBe(0);
    expect(await statRows()).toEqual(first);

    await sqlExecutor.execute(`delete from ${MEMES_MINT_STATS_TABLE}`);
    expect(await writeClosedMemesMintStats(NOW)).toBe(1);
    expect(await statRows()).toEqual(first);
  });

  it('adds a card once its mint closes', async () => {
    await writeClosedMemesMintStats(NOW);
    expect(
      await writeClosedMemesMintStats(
        Time.fromDate(new Date('2026-01-10T17:00:00Z'))
      )
    ).toBe(1);
    expect((await statRows()).map((row) => row.id)).toEqual([1, 2]);
  });
});
