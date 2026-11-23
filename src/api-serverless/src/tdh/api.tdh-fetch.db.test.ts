import {
  CONSOLIDATED_WALLETS_TDH_TABLE,
  TDH_BLOCKS_TABLE,
  WALLETS_TDH_TABLE
} from '@/constants';
import { describeWithSeed } from '@/tests/_setup/seed';
import {
  consolidatedRows,
  groupsBefore,
  walletRows
} from '@/tests/fixtures/partial-tdh-world.fixture';
import { fetchTDH } from './api.tdh.db';

// Made-up test wallets (0x…01, 0x…02) from the TDH fixture.
const [first, second] = walletRows(groupsBefore(2));
const WALLET = first.wallet;
const OTHER_WALLET = second.wallet;
const DAY_1 = 24_000_100;
const DAY_2 = 24_007_300;

const walletOnDay = (row: typeof first, block: number, tdh: number) => ({
  ...row,
  block,
  date: new Date(
    block === DAY_1 ? '2026-11-20T00:00:00Z' : '2026-11-21T00:00:00Z'
  ),
  tdh,
  boosted_tdh: tdh * 1.1
});

const [consolidated] = consolidatedRows(groupsBefore(1));

describeWithSeed(
  'fetchTDH',
  [
    {
      table: TDH_BLOCKS_TABLE,
      rows: [
        { block_number: DAY_1, timestamp: new Date('2026-11-20T00:00:00Z') },
        { block_number: DAY_2, timestamp: new Date('2026-11-21T00:00:00Z') }
      ]
    },
    {
      table: WALLETS_TDH_TABLE,
      rows: [
        // Each daily write keeps the earlier day's rows.
        walletOnDay(first, DAY_1, 100),
        walletOnDay(first, DAY_2, 250),
        // Missing from the newest day's run.
        walletOnDay(second, DAY_1, 40)
      ]
    },
    {
      table: CONSOLIDATED_WALLETS_TDH_TABLE,
      rows: [{ ...consolidated, block: DAY_2 }]
    }
  ],
  () => {
    it("reads a wallet's row at the newest TDH block when it has rows for two days", async () => {
      const row = await fetchTDH('wallet', WALLET, WALLETS_TDH_TABLE, {
        atLatestTdhBlock: true
      });
      expect(row).toMatchObject({ wallet: WALLET, block: DAY_2, tdh: 250 });
    });

    it('finds nothing (404) for a wallet with no row at the newest TDH block', async () => {
      expect(
        await fetchTDH('wallet', OTHER_WALLET, WALLETS_TDH_TABLE, {
          atLatestTdhBlock: true
        })
      ).toBeNull();
    });

    it('reads the one consolidated row as before', async () => {
      const row = await fetchTDH(
        'consolidation_key',
        consolidated.consolidation_key,
        CONSOLIDATED_WALLETS_TDH_TABLE
      );
      expect(row).toMatchObject({
        consolidation_key: consolidated.consolidation_key,
        block: DAY_2
      });
    });

    it('keeps its one-row rule for callers that read without the block filter', async () => {
      expect(await fetchTDH('wallet', WALLET, WALLETS_TDH_TABLE)).toBeNull();
    });
  }
);

describeWithSeed(
  'fetchTDH before the first TDH block is recorded',
  [{ table: WALLETS_TDH_TABLE, rows: [walletOnDay(first, DAY_1, 100)] }],
  () => {
    it('finds nothing (404) while tdh_blocks has no rows', async () => {
      expect(
        await fetchTDH('wallet', WALLET, WALLETS_TDH_TABLE, {
          atLatestTdhBlock: true
        })
      ).toBeNull();
    });
  }
);
