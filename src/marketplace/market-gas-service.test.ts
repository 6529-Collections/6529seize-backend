import { JsonRpcProvider } from 'ethers';
import { AuthenticationContext } from '@/auth-context';
import {
  beginMarketTransactionAttempt,
  continueMarketOperation
} from '@/api/marketplace/marketplace.service';
import { collectingDb } from '@/collecting/collecting.db';
import { collectingRulesService } from '@/collecting/collecting-rules.service';
import { marketChain } from '@/marketplace/market-chain';
import {
  MarketPrepared,
  MarketPreparation,
  MarketPrepareRequest
} from '@/marketplace/market-preparation';
import {
  MarketOperationRow,
  marketOperationsDb
} from '@/marketplace/market-operations.db';
import {
  marketOperationRevision,
  operationSendAttempt,
  reviewedTransactionDigest
} from '@/marketplace/market-operation-state';
import {
  marketBatchFixture,
  BATCH_BUYER,
  BATCH_OWN
} from '@/marketplace/market-batch.test-fixture';
import { buildMarketFulfillment } from '@/marketplace/seaport.builder';
import { MARKET_ZERO_ADDRESS } from '@/marketplace/seaport.registry';
import { MarketTransaction } from '@/marketplace/provider.types';

jest.mock('@/marketplace/market-chain', () => ({ marketChain: jest.fn() }));
jest.mock('@/collecting/collecting.db', () => ({
  collectingDb: { readAccountHoldings: jest.fn() }
}));
jest.mock('@/collecting/collecting.service', () => ({
  collectingService: { getCatalog: jest.fn() }
}));
jest.mock('@/collecting/collecting-rules.service', () => ({
  collectingRulesService: {
    get: jest.fn(),
    assertOperationContinuation: jest.fn()
  }
}));

function setup(approval = false) {
  const f = marketBatchFixture();
  const intent = f.intent.items[0].intent;
  const transaction = buildMarketFulfillment(
    intent,
    f.materials[0].order,
    f.materials[0].signature
  );
  const gas = {
    gas_limit: '500000',
    max_fee_per_gas: '10',
    gas_reserve_wei: '5000000'
  };
  const approvalTransaction: MarketTransaction = {
    ...transaction,
    to: intent.asset.contract,
    value: '0',
    data: '0x1234',
    purpose: 'APPROVE_NFT',
    approvalScope: 'TOKEN',
    gas
  };
  const prepared: MarketPrepared = {
    intent,
    recipientInProfile: true,
    transaction,
    gas,
    approvalTransactions: approval ? [approvalTransaction] : [],
    snapshot: {
      block_number: 10,
      block_hash: `0x${'11'.repeat(32)}`,
      block_timestamp: 1500
    },
    feePolicyVersion: 'EXACT_SELECTED_SIGNED_ORDERS',
    reviewOrder: f.materials[0].order,
    nftRecipient: BATCH_OWN
  };
  const request: MarketPrepareRequest = {
    kind: 'BUY',
    profile_id: 'profile',
    wallet: BATCH_BUYER,
    recipient: BATCH_OWN,
    asset_key: f.intent.items[0].assetKey,
    quantity: intent.quantity,
    currency: MARKET_ZERO_ADDRESS,
    amount_wei: intent.maxTotalWei,
    acknowledge_external_recipient: false,
    order: {
      protocol_address: intent.order!.protocolAddress,
      order_hash: intent.order!.orderHash
    }
  };
  let row: MarketOperationRow = {
    id: 'single',
    profile_id: 'profile',
    wallet: BATCH_BUYER,
    created_at: 1500000,
    error_code: null,
    order_hash: null,
    transaction_hash: null,
    idempotency_key: 'prepare-key',
    request_hash: 'request-hash',
    state: approval ? 'APPROVAL' : 'REVIEW',
    request_json: request,
    prepared_json: prepared,
    expires_at: 1520000,
    updated_at: 1500000,
    liability_wei: '0',
    currency: MARKET_ZERO_ADDRESS
  };
  const auth = new AuthenticationContext({
    authenticatedWallet: BATCH_BUYER,
    authenticatedProfileId: 'profile',
    roleProfileId: null,
    activeProxyActions: []
  });
  const rpc = {
    call: jest.fn().mockResolvedValue('0x'),
    estimateGas: jest.fn().mockResolvedValue(BigInt(450000)),
    getFeeData: jest.fn().mockResolvedValue({
      maxFeePerGas: BigInt(16),
      maxPriorityFeePerGas: BigInt(2)
    }),
    getBlock: jest.fn().mockResolvedValue({
      hash: `0x${'11'.repeat(32)}`,
      timestamp: 1500,
      baseFeePerGas: BigInt(7)
    }),
    getBalance: jest.fn().mockResolvedValue(BigInt(100000000)),
    getCode: jest.fn().mockResolvedValue('0x')
  };
  const { MarketChain } = jest.requireActual<
    typeof import('@/marketplace/market-chain')
  >('@/marketplace/market-chain');
  const chain = new MarketChain(rpc as unknown as JsonRpcProvider);
  (marketChain as jest.Mock).mockReturnValue(chain);
  (collectingDb.readAccountHoldings as jest.Mock).mockResolvedValue({
    account: { wallets: [BATCH_BUYER, BATCH_OWN] }
  });
  jest
    .spyOn(marketOperationsDb, 'getForActor')
    .mockImplementation(async () => row);
  jest.spyOn(marketOperationsDb, 'get').mockImplementation(async () => row);
  const transition = jest
    .spyOn(marketOperationsDb, 'transition')
    .mockImplementation(async (_id, _expected, state, patch) => {
      row = {
        ...row,
        state,
        prepared_json: patch?.prepared ?? row.prepared_json,
        expires_at: patch?.expiresAt ?? row.expires_at,
        send_attempt_json: patch?.sendAttempt ?? row.send_attempt_json
      };
    });
  const input = {
    attempt_id: 'attempt',
    purpose: approval ? ('APPROVAL' as const) : ('TRANSACTION' as const),
    expected_revision: marketOperationRevision(row),
    transaction_digest: reviewedTransactionDigest(
      approval ? approvalTransaction : transaction
    )
  };
  return {
    auth,
    chain,
    rpc,
    prepared,
    request,
    transition,
    input,
    row: () => row,
    send: () => beginMarketTransactionAttempt('single', auth, input)
  };
}

