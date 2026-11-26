import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { MARKET_DEPTH_EVENTS_TABLE, MEMES_CONTRACT } from '@/constants';
import {
  MARKET_DEPTH_MAKER_ACTIVITY_INDEX,
  MARKET_DEPTH_TAKER_ACTIVITY_INDEX,
  MarketDepthEventEntity
} from '@/entities/IMarketDepth';
import { env } from '@/env';
import { describeWithSeed } from '@/tests/_setup/seed';
import { applyMarketDepthWalletActivityIndexes } from './market-depth-wallet-activity-indexes';

const makerIndex = MARKET_DEPTH_MAKER_ACTIVITY_INDEX.name;
const takerIndex = MARKET_DEPTH_TAKER_ACTIVITY_INDEX.name;

describeWithSeed(
  'Market depth wallet activity indexes',
  {
    table: MARKET_DEPTH_EVENTS_TABLE,
    rows: [
      {
        event_id: 'index-test',
        kind: 'item_cancelled',
        source: 'opensea_stream',
        contract: MEMES_CONTRACT.toLowerCase(),
        collection_slug: 'thememes6529',
        observed_at: new Date('2026-09-10T12:00:00.000Z'),
        raw: {}
      }
    ]
  },
  () => {
    const source = new DataSource({
      type: 'mysql',
      host: env.getStringOrThrow('DB_HOST'),
      port: env.getIntOrThrow('DB_PORT'),
      username: env.getStringOrThrow('DB_USER'),
      password: env.getStringOrThrow('DB_PASS'),
      database: env.getStringOrThrow('DB_NAME'),
      entities: [MarketDepthEventEntity],
      synchronize: false
    });
    beforeAll(async () => {
      await source.initialize();
    });
    afterAll(async () => {
      await source.destroy();
    });

    it('creates both indexes and keeps them through full entity sync and retries', async () => {
      await source.query(
        `ALTER TABLE \`${MARKET_DEPTH_EVENTS_TABLE}\` DROP INDEX \`${makerIndex}\`, DROP INDEX \`${takerIndex}\``
      );
      await expect(applyMarketDepthWalletActivityIndexes(source)).resolves.toBe(
        2
      );
      await source.synchronize();
      await expect(applyMarketDepthWalletActivityIndexes(source)).resolves.toBe(
        0
      );
      expect(
        await source.query(
          `SELECT event_id FROM \`${MARKET_DEPTH_EVENTS_TABLE}\``
        )
      ).toEqual([{ event_id: 'index-test' }]);
    });

    it('makes the two matching invisible indexes visible in place', async () => {
      await source.query(
        `ALTER TABLE \`${MARKET_DEPTH_EVENTS_TABLE}\` ALTER INDEX \`${makerIndex}\` INVISIBLE, ALTER INDEX \`${takerIndex}\` INVISIBLE`
      );
      await expect(applyMarketDepthWalletActivityIndexes(source)).resolves.toBe(
        2
      );
      await expect(applyMarketDepthWalletActivityIndexes(source)).resolves.toBe(
        0
      );
    });

    it('creates a missing index and adopts its invisible peer in the same migration', async () => {
      await source.query(
        `ALTER TABLE \`${MARKET_DEPTH_EVENTS_TABLE}\` ALTER INDEX \`${makerIndex}\` INVISIBLE, DROP INDEX \`${takerIndex}\``
      );
      await expect(applyMarketDepthWalletActivityIndexes(source)).resolves.toBe(
        2
      );
      await expect(applyMarketDepthWalletActivityIndexes(source)).resolves.toBe(
        0
      );
    });

    it('rejects a conflicting index definition before changing its invisible peer', async () => {
      await source.query(
        `ALTER TABLE \`${MARKET_DEPTH_EVENTS_TABLE}\` ALTER INDEX \`${makerIndex}\` INVISIBLE,
         DROP INDEX \`${takerIndex}\`, ADD INDEX \`${takerIndex}\` (taker)`
      );
      try {
        await expect(
          applyMarketDepthWalletActivityIndexes(source)
        ).rejects.toThrow(`${takerIndex} is incompatible`);
        expect(
          await source.query(
            `SELECT DISTINCT is_visible AS visibility FROM information_schema.statistics
             WHERE table_schema=DATABASE() AND table_name=? AND index_name=?`,
            [MARKET_DEPTH_EVENTS_TABLE, makerIndex]
          )
        ).toEqual([{ visibility: 'NO' }]);
      } finally {
        await source.query(
          `ALTER TABLE \`${MARKET_DEPTH_EVENTS_TABLE}\` DROP INDEX \`${takerIndex}\``
        );
        await expect(
          applyMarketDepthWalletActivityIndexes(source)
        ).resolves.toBe(2);
      }
    });
  }
);
