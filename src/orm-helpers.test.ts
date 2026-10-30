import { Repository } from 'typeorm';
import * as fc from 'fast-check';
import { deleteConsolidations } from '@/orm_helpers';

function mockRepository(keys: string[]) {
  const query = {
    select: jest.fn().mockReturnThis(),
    distinct: jest.fn().mockReturnThis(),
    getRawMany: jest
      .fn()
      .mockResolvedValue(
        keys.map((consolidation_key) => ({ consolidation_key }))
      ),
    delete: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    execute: jest.fn().mockResolvedValue({ affected: 1 })
  };
  const createQueryBuilder = jest.fn(() => query);
  const repository = { createQueryBuilder } as unknown as Repository<{
    consolidation_key: string;
  }>;
  return { repository, query, createQueryBuilder };
}

it('skips every query when no wallets changed', async () => {
  const { repository, createQueryBuilder } = mockRepository(['a-b']);
  expect(await deleteConsolidations(repository, new Set())).toBe(0);
  expect(createQueryBuilder).not.toHaveBeenCalled();
});

it('reads distinct persisted keys without a wallet predicate and deletes only full members', async () => {
  const { repository, query } = mockRepository([
    'aa-bb',
    'bb-cc',
    'aaa',
    'aa',
    'CC-dd'
  ]);
  expect(await deleteConsolidations(repository, new Set(['AA', 'cc']))).toBe(1);
  expect(query.distinct).toHaveBeenCalledWith(true);
  expect(query.where).toHaveBeenCalledTimes(1);
  expect(query.where).toHaveBeenCalledWith('consolidation_key IN (:...keys)', {
    keys: ['aa-bb', 'bb-cc', 'aa', 'CC-dd']
  });
});

it('does not interpret wildcard or SQL input as a matching expression', async () => {
  const { repository, query } = mockRepository(['a-b', 'c']);
  expect(
    await deleteConsolidations(repository, new Set(['%', "' OR 1=1 --"]))
  ).toBe(0);
  expect(query.delete).not.toHaveBeenCalled();
});

it('bounds deletes and sums affected rows across batches', async () => {
  const keys = Array.from({ length: 1201 }, (_, i) => `wallet${i}`);
  const { repository, query } = mockRepository(keys);
  query.execute
    .mockResolvedValueOnce({ affected: 1000 })
    .mockResolvedValueOnce({ affected: 750 })
    .mockResolvedValueOnce({ affected: 2 });
  expect(await deleteConsolidations(repository, new Set(keys))).toBe(1752);
  expect(query.where.mock.calls.map((call) => call[1].keys.length)).toEqual([
    500, 500, 201
  ]);
});

it('propagates a failed delete so the caller transaction rolls back', async () => {
  const { repository, query } = mockRepository(['a-b']);
  query.execute.mockRejectedValueOnce(new Error('delete failed'));
  await expect(
    deleteConsolidations(repository, new Set(['b']))
  ).rejects.toThrow('delete failed');
});

it('matches the former substring lookup for complete Ethereum wallet addresses', async () => {
  const wallet = fc
    .hexaString({ minLength: 40, maxLength: 40 })
    .map((hex) => `0x${hex}`);
  await fc.assert(
    fc.asyncProperty(
      fc.uniqueArray(wallet, { minLength: 2, maxLength: 20 }),
      async (wallets) => {
        const keys = wallets.map((_, i) => wallets.slice(i, i + 4).join('-'));
        const changed = wallets.filter((_, i) => i % 2 === 0);
        const expected = keys.filter((key) =>
          changed.some((address) => key.includes(address))
        );
        const { repository, query } = mockRepository(keys);
        await deleteConsolidations(
          repository,
          new Set(changed.map((address) => address.toUpperCase()))
        );
        expect(query.where.mock.calls.flatMap((call) => call[1].keys)).toEqual(
          expected
        );
      }
    )
  );
});
