import {
  NftMarketActivityService,
  marketEventToActivity,
  transactionToActivity
} from './nft-market-activity.service';
import { SqlExecutor } from '@/sql-executor';
import { MEMES_CONTRACT, NULL_ADDRESS } from '@/constants';
import { resolveEns } from '@/db-api';

jest.mock('@/db-api', () => ({ resolveEns: jest.fn() }));

const at = new Date('2026-09-10T12:00:00Z');
const hash = 'a'.repeat(64);
const address = '0x1111111111111111111111111111111111111111';
function transaction(
  patch: Partial<Parameters<typeof transactionToActivity>[0]> = {}
): Parameters<typeof transactionToActivity>[0] {
  return {
    event_key: hash,
    exact_token_id: '9007199254740993',
    occurred_at: at,
    transaction: `0x${hash}`,
    block: 1,
    created_at: at,
    transaction_date: at,
    from_address: address,
    to_address: MEMES_CONTRACT,
    contract: MEMES_CONTRACT,
    token_id: 9007199254740992,
    token_count: 1,
    value: 0.2,
    royalties: 0,
    gas_gwei: 0,
    gas_price: 0,
    gas_price_gwei: 0,
    gas: 0,
    primary_proceeds: 0,
    eth_price_usd: 0,
    value_usd: 0,
    gas_usd: 0,
    from_display: null,
    to_display: '',
    ...patch
  };
}
function event(
  patch: Partial<Parameters<typeof marketEventToActivity>[0]> = {}
): Parameters<typeof marketEventToActivity>[0] {
  return {
    event_id: 'b'.repeat(64),
    kind: 'item_cancelled',
    source: 'opensea_stream',
    source_evidence: 'stream',
    provider_at: at,
    observed_at: at,
    occurred_at: at,
    order_id: `0x${hash}`,
    contract: MEMES_CONTRACT,
    collection_slug: 'thememes6529',
    token_id: '8',
    maker: address,
    taker: null,
    quantity: '1',
    currency_contract: null,
    currency_symbol: null,
    currency_decimals: null,
    price_raw: null,
    price_decimal: null,
    transaction_hash: null,
    raw: { provider_payload: 'not included in public feed' },
    ...patch
  };
}

