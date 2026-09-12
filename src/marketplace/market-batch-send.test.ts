import { beginBatchTransactionAttempt } from '@/api/marketplace/marketplace-batch.service';
import { collectingDb } from '@/collecting/collecting.db';
import { marketChain } from '@/marketplace/market-chain';
import {
  marketOperationsDb,
  MarketOperationRow
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
import { MarketBatchPrepared } from '@/marketplace/market-batch.types';
import { marketBatchPrepareSchema } from '@/marketplace/market-batch.schema';
import { buildMarketBatchTransaction } from '@/marketplace/seaport-batch.builder';

jest.mock('@/marketplace/market-chain', () => ({ marketChain: jest.fn() }));
jest.mock('@/collecting/collecting.db', () => ({
  collectingDb: { readAccountHoldings: jest.fn() }
}));
jest.mock('@/collecting/collecting.service', () => ({
  collectingService: { getCatalog: jest.fn() }
}));

function setup() {
  const f = marketBatchFixture();
  const prepared: MarketBatchPrepared = {
    intent: f.intent,
    mirrorTerms: f.terms,
    reviewOrders: f.materials.map((m) => m.order),
    approvalTransactions: [],
    transaction: buildMarketBatchTransaction(f.intent, f.materials, f.terms),
    snapshot: {
      block_number: 10,
      block_hash: `0x${'11'.repeat(32)}`,
      block_timestamp: 1500
    },
    feePolicyVersion: 'EXACT_SELECTED_SIGNED_ORDERS',
    validUntil: 1520000,
    gas: {
      gas_limit: '500000',
      max_fee_per_gas: '10',
      gas_reserve_wei: '5000000'
    }
  };
  const request = marketBatchPrepareSchema.parse({
    kind: 'BUY_BATCH',
    profile_id: 'profile',
    wallet: f.intent.wallet,
    currency: f.intent.currency,
    execution_policy: 'ALL_OR_REVERT',
    amount_wei: f.intent.totalWei,
    items: f.intent.items.map((line) => ({
      asset_key: line.assetKey,
      quantity: line.intent.quantity,
      amount_wei: line.intent.maxTotalWei,
      order: {
        protocol_address: line.intent.order!.protocolAddress,
        order_hash: line.intent.order!.orderHash
      },
      allocations: line.allocations.map((a) => ({
        recipient: a.recipient,
        quantity: a.quantity,
        acknowledge_external_recipient: a.acknowledgeExternalRecipient
      }))
    }))
  });
  let row = {
    id: 'batch',
    profile_id: 'profile',
    wallet: f.intent.wallet,
    state: 'REVIEW',
    request_json: request,
    prepared_json: prepared,
    expires_at: 1520000,
    updated_at: 1500000,
    liability_wei: '0',
    currency: f.intent.currency
  } as MarketOperationRow;
  const chain = {
    rpc: {
      getCode: jest.fn().mockResolvedValue('0x'),
      getBlock: jest.fn().mockResolvedValue({
        hash: `0x${'11'.repeat(32)}`,
        timestamp: 1500,
        gasLimit: BigInt(60000000)
      })
    },
    simulate: jest.fn().mockResolvedValue(prepared.gas)
  };
  (marketChain as jest.Mock).mockReturnValue(chain);
  (collectingDb.readAccountHoldings as jest.Mock).mockResolvedValue({
    account: { wallets: [BATCH_BUYER, BATCH_OWN] }
  });
  jest.spyOn(marketOperationsDb, 'get').mockImplementation(async () => row);
  const transition = jest
    .spyOn(marketOperationsDb, 'transition')
    .mockImplementation(async (_id, _states, state, patch) => {
      row = {
        ...row,
        state,
        send_attempt_json: patch?.sendAttempt ?? row.send_attempt_json
      };
    });
  const input = {
    attempt_id: 'attempt',
    purpose: 'TRANSACTION' as const,
    expected_revision: marketOperationRevision(row),
    transaction_digest: reviewedTransactionDigest(prepared.transaction)
  };
  return {
    prepared,
    request,
    chain,
    input,
    transition,
    row: () => row,
    send: () => beginBatchTransactionAttempt(row, request, input)
  };
}

describe('batch wallet request fencing', () => {
  beforeEach(() => {
    jest.restoreAllMocks();
    jest.clearAllMocks();
    jest.useFakeTimers().setSystemTime(1500000);
  });
  afterEach(() => jest.useRealTimers());
  test('re-simulates the complete batch before committing UNKNOWN and exact immutable transaction', async () => {
    const s = setup();
    await s.send();
    expect(s.chain.simulate).toHaveBeenCalledWith(s.prepared.transaction);
    expect(s.row().state).toBe('UNKNOWN');
    expect(operationSendAttempt(s.row())).toMatchObject({
      status: 'ACTIVE',
      purpose: 'TRANSACTION',
      transaction: { data: s.prepared.transaction.data, value: '300' }
    });
    expect(s.transition).toHaveBeenCalledWith(
      'batch',
      ['REVIEW'],
      'UNKNOWN',
      expect.objectContaining({
        requireUnexpiredReview: true,
        expectedRevision: s.input.expected_revision
      })
    );
  });
  test('retries the same attempt without quoting or enabling a second send', async () => {
    const s = setup();
    await s.send();
    await s.send();
    expect(s.chain.simulate).toHaveBeenCalledTimes(1);
    expect(s.transition).toHaveBeenCalledTimes(1);
    await expect(
      beginBatchTransactionAttempt(s.row(), s.request, {
        ...s.input,
        attempt_id: 'other'
      })
    ).rejects.toMatchObject({ code: 'OPERATION_CHANGED' });
  });
  test('requires a fresh review if the gas reserve increases', async () => {
    const s = setup();
    s.chain.simulate.mockResolvedValue({
      ...s.prepared.gas,
      gas_reserve_wei: '5000001'
    });
    await expect(s.send()).rejects.toThrow('gas increased');
    expect(s.transition).not.toHaveBeenCalled();
  });
  test('requires review of a higher fee cap even when the estimated gas quantity decreases', async () => {
    const s = setup();
    s.chain.simulate.mockResolvedValue({
      gas_limit: '100000',
      max_fee_per_gas: '11',
      gas_reserve_wei: '1100000'
    });
    await expect(s.send()).rejects.toThrow('gas increased');
    expect(s.transition).not.toHaveBeenCalled();
  });
  test('cannot open a send fence after simulation consumes the review validity', async () => {
    const s = setup();
    s.chain.simulate.mockImplementation(async () => {
      jest.setSystemTime(1520001);
      return s.prepared.gas;
    });
    await expect(s.send()).rejects.toThrow();
    expect(s.transition).not.toHaveBeenCalled();
  });
  test('requires new acknowledgment if an own recipient leaves the profile', async () => {
    const s = setup();
    (collectingDb.readAccountHoldings as jest.Mock).mockResolvedValue({
      account: { wallets: [BATCH_BUYER] }
    });
    await expect(s.send()).rejects.toMatchObject({
      code: 'RECIPIENT_SCOPE_CHANGED'
    });
    expect(s.chain.simulate).not.toHaveBeenCalled();
    expect(s.transition).not.toHaveBeenCalled();
  });
  test('rejects changed allocations in persisted review before a wallet request', async () => {
    const s = setup();
    s.prepared.intent.items[1].allocations[0].recipient = BATCH_BUYER;
    await expect(s.send()).rejects.toThrow();
    expect(s.transition).not.toHaveBeenCalled();
  });
  test('does not allow a batch operation to execute a saved rule', async () => {
    const s = setup();
    s.row().rule_id = 'rule';
    await expect(s.send()).rejects.toMatchObject({ code: 'OPERATION_CHANGED' });
    expect(s.chain.simulate).not.toHaveBeenCalled();
  });
});
