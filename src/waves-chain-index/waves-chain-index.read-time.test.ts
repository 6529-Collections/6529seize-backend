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
    await new WavesChainIndexDb(() => executor as any).saveReadTime(
      1_764_201_600_000
    );
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
