import { NotFoundException } from '@/exceptions';

const SENT = `0x${'5'.repeat(64)}`;
const RECIPIENT = '0x00000000000000000000000000000000000000b1';

const mockRules = {
  get: jest.fn(),
  findOperation: jest.fn(),
  recordSent: jest.fn(),
  release: jest.fn(),
  settle: jest.fn()
};
const mockRpc = {
  getTransactionReceipt: jest.fn(),
  getTransaction: jest.fn(),
  getTransactionCount: jest.fn(),
  getBlock: jest.fn()
};
let mockMode = 'primary';

jest.mock('@/collecting/collecting-rules.service', () => ({
  collectingRulesService: mockRules
}));
jest.mock('@/marketplace/market-chain', () => ({
  marketChain: () => ({ rpc: mockRpc })
}));
const mockMarketOperations = { get: jest.fn() };
jest.mock('@/marketplace/market-operations.db', () => ({
  marketOperationsDb: mockMarketOperations,
  marketRequestHash: () => 'request-hash'
}));
jest.mock('@/personal-records/personal-records.mode', () => ({
  personalRecordsMode: () => mockMode
}));
jest.mock('@/api/marketplace/marketplace.service', () => ({
  assertMarketActor: () => ({ profileId: 'profile-1', wallet: RECIPIENT }),
  readMarketOperation: jest.fn(async () => {
    throw new NotFoundException('Trade not found.');
  }),
  prepareMarketOperation: jest.fn()
}));

import { id as eventTopic, zeroPadValue } from 'ethers';
import { MARKET_SEAPORT } from '@/marketplace/seaport.registry';
import { prepareRule, reconcileRule } from './collect-rules.service';

const ASSET_CONTRACT = '0x0000000000000000000000000000000000000abc';
const transferSingle = (quantity: number) => ({
  address: ASSET_CONTRACT,
  topics: [
    eventTopic('TransferSingle(address,address,address,uint256,uint256)'),
    zeroPadValue(ASSET_CONTRACT, 32),
    zeroPadValue(ASSET_CONTRACT, 32),
    zeroPadValue(RECIPIENT, 32)
  ],
  data: `0x${'7'.padStart(64, '0')}${quantity.toString(16).padStart(64, '0')}`
});
const REPLACED = `0x${'6'.repeat(64)}`;
/**
 * The chain from block 10 on: the funding wallet's nonce 5 is used there,
 * by a transaction to `to` paying `value`, whose receipt has `logs`.
 */
function usedAt5(to: string, value: bigint, logs: unknown[]) {
  mockRpc.getTransactionCount.mockImplementation(
    async (_wallet: string, tag: unknown) =>
      tag === 'safe' || (typeof tag === 'number' && tag >= 10) ? 6 : 5
  );
  mockRpc.getBlock.mockImplementation(
    async (tag: unknown, prefetch?: boolean) => {
      if (tag === 'safe') return { number: 12 };
      if (prefetch)
        return {
          number: tag,
          prefetchedTransactions:
            tag === 10
              ? [{ hash: REPLACED, from: RECIPIENT, to, value, nonce: 5 }]
              : []
        };
      return { hash: '0xblock' };
    }
  );
  const receipt = mockRpc.getTransactionReceipt.getMockImplementation();
  mockRpc.getTransactionReceipt.mockImplementation(async (hash: string) =>
    hash === REPLACED ? mined(1, logs) : receipt ? receipt(hash) : null
  );
}
const mined = (status: number, logs: unknown[] = []) => ({
  status,
  blockNumber: 10,
  blockHash: '0xblock',
  gasUsed: BigInt(21_000),
  gasPrice: BigInt(2),
  logs
});

const pending = {
  operation_id: 'op-1',
  quote_id: 'q',
  profile_id: 'profile-1',
  funding_wallet: RECIPIENT,
  recipient: RECIPIENT,
  valid_until: 1_000,
  assets: [
    { asset_key: `1:${ASSET_CONTRACT}:7`, quantity: '2', unit_price_wei: '100' }
  ],
  item_cost_wei: '200',
  gas_reserve_wei: '20'
};
const rule = {
  id: 'rule-1',
  definition: { funding_wallet: RECIPIENT },
  pending_review: pending
};

