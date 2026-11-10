import 'reflect-metadata';
import fc from 'fast-check';
import { fetchRememes } from '@/db-api';
import { setSqlExecutor, SqlExecutor } from '@/sql-executor';

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

async function run(memeIds: string) {
  await fetchRememes(memeIds, 10, 1, '', '', '', '', '');
  const [sql, params] = executeMock.mock.calls.find(
    ([statement]) => !String(statement).includes('COUNT(1)')
  )!;
  return { sql: String(sql), params: params as Record<string, unknown> };
}

describe('fetchRememes meme id filters', () => {
  it('names placeholders by position and binds each id as a value', async () => {
    const { sql, params } = await run('12,7');

    expect(sql).toContain('meme_references, :nft_id0');
    expect(sql).toContain('meme_references, :nft_id1');
    expect(params).toMatchObject({ nft_id0: '12', nft_id1: '7' });
  });

  it('uses positional parameter names whatever the ids contain', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc
            .string({ minLength: 1 })
            .filter((s) => !s.includes(',') && s.length > 3),
          { minLength: 1, maxLength: 5 }
        ),
        async (pieces) => {
          executeMock.mockClear();
          const { sql, params } = await run(pieces.join(','));
          pieces.forEach((piece, index) => {
            expect(params[`nft_id${index}`]).toBe(piece);
            expect(sql).toContain(`:nft_id${index},'$'`);
          });
          expect(
            Object.keys(params).sort((a, b) => a.localeCompare(b))
          ).toEqual(
            pieces
              .map((_, index) => `nft_id${index}`)
              .sort((a, b) => a.localeCompare(b))
          );
        }
      ),
      { numRuns: 50 }
    );
  });
});
