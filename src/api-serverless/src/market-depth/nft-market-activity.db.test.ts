import 'reflect-metadata';
import { MARKET_DEPTH_EVENTS_TABLE, MEMES_CONTRACT } from '@/constants';
import { dbSupplier, sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import { resolveEns } from '@/db-api';
import { GetNftMarketActivityQuery } from '@/api/generated/routes/operations';
import { marketDepthApiDb } from './market-depth-api.db';
import { NftMarketActivityService } from './nft-market-activity.service';

jest.mock('@/db-api', () => ({ resolveEns: jest.fn() }));

const contract = MEMES_CONTRACT.toLowerCase();
const wallet = '0x1111111111111111111111111111111111111111';
const otherWallet = '0x2222222222222222222222222222222222222222';
const slugs = ['thememes6529', 'other-memes-partition'];
const at = new Date('2026-09-10T12:00:00.000Z');
const rows = Array.from({ length: 120 }, (_, index) => ({
  event_id: index.toString(16).padStart(64, '0'),
  kind:
    index % 7 === 0
      ? 'item_sold'
      : index % 3 === 0
        ? 'item_listed'
        : 'collection_offer',
  source: 'opensea_stream',
  contract,
  collection_slug: index % 5 === 0 ? 'unrelated' : slugs[index % 2],
  token_id: index % 4 === 0 ? '2' : index % 2 === 0 ? '1' : null,
  provider_at:
    index % 6 === 0
      ? null
      : new Date(at.getTime() + Math.floor(index / 4) * 1000),
  observed_at: new Date(at.getTime() + Math.floor(index / 4) * 1000),
  maker: index % 3 === 0 ? otherWallet : wallet,
  taker: index % 9 === 0 ? wallet : null,
  raw: { private: 'must not be returned' }
}));

describeWithSeed(
  'NFT token activity query equivalence',
  {
    table: MARKET_DEPTH_EVENTS_TABLE,
    rows
  },
  () => {
    beforeEach(() => {
      jest.spyOn(marketDepthApiDb, 'getToken').mockResolvedValue({
        contract,
        token_id: '1',
        collection_id: null
      });
      jest.spyOn(marketDepthApiDb, 'getActivityPartitions').mockResolvedValue(
        slugs.map((collection_slug) => ({
          source: 'opensea',
          collection_slug
        }))
      );
      jest.mocked(resolveEns).mockResolvedValue([wallet]);
    });

    afterEach(() => jest.restoreAllMocks());

    it.each([
      { filter: 'all', page_size: 1 },
      { filter: 'all', page_size: 7 },
      { filter: 'offers', page_size: 2 },
      { filter: 'listings', page_size: 3 },
      { filter: 'all', wallet, page_size: 2 },
      { filter: 'listings', wallet, page_size: 1 }
    ] as GetNftMarketActivityQuery[])(
      'matches the original selection across every page for %j',
      async (query) => {
        const kindPredicate =
          query.filter === 'offers'
            ? "AND LOWER(e.kind) IN ('collection_offer')"
            : query.filter === 'listings'
              ? "AND LOWER(e.kind) IN ('item_listed')"
              : '';
        const expected = await sqlExecutor.execute<{ event_id: string }>(
          `SELECT e.event_id FROM ${MARKET_DEPTH_EVENTS_TABLE} e
         WHERE e.chain_id='1' AND e.contract=:contract
           AND (e.token_id='1' OR (e.token_id IS NULL AND e.collection_slug IN (:slugs)))
           AND LOWER(e.kind) NOT IN ('sale','sold','item_sold','transfer','item_transferred','mint')
           ${kindPredicate}
           ${query.wallet ? 'AND (e.maker=:wallet OR e.taker=:wallet)' : ''}
         ORDER BY e.occurred_at DESC, e.event_id DESC`,
          { contract, slugs, wallet }
        );
        const service = new NftMarketActivityService(dbSupplier);
        const actual: string[] = [];
        let cursor: string | undefined;
        for (let page = 0; page <= expected.length; page++) {
          const result = await service.getActivity({
            ...query,
            contract,
            token_id: '1',
            cursor
          });
          expect(result.data.length).toBeLessThanOrEqual(query.page_size!);
          for (const event of result.data) {
            expect(event).not.toHaveProperty('raw');
            actual.push(event.event_id);
          }
          cursor = result.next ?? undefined;
          if (!cursor) break;
        }
        expect(cursor).toBeUndefined();
        expect(actual).toEqual(expected.map((row) => `m:${row.event_id}`));
        expect(new Set(actual).size).toBe(actual.length);
      }
    );

    it('selects only token events when no collection partition is available', async () => {
      jest.mocked(marketDepthApiDb.getActivityPartitions).mockResolvedValue([]);
      const result = await new NftMarketActivityService(dbSupplier).getActivity(
        {
          contract,
          token_id: '1',
          page_size: 100
        }
      );
      expect(result.data.length).toBeGreaterThan(0);
      expect(result.data.every((event) => event.token_id === '1')).toBe(true);
      expect(result.next).toBeNull();
    });
  }
);
