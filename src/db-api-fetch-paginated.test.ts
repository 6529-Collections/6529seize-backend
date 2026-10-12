import 'reflect-metadata';
import fc from 'fast-check';
import { fetchMemelabLite, fetchMemesLite, fetchPaginated } from '@/db-api';
import { ALL_ROWS_PAGE_SIZE, MAX_PAGE } from '@/api/page-request';
import { setSqlExecutor, SqlExecutor } from '@/sql-executor';

jest.mock('@/redis', () => ({
  redisCompareAndSetJson: jest.fn(),
  redisGet: jest.fn()
}));

const DEFAULT_COUNT = 120;

const executeMock = jest.fn();

function useExecutor(count = DEFAULT_COUNT) {
  executeMock.mockReset();
  executeMock.mockImplementation(async (sql: string) =>
    sql.includes('COUNT(1)') ? [{ count }] : []
  );
  setSqlExecutor({ execute: executeMock } as unknown as SqlExecutor);
}

function dataSql(): string {
  const call = executeMock.mock.calls.find(
    ([sql]) => !String(sql).includes('COUNT(1)')
  );
  if (!call) {
    throw new Error('data query was not executed');
  }
  return call[0];
}

async function run(pageSize: unknown, page: unknown, count = DEFAULT_COUNT) {
  useExecutor(count);
  const result = await fetchPaginated(
    'things',
    {},
    'id asc',
    pageSize as number,
    page as number,
    ''
  );
  return { result, sql: dataSql() };
}

describe('fetchPaginated pagination inputs', () => {
  it('applies LIMIT and OFFSET for valid inputs', async () => {
    const { result, sql } = await run(10, 3);

    expect(sql).toMatch(/order by id asc LIMIT 10 OFFSET 20$/);
    expect(result.page).toBe(3);
    expect(result.count).toBe(DEFAULT_COUNT);
    expect(result.next).toBe('true');
  });

  it('omits OFFSET on the first page and reports no next page when exhausted', async () => {
    const { result, sql } = await run(200, 1);

    expect(sql).toMatch(/order by id asc LIMIT 200$/);
    expect(sql).not.toContain('OFFSET');
    expect(result.next).toBeNull();
  });

  it.each([0, -1, -50, Number.MIN_SAFE_INTEGER, '0', '-5'])(
    'never emits an unbounded query for page size %p',
    async (pageSize) => {
      const { result, sql } = await run(pageSize, 1);

      expect(sql).toMatch(/order by id asc LIMIT 1$/);
      expect(result.next).toBe('true');
    }
  );

  it.each([
    NaN,
    Infinity,
    undefined,
    null,
    '',
    'abc',
    '1.5',
    '5; DROP TABLE x'
  ])(
    'falls back to the default page size for invalid value %p',
    async (pageSize) => {
      const { sql } = await run(pageSize, 1);

      expect(sql).toMatch(/order by id asc LIMIT 50$/);
    }
  );

  it.each([0, -1, -100, NaN, undefined, 'abc', '-3'])(
    'never emits a negative or invalid OFFSET for page %p',
    async (page) => {
      const { result, sql } = await run(10, page);

      expect(sql).toMatch(/order by id asc LIMIT 10$/);
      expect(sql).not.toContain('OFFSET');
      expect(result.page).toBe(1);
    }
  );

  it.each([
    ['fetchMemesLite', fetchMemesLite],
    ['fetchMemelabLite', fetchMemelabLite]
  ])(
    '%s still returns every row in a single page',
    async (_name, fetchLite) => {
      useExecutor(3);

      const result = await fetchLite('asc');

      expect(dataSql()).toMatch(
        new RegExp(`order by id asc LIMIT ${ALL_ROWS_PAGE_SIZE}$`)
      );
      expect(result.page).toBe(1);
      expect(result.next).toBeNull();
    }
  );

  it('stops advertising a next page at the page ceiling', async () => {
    const beforeCeiling = await run(1, MAX_PAGE - 1, MAX_PAGE * 2);
    const atCeiling = await run(1, MAX_PAGE, MAX_PAGE * 2);
    const beyondCeiling = await run(1, MAX_PAGE + 5, MAX_PAGE * 2);

    expect(beforeCeiling.result.next).toBe('true');
    expect(atCeiling.result.next).toBeNull();
    expect(atCeiling.result.page).toBe(MAX_PAGE);
    expect(beyondCeiling.result.next).toBeNull();
    expect(beyondCeiling.result.page).toBe(MAX_PAGE);
  });

  it('does not let a negative page size produce a negative OFFSET', async () => {
    const { sql } = await run(-10, 4);

    expect(sql).toMatch(/LIMIT 1 OFFSET 3$/);
  });

  it('accepts numeric strings from raw query parameters', async () => {
    const { result, sql } = await run('5', '2');

    expect(sql).toMatch(/LIMIT 5 OFFSET 5$/);
    expect(result.page).toBe(2);
  });

  it('keeps very large explicit page sizes (full exports) working', async () => {
    const { result, sql } = await run(Number.MAX_SAFE_INTEGER, 1);

    expect(sql).toMatch(
      new RegExp(`order by id asc LIMIT ${Number.MAX_SAFE_INTEGER}$`)
    );
    expect(result.next).toBeNull();
  });

  it('never renders exponent notation for extreme page and size combinations', async () => {
    const { sql } = await run(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);

    expect(sql).toMatch(/LIMIT \d+ OFFSET \d+$/);
    expect(sql).not.toMatch(/e\+/i);
  });

  it('always emits a bounded LIMIT and a non-negative integer OFFSET', async () => {
    useExecutor();
    const untrusted = fc.oneof(
      fc.integer(),
      fc.double(),
      fc.string(),
      fc.integer().map(String),
      fc.constantFrom(undefined, null)
    );

    await fc.assert(
      fc.asyncProperty(untrusted, untrusted, async (pageSize, page) => {
        executeMock.mockClear();
        await fetchPaginated(
          'things',
          {},
          'id asc',
          pageSize as number,
          page as number,
          ''
        );
        const sql = dataSql();
        const match = / LIMIT (\d+)(?: OFFSET (\d+))?$/.exec(sql);

        expect(match).not.toBeNull();
        expect(Number(match![1])).toBeGreaterThanOrEqual(1);
        expect(Number.isSafeInteger(Number(match![1]))).toBe(true);
        if (match![2] !== undefined) {
          expect(Number.isSafeInteger(Number(match![2]))).toBe(true);
        }
      }),
      { numRuns: 50 }
    );
  });
});
