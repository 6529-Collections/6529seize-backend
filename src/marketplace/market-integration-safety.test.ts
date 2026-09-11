import type { AuthenticationContext } from '@/auth-context';
import type {
  MarketPrepared,
  MarketPrepareRequest
} from '@/marketplace/market-preparation';
import { MarketPreparation } from '@/marketplace/market-preparation';
import { marketOperationsDb } from '@/marketplace/market-operations.db';
import { collectingDb } from '@/collecting/collecting.db';
import { marketChain } from '@/marketplace/market-chain';
import { operationDto } from '@/api/marketplace/marketplace.dto';
import {
  assertMarketActor,
  continueMarketOperation,
  listMarketOperations,
  prepareMarketOperation,
  publishMarketOperation,
  readMarketOperation,
  submitMarketOperation
} from '@/api/marketplace/marketplace.service';
import { MARKET_WETH, MARKET_SEAPORT } from '@/marketplace/seaport.registry';

jest.mock('@/marketplace/market-preparation', () => ({
  MarketPreparation: jest.fn()
}));
jest.mock('@/marketplace/market-operations.db', () => ({
  marketRequestHash: jest.fn(() => 'transaction-digest'),
  marketOperationsDb: {
    create: jest.fn(),
    transition: jest.fn(),
    get: jest.fn(),
    getForActor: jest.fn(),
    page: jest.fn(),
    reviewedTransaction: jest.fn()
  }
}));
jest.mock('@/collecting/collecting.db', () => ({
  collectingDb: { readAccountHoldings: jest.fn() }
}));
jest.mock('@/marketplace/market-chain', () => ({ marketChain: jest.fn() }));
jest.mock('@/marketplace/market-reconciliation', () => ({
  reconcileMarketOperation: jest.fn()
}));
jest.mock('@/api/marketplace/marketplace.dto', () => ({
  operationDto: jest.fn((row) => row),
  operationPrepared: jest.fn((row) => row.prepared_json),
  operationRequest: jest.fn((row) => row.request_json)
}));

const wallet = '0x1111111111111111111111111111111111111111';
const auth = {
  authenticatedWallet: wallet,
  authenticatedProfileId: 'profile',
  isAuthenticatedAsProxy: () => false
} as AuthenticationContext;
const request: MarketPrepareRequest = {
  profile_id: 'profile',
  wallet,
  recipient: wallet,
  asset_key: 'memes:56',
  kind: 'OFFER',
  quantity: '1',
  currency: MARKET_WETH,
  amount_wei: '100',
  expires_at: 1900000000,
  acknowledge_external_recipient: false
};

