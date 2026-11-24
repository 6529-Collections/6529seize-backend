import { WavesChainIndexDb } from './waves-chain-index.db';

describe('WavesChainIndexDb.saveReadTime', () => {
  it("writes the finalized block time beside read_height, on the index's state row", async () => {
    const calls: { sql: string; params: Record<string, unknown> }[] = [];
    const executor = {
      execute: async (sql: string, params: Record<string, unknown>) => {
        calls.push({ sql, params });
        return [];
      }
    };
    await expect(
      new WavesChainIndexDb(() => executor as any).saveReadTime(
        1_764_201_600_000
      )
    ).resolves.toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].sql.replace(/\s+/g, ' ').trim()).toBe(
      'update waves_chain_index_state set read_time = :readTime where name = :name'
    );
    expect(calls[0].params).toEqual({
      name: 'waves',
      readTime: 1_764_201_600_000
    });
  });
});

describe('WavesChainIndexDb.saveReadTime without the column', () => {
  const failing = (error: unknown) =>
    new WavesChainIndexDb(
      () =>
        ({
          execute: async () => {
            throw error;
          }
        }) as any
    );

  it('saves nothing and says so when the column is not there yet', async () => {
    // Each way the driver can say it, on its own.
    for (const error of [
      Object.assign(new Error("Unknown column 'read_time'"), {
        code: 'ER_BAD_FIELD_ERROR'
      }),
      Object.assign(new Error("Unknown column 'read_time'"), { errno: 1054 }),
      Object.assign(new Error('query failed'), {
        driverError: { code: 'ER_BAD_FIELD_ERROR' }
      }),
      Object.assign(new Error('query failed'), {
        driverError: { errno: 1054 }
      })
    ]) {
      await expect(failing(error).saveReadTime(1)).resolves.toBe(false);
    }
  });

  it('throws any other error', async () => {
    await expect(
      failing(new Error('connection lost')).saveReadTime(1)
    ).rejects.toThrow('connection lost');
  });
});
