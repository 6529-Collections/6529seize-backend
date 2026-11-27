import {
  SUBSCRIPTIONS_ID_NFTS_FINAL_TABLE,
  SUBSCRIPTIONS_NFTS_FINAL_TABLE
} from '@/constants';
import { MetricsDb } from '@/metrics/MetricsDb';
import { CommunityMetricsService } from './community-metrics.service';

describe('CommunityMetricsService.getCommunityMintMetrics', () => {
  const query = {
    page: 1,
    page_size: 10,
    sort_direction: 'DESC' as const,
    sort: 'mint_time' as const
  };

  it.each([
    [
      'before the subscriptions switch',
      SUBSCRIPTIONS_NFTS_FINAL_TABLE,
      SUBSCRIPTIONS_ID_NFTS_FINAL_TABLE
    ],
    [
      'after the subscriptions switch',
      SUBSCRIPTIONS_ID_NFTS_FINAL_TABLE,
      SUBSCRIPTIONS_NFTS_FINAL_TABLE
    ]
  ])(
    'counts redemptions from the final table the switch names, %s',
    async (_, finalTable, otherTable) => {
      const execute = jest.fn().mockResolvedValue([
        {
          token_id: 1,
          mint_date: 0,
          minted: 3,
          subscriptions: 2,
          edition_size: 10,
          unminted: 0
        }
      ]);
      const oneOrNull = jest.fn().mockResolvedValue({ total: 1 });
      const service = new CommunityMetricsService(
        new MetricsDb(() => ({ execute, oneOrNull }) as any),
        async () => finalTable
      );

      const page = await service.getCommunityMintMetrics(query, {});

      expect(page.data).toEqual([
        expect.objectContaining({ card: 1, subscriptions: 2 })
      ]);
      const sql: string = execute.mock.calls[0][0];
      expect(sql).toContain(`from ${finalTable}`);
      expect(sql).not.toContain(otherTable);
    }
  );
});