describe('market service authorization and first payload exposure', () => {
  const originalEnabled = process.env.MARKETPLACE_TRADING_ENABLED;
  const originalKey = process.env.OPENSEA_API_KEY;
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.MARKETPLACE_TRADING_ENABLED = 'true';
    process.env.OPENSEA_API_KEY = 'unit-test-placeholder';
    (collectingDb.readAccountHoldings as jest.Mock).mockResolvedValue({
      account: { wallets: [wallet] }
    });
    (marketChain as jest.Mock).mockReturnValue({
      currencyBalance: jest.fn().mockResolvedValue('100'),
      rpc: { getCode: jest.fn().mockResolvedValue('0x') }
    });
  });
  afterAll(() => {
    if (originalEnabled === undefined)
      delete process.env.MARKETPLACE_TRADING_ENABLED;
    else process.env.MARKETPLACE_TRADING_ENABLED = originalEnabled;
    if (originalKey === undefined) delete process.env.OPENSEA_API_KEY;
    else process.env.OPENSEA_API_KEY = originalKey;
  });
  it('reserves the full potential offer exposure durably before returning signable review fields', async () => {
    const sequence: string[] = [];
    const prepared = {
      intent: { maxTotalWei: '100' },
      signedOrder: { order: { orderHash: 'prepared-order' } }
    } as MarketPrepared;
    (MarketPreparation as jest.Mock).mockImplementation(() => ({
      prepare: jest.fn().mockResolvedValue(prepared)
    }));
    (marketOperationsDb.create as jest.Mock).mockResolvedValue({
      created: true,
      operation: { id: 'operation' }
    });
    (marketOperationsDb.transition as jest.Mock).mockImplementation(
      async () => {
        sequence.push('durable-reservation');
      }
    );
    (marketOperationsDb.get as jest.Mock).mockResolvedValue({
      id: 'operation',
      state: 'REVIEW',
      liability_wei: '100',
      prepared_json: prepared
    });
    (operationDto as jest.Mock).mockImplementation((row) => {
      sequence.push('payload-exposed');
      return row;
    });
    await prepareMarketOperation(auth, request, 'idempotency-key');
    expect(marketOperationsDb.transition).toHaveBeenCalledWith(
      'operation',
      ['PREPARING'],
      'REVIEW',
      expect.objectContaining({ prepared, liabilityWei: '100' })
    );
    expect(sequence).toEqual(['durable-reservation', 'payload-exposed']);
  });
  it('rejects proxy and different paying-wallet requests before creating a durable operation', async () => {
    expect(() =>
      assertMarketActor(
        {
          ...auth,
          isAuthenticatedAsProxy: () => true
        } as AuthenticationContext,
        request
      )
    ).toThrow(/directly/);
    await expect(
      prepareMarketOperation(
        auth,
        { ...request, wallet: '0x2222222222222222222222222222222222222222' },
        'key'
      )
    ).rejects.toThrow(/paying/);
    expect(marketOperationsDb.create).not.toHaveBeenCalled();
  });
  it('returns an idempotent existing operation without preparing a replacement signed order', async () => {
    const existing = { id: 'operation', state: 'REVIEW', liability_wei: '100' };
    (marketOperationsDb.create as jest.Mock).mockResolvedValue({
      created: false,
      operation: existing
    });
    (operationDto as jest.Mock).mockImplementation((row) => row);
    await expect(
      prepareMarketOperation(auth, request, 'same-key')
    ).resolves.toBe(existing);
    expect(MarketPreparation).not.toHaveBeenCalled();
    expect(marketOperationsDb.transition).not.toHaveBeenCalled();
  });
  it('defaults history to twenty operations without losing historical-wallet scope', async () => {
    const rows = Array.from({ length: 21 }, (_, index) => ({
      id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
      created_at: String(1000 - index)
    }));
    (marketOperationsDb.page as jest.Mock).mockResolvedValue(rows);
    (operationDto as jest.Mock).mockImplementation((row) => row);
    const page = await listMarketOperations(auth);
    expect(marketOperationsDb.page).toHaveBeenCalledWith(
      'profile',
      20,
      undefined,
      wallet
    );
    expect(page.operations).toHaveLength(20);
    expect(
      JSON.parse(Buffer.from(page.next!, 'base64url').toString('utf8'))
    ).toEqual({
      id: rows[19].id,
      created_at: Number(rows[19].created_at)
    });
  });
  it('honors an explicit history limit and cursor and rejects malformed cursors before querying', async () => {
    const before = {
      created_at: 123,
      id: '00000000-0000-4000-8000-000000000001'
    };
    const cursor = Buffer.from(JSON.stringify(before)).toString('base64url');
    (marketOperationsDb.page as jest.Mock).mockResolvedValue([]);
    await expect(
      listMarketOperations(auth, { limit: 5, cursor })
    ).resolves.toEqual({ operations: [], next: null });
    expect(marketOperationsDb.page).toHaveBeenCalledWith(
      'profile',
      5,
      before,
      wallet
    );
    (marketOperationsDb.page as jest.Mock).mockClear();
    await expect(
      listMarketOperations(auth, { limit: 5, cursor: 'not-a-cursor' })
    ).rejects.toThrow(/Invalid order history cursor/);
    expect(marketOperationsDb.page).not.toHaveBeenCalled();
  });
  function submittedFixture() {
    const tx = {
      hash: '0x' + '7'.repeat(64),
      from: wallet,
      to: MARKET_SEAPORT,
      data: '0x1234',
      value: BigInt(100),
      chainId: BigInt(1),
      blockNumber: 101
    };
    const historical = {
      intent: { ...request, kind: 'BUY' },
      transaction: {
        kind: 'TRANSACTION',
        chainId: 1,
        from: wallet,
        to: MARKET_SEAPORT,
        data: tx.data,
        value: '100',
        purpose: 'FULFILL'
      },
      approvalTransactions: [],
      snapshot: { block_number: 100 }
    } as unknown as MarketPrepared;
    const current = {
      ...historical,
      transaction: { ...historical.transaction!, data: '0x5678' }
    };
    const row = {
      id: 'operation',
      profile_id: 'profile',
      wallet,
      state: 'APPROVAL',
      request_json: { ...request, kind: 'BUY' },
      prepared_json: current
    };
    (marketOperationsDb.get as jest.Mock).mockResolvedValue(row);
    (marketOperationsDb.getForActor as jest.Mock).mockResolvedValue(row);
    (marketOperationsDb.reviewedTransaction as jest.Mock).mockResolvedValue(
      historical
    );
    const getTransaction = jest.fn().mockResolvedValue(tx);
    (marketChain as jest.Mock).mockReturnValue({ rpc: { getTransaction } });
    return { historical, tx, getTransaction, row };
  }
  it('attaches the exact previously reviewed transaction after another tab refreshes the quote', async () => {
    const { historical, tx } = submittedFixture();
    await submitMarketOperation('operation', auth, tx.hash);
    expect(marketOperationsDb.reviewedTransaction).toHaveBeenCalledWith(
      'operation',
      'transaction-digest'
    );
    expect(marketOperationsDb.transition).toHaveBeenCalledWith(
      'operation',
      ['REVIEW', 'APPROVAL'],
      'SUBMITTED',
      { transactionHash: tx.hash, prepared: historical }
    );
  });
  it('cannot attach a transaction whose reviewed payload belongs to a different operation', async () => {
    const { tx } = submittedFixture();
    (marketOperationsDb.reviewedTransaction as jest.Mock).mockImplementation(
      async (id) => (id === 'other-operation' ? {} : undefined)
    );
    await expect(
      submitMarketOperation('operation', auth, tx.hash)
    ).rejects.toThrow(/reviewed trade/);
    expect(marketOperationsDb.transition).not.toHaveBeenCalled();
  });
  it.each([
    { chainId: BigInt(10) },
    { from: '0x2222222222222222222222222222222222222222' },
    { to: '0x2222222222222222222222222222222222222222' },
    { data: '0xabcd' },
    { value: BigInt(101) },
    { blockNumber: 99 }
  ])(
    'checks actual transaction fields and preparation snapshot independently: %#',
    async (change) => {
      const { tx, getTransaction } = submittedFixture();
      getTransaction.mockResolvedValue({ ...tx, ...change });
      await expect(
        submitMarketOperation('operation', auth, tx.hash)
      ).rejects.toThrow(/reviewed trade/);
      expect(marketOperationsDb.transition).not.toHaveBeenCalled();
    }
  );

  it('lets the original wallet read and attach its transaction after changing profiles', async () => {
    const { tx, row } = submittedFixture();
    const migrated = {
      ...auth,
      authenticatedProfileId: 'new-profile'
    } as AuthenticationContext;
    (operationDto as jest.Mock).mockImplementation((value) => value);
    await expect(readMarketOperation('operation', migrated)).resolves.toBe(row);
    await submitMarketOperation('operation', migrated, tx.hash);
    expect(marketOperationsDb.getForActor).toHaveBeenCalledWith(
      'operation',
      'new-profile',
      wallet
    );
    expect(marketOperationsDb.get).toHaveBeenCalledWith('operation', 'profile');
    expect(marketOperationsDb.get).not.toHaveBeenCalledWith(
      'operation',
      'new-profile'
    );
    expect(marketOperationsDb.transition).toHaveBeenCalledWith(
      'operation',
      ['REVIEW', 'APPROVAL'],
      'SUBMITTED',
      expect.objectContaining({ transactionHash: tx.hash })
    );
  });

  it('allows a current profile sibling to read but rejects its transaction mutation before RPC', async () => {
    const { tx, row, getTransaction } = submittedFixture();
    const sibling = {
      ...auth,
      authenticatedWallet: '0x2222222222222222222222222222222222222222'
    } as AuthenticationContext;
    (operationDto as jest.Mock).mockImplementation((value) => value);
    await expect(readMarketOperation('operation', sibling)).resolves.toBe(row);
    await expect(
      submitMarketOperation('operation', sibling, tx.hash)
    ).rejects.toThrow(/wallet that created/);
    expect(getTransaction).not.toHaveBeenCalled();
    expect(marketOperationsDb.transition).not.toHaveBeenCalled();
  });

  it('cannot continue signing or publish an old-profile order even for its original wallet', async () => {
    submittedFixture();
    const migrated = {
      ...auth,
      authenticatedProfileId: 'new-profile'
    } as AuthenticationContext;
    await expect(
      continueMarketOperation('operation', migrated)
    ).rejects.toThrow(/authorized/);
    await expect(
      publishMarketOperation('operation', migrated, '0x1234')
    ).rejects.toThrow(/authorized/);
    expect(MarketPreparation).not.toHaveBeenCalled();
    expect(collectingDb.readAccountHoldings).not.toHaveBeenCalled();
    expect(marketOperationsDb.transition).not.toHaveBeenCalled();
  });

  it.each([
    {
      state: 'PREPARING',
      prepared: null,
      age: 61000,
      next: 'FAILED',
      errorCode: 'PREPARATION_INTERRUPTED'
    },
    {
      state: 'PUBLISHING',
      prepared: { signable: true },
      age: 61000,
      next: 'UNKNOWN',
      errorCode: 'PUBLICATION_UNKNOWN'
    },
    {
      state: 'PREPARING',
      prepared: { signable: true },
      age: 61000,
      next: undefined
    },
    { state: 'PREPARING', prepared: null, age: 1000, next: undefined },
    {
      state: 'PUBLISHING',
      prepared: { signable: true },
      age: 1000,
      next: undefined
    }
  ])(
    'recovers interrupted states without republishing or releasing exposure: %#',
    async ({ state, prepared, age, next, errorCode }) => {
      const row = {
        id: 'operation',
        profile_id: 'profile',
        wallet,
        state,
        updated_at: Date.now() - age,
        prepared_json: prepared,
        liability_wei: '100',
        request_json: request
      };
      (marketOperationsDb.getForActor as jest.Mock).mockResolvedValue(row);
      (marketOperationsDb.get as jest.Mock).mockResolvedValue({
        ...row,
        state: next ?? state
      });
      (operationDto as jest.Mock).mockImplementation((value) => value);
      const result = await readMarketOperation('operation', auth);
      expect(result).toMatchObject({
        state: next ?? state,
        liability_wei: '100'
      });
      if (next) {
        expect(marketOperationsDb.transition).toHaveBeenCalledWith(
          'operation',
          [state],
          next,
          { errorCode }
        );
      } else {
        expect(marketOperationsDb.transition).not.toHaveBeenCalled();
      }
      expect(MarketPreparation).not.toHaveBeenCalled();
    }
  );
});
