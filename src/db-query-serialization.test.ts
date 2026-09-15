import { execSQLWithParams } from './db';

it('retains database JSON serialization semantics for bound query rows', async () => {
  const query = jest.fn().mockResolvedValue([
    {
      at: new Date('2026-09-15T12:00:00Z'),
      bytes: Buffer.from([1, 2]),
      omitted: undefined,
      notFinite: Infinity,
      custom: { toJSON: () => ({ wire: 'value' }) }
    }
  ]);
  await expect(
    execSQLWithParams('SELECT fixture', undefined, {
      wrappedConnection: { connection: { query } }
    })
  ).resolves.toEqual([
    {
      at: '2026-09-15T12:00:00.000Z',
      bytes: { type: 'Buffer', data: [1, 2] },
      notFinite: null,
      custom: { wire: 'value' }
    }
  ]);
  expect(query).toHaveBeenCalledWith('SELECT fixture');
});