describe('NFT market activity', () => {
  it('preserves explicit cancellation and exact token ID without requiring a transaction', () => {
    const value = marketEventToActivity(event());
    expect(value.action).toBe('cancellation');
    expect(value.transaction_hash).toBeNull();
    expect(value.evidence).toBe('stream');
    expect(value).not.toHaveProperty('raw');
    expect(value).not.toHaveProperty('currency');
    expect(transactionToActivity(transaction()).token_id).toBe(
      '9007199254740993'
    );
  });

  it('keeps mint and transfer classifications rooted in the on-chain record', () => {
    expect(
      transactionToActivity(transaction({ from_address: NULL_ADDRESS })).action
    ).toBe('mint');
    expect(
      transactionToActivity(transaction({ to_address: NULL_ADDRESS })).action
    ).toBe('burn');
    expect(transactionToActivity(transaction({ value: 0 })).action).toBe(
      'transfer'
    );
  });

  it('labels inactive provider observations as invalidations', () => {
    expect(marketEventToActivity(event({ kind: 'inactive' })).action).toBe(
      'invalidation'
    );
  });

  it('merges both event sources in deterministic time order and binds its cursor to filters', async () => {
    const execute = jest
      .fn()
      .mockImplementation(async (sql: string) =>
        sql.includes('FROM market_depth_events')
          ? [event({ provider_at: new Date(at.getTime() + 1000) })]
          : [transaction()]
      );
    const executor = {
      execute,
      oneOrNull: jest.fn().mockResolvedValue({ started_at: at })
    } as unknown as SqlExecutor;
    const service = new NftMarketActivityService(() => executor);
    const result = await service.getActivity({ page_size: 1 });
    expect(result.data).toHaveLength(1);
    expect(result.data[0].action).toBe('cancellation');
    expect(result.next).not.toBeNull();
    await expect(
      service.getActivity({ filter: 'offers', cursor: result.next! })
    ).rejects.toThrow('Invalid activity cursor');
  });

  it('does not turn an unresolved wallet filter into an unfiltered global feed', async () => {
    jest.mocked(resolveEns).mockResolvedValue(['missing.eth']);
    const execute = jest.fn();
    const service = new NftMarketActivityService(
      () => ({ execute }) as unknown as SqlExecutor
    );
    expect((await service.getActivity({ wallet: 'missing.eth' })).data).toEqual(
      []
    );
    expect(execute).not.toHaveBeenCalled();
  });

  it('pages every row once across source boundaries with identical timestamps', async () => {
    const transactions = ['f', 'b', '2'].map((digit) =>
      transaction({ event_key: digit.repeat(64) })
    );
    const market = ['e', '9', '1'].map((digit) =>
      event({ event_id: digit.repeat(64) })
    );
    const execute = jest.fn(
      async (
        sql: string,
        params: {
          beforeAt: Date | null;
          beforeId: string | null;
          rowLimit: number;
        }
      ) => {
        const isMarket = sql.includes('FROM market_depth_events');
        const rows = isMarket ? market : transactions;
        const id = (row: (typeof rows)[number]) =>
          'event_key' in row ? `t:${row.event_key}` : `m:${row.event_id}`;
        if (params.beforeId) {
          expect(sql).toContain(
            isMarket
              ? "CONCAT('m:',e.event_id) < :beforeId"
              : "CONCAT('t:',SHA2"
          );
          expect(params.beforeAt).toEqual(at);
        }
        return rows
          .filter((row) => !params.beforeId || id(row) < params.beforeId)
          .slice(0, params.rowLimit);
      }
    );
    const executor = {
      execute,
      oneOrNull: jest.fn().mockResolvedValue(null)
    } as unknown as SqlExecutor;
    const service = new NftMarketActivityService(() => executor);
    const ids: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 4; page++) {
      const result = await service.getActivity({ page_size: 2, cursor });
      ids.push(...result.data.map((row) => row.event_id));
      cursor = result.next ?? undefined;
      if (!cursor) break;
    }
    expect(ids).toEqual([
      ...transactions.map((row) => `t:${row.event_key}`),
      ...market.map((row) => `m:${row.event_id}`)
    ]);
    expect(new Set(ids).size).toBe(6);
    expect(cursor).toBeUndefined();
  });

  it.each([
    ['sales', 't.from_address IN (:wallets)'],
    ['purchases', 't.to_address IN (:wallets)']
  ])(
    'selects the correct wallet direction for %s without market rows',
    async (filter, predicate) => {
      jest.mocked(resolveEns).mockResolvedValue([address]);
      const execute = jest.fn().mockResolvedValue([]);
      const executor = {
        execute,
        oneOrNull: jest.fn().mockResolvedValue(null)
      } as unknown as SqlExecutor;
      const service = new NftMarketActivityService(() => executor);
      await service.getActivity({
        wallet: address,
        filter: filter as 'sales' | 'purchases'
      });
      expect(execute).toHaveBeenCalledTimes(1);
      expect(execute.mock.calls[0][0]).toContain(predicate);
      expect(execute.mock.calls[0][1].wallets).toEqual([address]);
    }
  );

  it('rejects unsupported contracts and malformed cursors before querying', async () => {
    const execute = jest.fn();
    const service = new NftMarketActivityService(
      () => ({ execute }) as unknown as SqlExecutor
    );
    await expect(service.getActivity({ contract: address })).rejects.toThrow(
      'Unsupported'
    );
    await expect(service.getActivity({ cursor: 'invalid' })).rejects.toThrow(
      'Invalid market cursor'
    );
    await expect(
      service.getActivity({ cursor: Buffer.from('null').toString('base64url') })
    ).rejects.toThrow('Invalid market cursor');
    expect(execute).not.toHaveBeenCalled();
  });
});