describe('single trade stable gas service boundaries', () => {
  beforeEach(() => {
    jest.restoreAllMocks();
    jest.clearAllMocks();
    jest.spyOn(Date, 'now').mockReturnValue(1500000);
    process.env.OPENSEA_API_KEY = 'test-not-a-real-key';
  });
  it('preserves completed approval cost evidence across a new exact purchase quote', async () => {
    const s = setup();
    const approvalReceipts: NonNullable<MarketPrepared['approvalReceipts']> = [
      {
        purpose: 'APPROVAL',
        from: BATCH_BUYER,
        transactionHash: `0x${'ab'.repeat(32)}`,
        blockNumber: 9,
        blockHash: `0x${'cd'.repeat(32)}`,
        blockTimestamp: 1499,
        status: 'SUCCESS',
        confirmation: 'INCLUDED',
        gasUsed: '45000',
        effectiveGasPriceWei: '3',
        networkFeeWei: '135000'
      }
    ];
    s.prepared.approvalReceipts = approvalReceipts;
    const { approvalReceipts: _previous, ...fresh } = s.prepared;
    jest.spyOn(MarketPreparation.prototype, 'prepare').mockResolvedValue(fresh);
    await continueMarketOperation('single', s.auth);
    expect((s.row().prepared_json as MarketPrepared).approvalReceipts).toEqual(
      approvalReceipts
    );
    expect(operationSendAttempt(s.row())).toBeUndefined();
  });
  afterEach(() => {
    jest.restoreAllMocks();
    delete process.env.OPENSEA_API_KEY;
  });

  it.each([false, true])(
    'arms exact reviewed %s approval bytes despite larger padded recommendations, once only',
    async (approval) => {
      const s = setup(approval);
      await s.send();
      expect(s.row().state).toBe('UNKNOWN');
      expect(s.prepared.gas?.max_fee_per_gas).toBe('10');
      const journal = operationSendAttempt(s.row());
      expect(journal?.transaction).toEqual(
        approval
          ? s.prepared.approvalTransactions[0]
          : { ...s.prepared.transaction, gas: s.prepared.gas }
      );
      await s.send();
      expect(s.rpc.estimateGas).toHaveBeenCalledTimes(1);
      expect(s.transition).toHaveBeenCalledTimes(1);
      await expect(
        beginMarketTransactionAttempt('single', s.auth, {
          ...s.input,
          attempt_id: 'second'
        })
      ).rejects.toMatchObject({ code: 'OPERATION_CHANGED' });
      expect(s.rpc.estimateGas).toHaveBeenCalledTimes(1);
    }
  );

  it.each(['gas', 'fee', 'provider'] as const)(
    'does not commit UNKNOWN for a %s failure and preserves review',
    async (reason) => {
      const s = setup();
      if (reason === 'gas') s.rpc.estimateGas.mockResolvedValue(BigInt(500001));
      else if (reason === 'fee')
        s.rpc.getFeeData.mockResolvedValue({
          maxFeePerGas: BigInt(20),
          maxPriorityFeePerGas: BigInt(4)
        });
      else s.rpc.getBlock.mockRejectedValue(new Error('offline'));
      await expect(s.send()).rejects.toMatchObject({
        code:
          reason === 'provider' ? 'PROVIDER_UNAVAILABLE' : 'OPERATION_CHANGED'
      });
      expect(s.transition).not.toHaveBeenCalled();
      expect(s.row().state).toBe('REVIEW');
      expect(s.row().prepared_json).toBe(s.prepared);
    }
  );

  it('does not borrow the purchase cap when a required approval has no disclosed gas cap', async () => {
    const s = setup(true);
    delete s.prepared.approvalTransactions[0].gas;
    await expect(s.send()).rejects.toMatchObject({ code: 'OPERATION_CHANGED' });
    expect(s.rpc.call).not.toHaveBeenCalled();
    expect(s.transition).not.toHaveBeenCalled();
  });

  it('checks review expiry again after current chain requirements return', async () => {
    const s = setup();
    s.rpc.getBalance.mockImplementation(async () => {
      jest.mocked(Date.now).mockReturnValue(1520001);
      return BigInt(100000000);
    });
    await expect(s.send()).rejects.toMatchObject({ code: 'OPERATION_CHANGED' });
    expect(s.transition).not.toHaveBeenCalled();
  });

  it('refreshes the saved exact request with its old caps and journals the new authorization', async () => {
    const s = setup();
    const fresh: MarketPrepared = {
      ...s.prepared,
      transaction: { ...s.prepared.transaction!, data: '0x5678' }
    };
    const prepare = jest
      .spyOn(MarketPreparation.prototype, 'prepare')
      .mockImplementation(async (_request, _member, _known, prior) => ({
        ...fresh,
        gas: await s.chain.simulate(fresh.transaction!, prior!.gas)
      }));
    await continueMarketOperation('single', s.auth);
    expect(prepare).toHaveBeenCalledWith(
      s.request,
      true,
      undefined,
      s.prepared
    );
    expect(s.transition).toHaveBeenCalledWith(
      'single',
      ['REVIEW', 'APPROVAL', 'AWAITING_SIGNATURE'],
      'REVIEW',
      expect.objectContaining({
        expectedRevision: s.input.expected_revision,
        prepared: fresh,
        reviewedTransaction: {
          digest: reviewedTransactionDigest(fresh.transaction!),
          prepared: fresh
        }
      })
    );
  });

  it('leaves a failed continuation review intact', async () => {
    const s = setup();
    jest
      .spyOn(MarketPreparation.prototype, 'prepare')
      .mockRejectedValue(new Error('unavailable'));
    await expect(continueMarketOperation('single', s.auth)).rejects.toThrow(
      'unavailable'
    );
    expect(s.transition).not.toHaveBeenCalled();
    expect(s.row().prepared_json).toBe(s.prepared);
  });

  it('returns a new REVIEW with higher caps for a genuine requirement overrun without arming a send', async () => {
    const s = setup();
    s.rpc.estimateGas.mockResolvedValue(BigInt(500001));
    jest
      .spyOn(MarketPreparation.prototype, 'prepare')
      .mockImplementation(async (_request, _member, _known, prior) => ({
        ...s.prepared,
        gas: await s.chain.simulate(s.prepared.transaction!, prior!.gas)
      }));
    const result = await continueMarketOperation('single', s.auth);
    expect(result.state).toBe('REVIEW');
    expect(BigInt(result.transaction!.gas_limit!)).toBeGreaterThan(
      BigInt(s.prepared.gas!.gas_limit)
    );
    expect(operationSendAttempt(s.row())).toBeUndefined();
    expect(s.transition).toHaveBeenCalledTimes(1);
  });

  it('keeps saved-rule continuation on fresh quoting without inheriting the user envelope', async () => {
    const s = setup();
    s.row().rule_id = 'rule';
    (collectingRulesService.get as jest.Mock).mockResolvedValue({
      definition: { expires_at: 1600000 }
    });
    const prepare = jest
      .spyOn(MarketPreparation.prototype, 'prepare')
      .mockResolvedValue(s.prepared);
    await continueMarketOperation('single', s.auth);
    expect(prepare).toHaveBeenCalledWith(s.request, true, undefined, undefined);
    expect(s.transition).toHaveBeenCalledWith(
      'single',
      expect.any(Array),
      'REVIEW',
      expect.objectContaining({ beforeCommit: expect.any(Function) })
    );
  });

  it('rejects a changed profile wallet before chain reads or send arming', async () => {
    const s = setup();
    (collectingDb.readAccountHoldings as jest.Mock).mockResolvedValue({
      account: { wallets: [BATCH_OWN] }
    });
    await expect(s.send()).rejects.toThrow('paying wallet');
    expect(s.rpc.call).not.toHaveBeenCalled();
    expect(s.transition).not.toHaveBeenCalled();
  });
});