describe('reconcile after the market journal is gone', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRpc.getTransactionReceipt.mockReset();
    mockRpc.getTransactionCount.mockReset();
    mockMode = 'primary';
    mockRules.get.mockResolvedValue(rule);
    mockRules.release.mockResolvedValue({ ...rule, pending_review: null });
    mockRules.settle.mockResolvedValue({ ...rule, pending_review: null });
    mockRpc.getTransaction.mockResolvedValue({
      from: RECIPIENT,
      to: MARKET_SEAPORT,
      value: BigInt(200),
      nonce: 5
    });
    mockRpc.getBlock.mockImplementation(async (tag: unknown) =>
      tag === 'safe' ? { number: 12 } : { hash: '0xblock' }
    );
  });

  it('releases an expired review that was never sent', async () => {
    mockRules.findOperation.mockResolvedValue({ transaction_hash: null });
    await reconcileRule('rule-1', {} as never);
    expect(mockRules.release).toHaveBeenCalledWith(
      'rule-1',
      'profile-1',
      'op-1'
    );
    expect(mockRules.settle).not.toHaveBeenCalled();
  });

  it('keeps a review whose quote can still be sent', async () => {
    mockRules.findOperation.mockResolvedValue(null);
    mockRules.get.mockResolvedValue({
      ...rule,
      pending_review: { ...pending, valid_until: Date.now() + 60_000 }
    });
    await reconcileRule('rule-1', {} as never);
    expect(mockRules.release).not.toHaveBeenCalled();
  });

  it('settles a sent purchase from its receipt once the block is safe', async () => {
    mockRules.findOperation.mockResolvedValue({ transaction_hash: SENT });
    mockRpc.getTransactionReceipt.mockResolvedValue(mined(0));
    await reconcileRule('rule-1', {} as never);
    expect(mockRules.settle).toHaveBeenCalledWith(
      'rule-1',
      'profile-1',
      {
        operation_id: 'op-1',
        status: 'reverted',
        transaction_hash: SENT,
        recipient: RECIPIENT,
        assets: [],
        item_cost_wei: '0',
        gas_cost_wei: '42000'
      },
      expect.objectContaining({ receipt: expect.anything() })
    );
    expect(mockRules.release).not.toHaveBeenCalled();
    // The hash was kept unchecked: reconcile checks it again first.
    expect(mockRules.recordSent).toHaveBeenCalledWith('op-1', SENT);
  });

  it('settles a partial fill at the quantity delivered', async () => {
    mockRules.findOperation.mockResolvedValue({ transaction_hash: SENT });
    mockRpc.getTransactionReceipt.mockResolvedValue(
      mined(1, [transferSingle(1)])
    );
    await reconcileRule('rule-1', {} as never);
    expect(mockRules.settle).toHaveBeenCalledWith(
      'rule-1',
      'profile-1',
      {
        operation_id: 'op-1',
        status: 'confirmed',
        transaction_hash: SENT,
        recipient: RECIPIENT,
        assets: [{ asset_key: `1:${ASSET_CONTRACT}:7`, quantity: '1' }],
        item_cost_wei: '100',
        gas_cost_wei: '42000'
      },
      expect.objectContaining({ receipt: expect.anything() })
    );
  });

  it('settles a partial fill with the market journal at the reviewed unit price', async () => {
    mockRules.findOperation.mockResolvedValue({
      transaction_hash: SENT,
      transaction_nonce: 5
    });
    jest
      .requireMock('@/api/marketplace/marketplace.service')
      .readMarketOperation.mockResolvedValueOnce({
        id: 'op-1',
        kind: 'BUY',
        state: 'CONFIRMED',
        transaction_hash: SENT,
        recipient: RECIPIENT,
        asset_key: `1:${ASSET_CONTRACT}:7`,
        settlement: { filled_quantity: '1' },
        total_wei: '200'
      });
    mockRpc.getTransactionReceipt.mockResolvedValue(
      mined(1, [transferSingle(1)])
    );
    await reconcileRule('rule-1', {} as never);
    expect(mockRules.settle).toHaveBeenCalledWith(
      'rule-1',
      'profile-1',
      expect.objectContaining({
        assets: [{ asset_key: `1:${ASSET_CONTRACT}:7`, quantity: '1' }],
        item_cost_wei: '100'
      }),
      expect.objectContaining({
        transaction: expect.objectContaining({ nonce: 5 }),
        receipt: expect.anything()
      })
    );
    // Its hash was checked already: not asked again.
    expect(mockRules.recordSent).not.toHaveBeenCalled();
  });

  it('refuses a receipt that is not the reviewed purchase', async () => {
    mockRules.findOperation.mockResolvedValue({ transaction_hash: SENT });
    mockRpc.getTransactionReceipt.mockResolvedValue(mined(1));
    await expect(reconcileRule('rule-1', {} as never)).rejects.toThrow(
      'bought nothing'
    );
    mockRpc.getTransactionReceipt.mockResolvedValue(
      mined(1, [transferSingle(2)])
    );
    for (const transaction of [
      { from: ASSET_CONTRACT, to: MARKET_SEAPORT, value: BigInt(200) },
      { from: RECIPIENT, to: ASSET_CONTRACT, value: BigInt(200) },
      { from: RECIPIENT, to: MARKET_SEAPORT, value: BigInt(199) }
    ]) {
      mockRpc.getTransaction.mockResolvedValue(transaction);
      await expect(reconcileRule('rule-1', {} as never)).rejects.toThrow(
        /can't be settled/
      );
    }
    expect(mockRules.settle).not.toHaveBeenCalled();
  });

  it('releases a sent purchase only once its nonce is used by another', async () => {
    mockRules.findOperation.mockResolvedValue({
      transaction_hash: SENT,
      transaction_nonce: '5'
    });
    mockRpc.getTransactionReceipt.mockResolvedValue(null);
    // The quote can still be used: kept.
    mockRules.get.mockResolvedValue({
      ...rule,
      pending_review: { ...pending, valid_until: Date.now() + 60_000 }
    });
    await reconcileRule('rule-1', {} as never);
    expect(mockRpc.getTransactionCount).not.toHaveBeenCalled();

    mockRules.get.mockResolvedValue(rule);
    // Nonce 5 not yet used on a safe block: it can still be mined.
    mockRpc.getTransactionCount.mockResolvedValue(5);
    await reconcileRule('rule-1', {} as never);
    expect(mockRules.release).not.toHaveBeenCalled();
    // The wallet mined past it with no receipt for the hash, and the
    // transaction at nonce 5 was a cancel: released.
    usedAt5(RECIPIENT, BigInt(0), []);
    await reconcileRule('rule-1', {} as never);
    expect(mockRpc.getTransactionCount).toHaveBeenCalledWith(RECIPIENT, 'safe');
    expect(mockRules.release).toHaveBeenCalledTimes(1);
    const [id, profile, operation, unmined] = mockRules.release.mock.calls[0];
    expect([id, profile, operation, unmined.transactionHash]).toEqual([
      'rule-1',
      'profile-1',
      'op-1',
      SENT
    ]);
    expect(unmined.evidence.receipt).toBeNull();
    expect(await unmined.evidence.minedNonce(RECIPIENT)).toBe(6);
    expect(await unmined.evidence.nonceTransaction(RECIPIENT, 5)).toMatchObject(
      { hash: REPLACED }
    );
    expect(mockRules.settle).not.toHaveBeenCalled();
  });

  it('settles a purchase sped up under another hash at the same nonce', async () => {
    mockRules.findOperation.mockResolvedValue({
      transaction_hash: SENT,
      transaction_nonce: 5
    });
    mockRpc.getTransactionReceipt.mockImplementation(async (hash: string) =>
      hash === REPLACED ? mined(1, [transferSingle(2)]) : null
    );
    usedAt5(MARKET_SEAPORT, BigInt(200), [transferSingle(2)]);
    await reconcileRule('rule-1', {} as never);
    expect(mockRules.release).not.toHaveBeenCalled();
    expect(mockRules.settle).toHaveBeenCalledWith(
      'rule-1',
      'profile-1',
      expect.objectContaining({
        transaction_hash: REPLACED,
        status: 'confirmed',
        assets: [{ asset_key: `1:${ASSET_CONTRACT}:7`, quantity: '2' }],
        item_cost_wei: '200'
      }),
      expect.objectContaining({ hash: REPLACED })
    );
  });

  it('keeps a hash sent before nonces were kept pending until it is mined', async () => {
    mockRules.findOperation.mockResolvedValue({
      transaction_hash: SENT,
      transaction_nonce: null
    });
    mockRpc.getTransactionReceipt.mockResolvedValue(null);
    mockRpc.getTransactionCount.mockResolvedValue(100);
    expect(await reconcileRule('rule-1', {} as never)).toBe(rule);
    expect(mockRules.release).not.toHaveBeenCalled();
  });

  it('changes nothing outside primary mode', async () => {
    mockMode = 'legacy';
    await expect(reconcileRule('rule-1', {} as never)).rejects.toThrow(
      'Trade not found.'
    );
    expect(mockRules.findOperation).not.toHaveBeenCalled();
  });
});

