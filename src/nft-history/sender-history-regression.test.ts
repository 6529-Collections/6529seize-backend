import { getEthereumRpcClient } from '@/ethereum-rpc/ethereum-rpc-client';
import fixtures from './fixtures/sender-history-fixtures.json';
import { canonicalJson } from './canonical-json';
import { prepareTransactionSource } from './source-replay';
import { VirtualSourceReader } from './source-plan';

jest.mock('@/ethereum-rpc/ethereum-rpc-client', () => ({
  getEthereumRpcClient: jest.fn()
}));

it.each(fixtures.cases)(
  'recovers exactly one canonical Mint for $contract/$token from public archive evidence',
  async (fixture) => {
    const calls = fixture.calls as Record<string, unknown>;
    const methods = [
      'getTransaction',
      'getTransactionReceipt',
      'getBlock',
      'getLogs',
      'call'
    ];
    const rpc = Object.fromEntries(
      methods.map((method) => [
        method,
        jest.fn(async (...args: unknown[]) => {
          const key = canonicalJson([method, args]);
          if (!Object.prototype.hasOwnProperty.call(calls, key))
            throw new Error(`Unexpected archive call: ${key}`);
          return calls[key];
        })
      ])
    );
    jest
      .mocked(getEthereumRpcClient)
      .mockReturnValue(
        rpc as unknown as ReturnType<typeof getEthereumRpcClient>
      );
    const view = new VirtualSourceReader({
      history: async () => ({ legacy: [], events: [] }),
      claims: async (contract, claimId) =>
        fixture.initialClaims.filter(
          (row) =>
            row.contract.toLowerCase() === contract.toLowerCase() &&
            String(row.claimIndex) === claimId
        )
    });
    for (const source of fixture.sources)
      await view.apply(await prepareTransactionSource(source, view));
    const state = await view.history(fixture.contract, fixture.token);
    expect(state.legacy).toHaveLength(1);
    expect(state.legacy[0]).toEqual(
      expect.objectContaining({
        nft_id: fixture.token,
        uri: fixture.expectedMint.uri,
        block: fixture.expectedMint.block,
        transaction_hash: fixture.expectedMint.transaction,
        description: { event: 'Mint', changes: [] }
      })
    );
    expect(state.legacy[0].transaction_date.toISOString()).toBe(
      fixture.expectedMint.utc
    );
    for (const source of fixture.sources)
      expect(await prepareTransactionSource(source, view)).toEqual({
        claims: [],
        writes: []
      });
  }
);
