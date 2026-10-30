import { Repository } from 'typeorm';
import * as fc from 'fast-check';
import { deleteConsolidations } from '@/orm_helpers';

function mockRepository(keys: string[]) {
  // Fixed pages verify query/batch contracts; DB tests cover deleting rows
  // between pages and seeking from a cursor row that no longer exists.
  const page = {
    select: jest.fn().mockReturnThis(),
    addSelect: jest.fn().mockReturnThis(),
    addOrderBy: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    getRawMany: jest.fn().mockResolvedValue([])
  };
  for (let offset = 0; offset < keys.length; offset += 1000) {
    page.getRawMany.mockResolvedValueOnce(
      keys.slice(offset, offset + 1000).map((consolidation_key) => ({
        consolidation_key,
        cursor_0: consolidation_key
      }))
    );
  }
  const query = {
    delete: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    execute: jest.fn().mockResolvedValue({ affected: 1 })
  };
  const createQueryBuilder = jest.fn((alias?: string) =>
    alias ? page : query
  );
  const repository = {
    createQueryBuilder,
    metadata: { primaryColumns: [{ propertyPath: 'consolidation_key' }] }
  } as unknown as Repository<{
    consolidation_key: string;
  }>;
  return { repository, query, page, createQueryBuilder };
}

it('skips every query when no wallets changed', async () => {
  const { repository, createQueryBuilder } = mockRepository(['a-b']);
  expect(await deleteConsolidations(repository, new Set())).toBe(0);
  expect(createQueryBuilder).not.toHaveBeenCalled();
});

it('reads bounded primary-key pages without a wallet predicate and deletes only full members', async () => {
  const { repository, query, page } = mockRepository([
    'aa-bb',
    'bb-cc',
    'aaa',
    'aa',
    'CC-dd'
  ]);
  expect(await deleteConsolidations(repository, new Set(['AA', 'cc']))).toBe(1);
  expect(page.limit).toHaveBeenCalledWith(1000);
  expect(page.addOrderBy).toHaveBeenCalledWith(
    'cleanup.consolidation_key',
    'ASC'
  );
  expect(page.where).not.toHaveBeenCalled();
  expect(query.where).toHaveBeenCalledTimes(1);
  expect(query.where).toHaveBeenCalledWith('consolidation_key IN (:...keys)', {
    keys: ['aa-bb', 'bb-cc', 'aa', 'CC-dd']
  });
});

it('continues past an unmatched full page using its last primary key', async () => {
  const keys = Array.from({ length: 1000 }, (_, i) => `unchanged${i}`);
  const { repository, query, page } = mockRepository([...keys, 'changed']);
  expect(await deleteConsolidations(repository, new Set(['changed']))).toBe(1);
  expect(page.getRawMany).toHaveBeenCalledTimes(2);
  expect(page.where).toHaveBeenCalledWith(
    '(cleanup.consolidation_key > :after_0)',
    { after_0: keys[999] }
  );
  expect(query.where).toHaveBeenCalledWith('consolidation_key IN (:...keys)', {
    keys: ['changed']
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

it('matches complete Ethereum members and leaves embedded substrings untouched', async () => {
  const wallet = fc
    .hexaString({ minLength: 40, maxLength: 40 })
    .map((hex) => `0x${hex}`);
  await fc.assert(
    fc.asyncProperty(
      fc.uniqueArray(wallet, { minLength: 2, maxLength: 20 }),
      async (wallets) => {
        const groups = wallets.map((_, i) => wallets.slice(i, i + 4));
        const changed = wallets.filter((_, i) => i % 2 === 0);
        const expected = groups
          .filter((group) => group.some((member) => changed.includes(member)))
          .map((group) => group.join('-'));
        const embedded = wallets.flatMap((member) => [
          `prefix${member}`,
          `${member}0`,
          `(${member})`
        ]);
        const { repository, query } = mockRepository([
          ...groups.map((group) => group.join('-')),
          ...embedded
        ]);
        await deleteConsolidations(
          repository,
          new Set(changed.map((address) => address.toUpperCase()))
        );
        expect(
          new Set(query.where.mock.calls.flatMap((call) => call[1].keys))
        ).toEqual(new Set(expected));
      }
    )
  );
});