describe('prepare after the market journal is gone', () => {
  const trade = {
    kind: 'BUY',
    currency: '0x0000000000000000000000000000000000000000'
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockRules.get.mockResolvedValue(rule);
    mockMarketOperations.get.mockRejectedValue(
      new NotFoundException('Trade not found.')
    );
  });

  it('answers 409 RULE_PENDING in primary, so the page reconciles first', async () => {
    mockMode = 'primary';
    mockRules.findOperation.mockResolvedValue(null);
    await expect(
      prepareRule(
        'rule-1',
        {} as never,
        { expected_revision: 1, trade: trade as never },
        'key-1'
      )
    ).rejects.toMatchObject({ code: 'RULE_PENDING' });
  });

  it('names the nonce to replace when the purchase was sent and not mined', async () => {
    mockMode = 'primary';
    mockRules.findOperation.mockResolvedValue({
      transaction_hash: SENT,
      transaction_nonce: 5
    });
    const thrown = await prepareRule(
      'rule-1',
      {} as never,
      { expected_revision: 1, trade: trade as never },
      'key-1'
    ).catch((error: Error & { code?: string }) => error);
    expect(thrown).toMatchObject({ code: 'RULE_PENDING' });
    expect((thrown as Error).message).toContain(
      'send a replacement at nonce 5'
    );
  });

  it('answers 404 as today outside primary', async () => {
    mockMode = 'legacy';
    await expect(
      prepareRule(
        'rule-1',
        {} as never,
        { expected_revision: 1, trade: trade as never },
        'key-1'
      )
    ).rejects.toThrow('Trade not found.');
  });
});
