import 'reflect-metadata';
import fc from 'fast-check';
import { fetchAggregatedActivity } from './api.aggregated-activity.db';
import { AggregatedActivityQuerySchema } from './api.aggregated-activity.routes';
import { MetricsCollector, MetricsContent } from '@/api/tdh/api.tdh.db';
import { getValidatedByJoiOrThrow } from '@/api/validation';
import { BadRequestException } from '@/exceptions';
import { setSqlExecutor, SqlExecutor } from '@/sql-executor';
import { DEFAULT_PAGE_SIZE } from '@/api/page-request';

jest.mock('@/redis', () => ({
  redisCompareAndSetJson: jest.fn(),
  redisGet: jest.fn()
}));

const executeMock = jest.fn();

beforeEach(() => {
  executeMock.mockReset();
  executeMock.mockImplementation(async (sql: string) =>
    sql.includes('COUNT(1)') ? [{ count: 0 }] : []
  );
  setSqlExecutor({ execute: executeMock } as unknown as SqlExecutor);
});

describe('fetchAggregatedActivity season', () => {
  it('binds the season as a parameter in both season joins', async () => {
    await fetchAggregatedActivity('sales_count', 'desc', 1, 10, {
      search: undefined,
      content: MetricsContent.MEMES,
      collector: MetricsCollector.MEMES,
      season: 7
    });

    expect(executeMock).toHaveBeenCalledTimes(2);
    for (const [sql, params] of executeMock.mock.calls) {
      const joins = String(sql).match(/\.season = \S+/g);
      expect(joins).toEqual(['.season = :season', '.season = :season']);
      expect(params).toMatchObject({ season: 7 });
    }
  });

  it('adds no season parameter without a season', async () => {
    await fetchAggregatedActivity('sales_count', 'desc', 1, 10, {
      search: undefined,
      content: MetricsContent.MEMES,
      collector: MetricsCollector.MEMES,
      season: undefined
    });

    for (const [sql, params] of executeMock.mock.calls) {
      expect(String(sql)).not.toContain('season');
      expect(params).not.toHaveProperty('season');
    }
  });
});

describe('aggregated activity query validation', () => {
  function validate(query: Record<string, unknown>) {
    return getValidatedByJoiOrThrow(query, AggregatedActivityQuerySchema);
  }

  it('keeps the defaults and parses numeric values', () => {
    expect(validate({})).toEqual({ page: 1, page_size: DEFAULT_PAGE_SIZE });
    expect(
      validate({
        page: '2',
        page_size: '25',
        season: '3',
        search: 'punk6529,0xabc',
        content: 'memes',
        sort_direction: 'ASC'
      })
    ).toMatchObject({
      page: 2,
      page_size: 25,
      season: 3,
      search: 'punk6529,0xabc',
      content: 'memes'
    });
  });

  it('accepts any positive integer season', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 1_000_000 }), (season) => {
        expect(validate({ season: String(season) }).season).toBe(season);
      })
    );
  });

  it.each([
    { season: '0' },
    { season: '1 OR 1=1' },
    { season: '1.5' },
    { season: ['1', '2'] },
    { page: 'x' },
    { page_size: '-1' },
    { search: ['a', 'b'] },
    { search: { a: 'b' } },
    { content: ['memes', 'gradients'] },
    { sort_direction: ['ASC', 'DESC'] },
    { collector: ['memes', 'gradients'] },
    { sort_direction: { a: 'b' } }
  ])('rejects %p', (query) => {
    expect(() => validate(query)).toThrow(BadRequestException);
  });
});
