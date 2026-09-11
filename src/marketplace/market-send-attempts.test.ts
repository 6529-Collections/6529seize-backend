import { marketChain } from './market-chain';
import { marketOperationsDb, MarketOperationRow } from './market-operations.db';
import {
  marketOperationRevision,
  operationSendAttempt,
  reviewedTransactionDigest
} from './market-operation-state';
import {
  beginMarketSendAttempt,
  rejectMarketSendAttempt,
  reconcileApprovalAttempt,
  submitApprovalAttempt,
  verifyAttemptTransaction
} from './market-send-attempts';
import type { MarketPrepared } from './market-preparation';
import type { MarketTransaction } from './provider.types';

jest.mock('./market-chain', () => ({ marketChain: jest.fn() }));
const wallet = '0x1111111111111111111111111111111111111111';
const hash = `0x${'ab'.repeat(32)}`;
const transaction: MarketTransaction = {
  kind: 'TRANSACTION',
  chainId: 1,
  from: wallet,
  to: '0x2222222222222222222222222222222222222222',
  data: '0x1234',
  value: '0',
  purpose: 'APPROVE_NFT'
};
const prepared = {
  intent: { wallet, kind: 'LIST' },
  approvalTransactions: [transaction],
  reviewOrder: { components: { conduitKey: `0x${'00'.repeat(32)}` } },
  snapshot: { block_number: 100, block_hash: hash, block_timestamp: 1 }
} as MarketPrepared;

describe('durable wallet send attempts', () => {
  let row: MarketOperationRow;
  const rpc = {
    getTransaction: jest.fn(),
    getTransactionReceipt: jest.fn(),
    getBlock: jest.fn()
  };
  const approvals = jest.fn();
  beforeEach(() => {
    jest.restoreAllMocks();
    jest.clearAllMocks();
    row = {
      id: 'operation',
      profile_id: 'profile',
      wallet,
      state: 'APPROVAL',
      prepared_json: prepared,
      expires_at: Date.now() + 20000,
      updated_at: 10
    } as MarketOperationRow;
    jest.spyOn(marketOperationsDb, 'get').mockImplementation(async () => row);
    jest
      .spyOn(marketOperationsDb, 'transition')
      .mockImplementation(async (_id, _expected, state, patch) => {
        row = {
          ...row,
          state,
          send_attempt_json: patch?.sendAttempt ?? row.send_attempt_json,
          expires_at: patch?.expiresAt ?? row.expires_at,
          prepared_json: patch?.prepared ?? row.prepared_json
        };
      });
    (marketChain as jest.Mock).mockReturnValue({ rpc, approvals });
    rpc.getTransaction.mockResolvedValue({
      ...transaction,
      hash,
      chainId: BigInt(1),
      value: BigInt(0),
      blockNumber: 101
    });
    rpc.getTransactionReceipt.mockResolvedValue({
      hash,
      blockNumber: 101,
      blockHash: hash,
      status: 1
    });
    rpc.getBlock.mockResolvedValue({ hash, number: 101 });
    approvals.mockResolvedValue([]);
  });
  async function begin() {
    const input = {
      attempt_id: 'attempt',
      purpose: 'APPROVAL' as const,
      expected_revision: marketOperationRevision(row),
      transaction_digest: reviewedTransactionDigest(transaction)
    };
    await beginMarketSendAttempt(row, input);
    return input;
  }
  it('commits the exact selected approval and UNKNOWN before returning; same attempt retries are idempotent', async () => {
    const input = await begin();
    expect(row.state).toBe('UNKNOWN');
    expect(operationSendAttempt(row)).toMatchObject({
      attempt_id: 'attempt',
      purpose: 'APPROVAL',
      status: 'ACTIVE',
      snapshot_block: 100,
      transaction
    });
    await beginMarketSendAttempt(row, input);
    expect(marketOperationsDb.transition).toHaveBeenCalledTimes(1);
    await expect(
      beginMarketSendAttempt(row, { ...input, attempt_id: 'other' })
    ).rejects.toMatchObject({ code: 'OPERATION_CHANGED' });
  });
  it.each(['purpose', 'transaction_digest', 'expires_at'])(
    'rejects a changed %s before persisting a wallet request',
    async (field) => {
      const input = {
        attempt_id: 'attempt',
        purpose: 'APPROVAL' as const,
        expected_revision: marketOperationRevision(row),
        transaction_digest: reviewedTransactionDigest(transaction)
      };
      if (field === 'expires_at') row.expires_at = 0;
      await expect(
        beginMarketSendAttempt(row, {
          ...input,
          ...(field === 'purpose' ? { purpose: 'TRANSACTION' as const } : {}),
          ...(field === 'transaction_digest'
            ? { transaction_digest: 'different' }
            : {})
        })
      ).rejects.toThrow();
      expect(marketOperationsDb.transition).not.toHaveBeenCalled();
    }
  );
  it('passes immutable revision and rule guard to the locked transition', async () => {
    const guard = jest.fn();
    await beginMarketSendAttempt(
      row,
      {
        attempt_id: 'attempt',
        purpose: 'APPROVAL',
        expected_revision: 'expected',
        transaction_digest: reviewedTransactionDigest(transaction)
      },
      guard
    );
    expect(marketOperationsDb.transition).toHaveBeenCalledWith(
      'operation',
      ['APPROVAL'],
      'UNKNOWN',
      expect.objectContaining({
        expectedRevision: 'expected',
        beforeCommit: guard
      })
    );
  });
  it('never clears an unknown send through elapsed time or a missing hash', async () => {
    await begin();
    row.expires_at = 0;
    await reconcileApprovalAttempt(row);
    expect(operationSendAttempt(row)?.status).toBe('ACTIVE');
    expect(rpc.getTransaction).not.toHaveBeenCalled();
  });
  it('records explicit rejection idempotently and requires fresh review before another wallet prompt', async () => {
    await begin();
    await expect(
      rejectMarketSendAttempt(row, 'other', 'USER_REJECTED')
    ).rejects.toThrow();
    await rejectMarketSendAttempt(row, 'attempt', 'WALLET_NOT_REQUESTED');
    expect(row.state).toBe('APPROVAL');
    expect(row.expires_at).toBe(0);
    expect(operationSendAttempt(row)).toMatchObject({
      status: 'REJECTED',
      rejection_reason: 'WALLET_NOT_REQUESTED'
    });
    await rejectMarketSendAttempt(row, 'attempt', 'WALLET_NOT_REQUESTED');
    expect(marketOperationsDb.transition).toHaveBeenCalledTimes(2);
  });
  it('retains a visible pending approval hash durably and prevents rejection or a different hash', async () => {
    await begin();
    rpc.getTransactionReceipt.mockResolvedValue(null);
    await submitApprovalAttempt(row, hash);
    expect(operationSendAttempt(row)).toMatchObject({
      status: 'ACTIVE',
      transaction_hash: hash
    });
    await expect(
      rejectMarketSendAttempt(row, 'attempt', 'USER_REJECTED')
    ).rejects.toThrow();
    await expect(
      submitApprovalAttempt(row, `0x${'cd'.repeat(32)}`)
    ).rejects.toThrow();
  });
  it('resolves a canonical mined approval after fresh permission checks without waiting for safe finality', async () => {
    await begin();
    await submitApprovalAttempt(row, hash);
    expect(approvals).toHaveBeenCalledWith(
      prepared.intent,
      prepared.reviewOrder?.components.conduitKey
    );
    expect(rpc.getBlock).not.toHaveBeenCalledWith('safe');
    expect(operationSendAttempt(row)).toMatchObject({
      status: 'RESOLVED',
      transaction_hash: hash
    });
    expect(row.state).toBe('REVIEW');
    expect(row.expires_at).toBe(0);
  });
  it.each([
    'reorg',
    'permission-failure',
    'receipt-predates',
    'unknown-status'
  ])('keeps %s approval uncertainty active', async (reason) => {
    await begin();
    if (reason === 'reorg') rpc.getBlock.mockResolvedValue({ hash: 'other' });
    if (reason === 'permission-failure')
      approvals.mockRejectedValue(new Error('RPC unavailable'));
    if (reason === 'receipt-predates')
      rpc.getTransactionReceipt.mockResolvedValue({
        hash,
        blockNumber: 100,
        blockHash: hash,
        status: 1
      });
    if (reason === 'unknown-status')
      rpc.getTransactionReceipt.mockResolvedValue({
        hash,
        blockNumber: 101,
        blockHash: hash,
        status: null
      });
    await submitApprovalAttempt(row, hash);
    expect(operationSendAttempt(row)?.status).toBe('ACTIVE');
    expect(row.state).toBe('UNKNOWN');
  });
  it.each(['from', 'to', 'data', 'value', 'chainId', 'blockNumber'])(
    'rejects mismatching RPC %s without recording its hash',
    async (field) => {
      await begin();
      const bad = {
        ...transaction,
        hash,
        chainId: BigInt(1),
        value: BigInt(0),
        blockNumber: 101,
        [field]: (
          {
            from: transaction.to,
            to: wallet,
            data: '0xab',
            value: BigInt(1),
            chainId: BigInt(2),
            blockNumber: 100
          } as Record<string, unknown>
        )[field]
      };
      rpc.getTransaction.mockResolvedValue(bad);
      await expect(
        verifyAttemptTransaction(row, operationSendAttempt(row)!, hash)
      ).rejects.toThrow();
      expect(operationSendAttempt(row)?.transaction_hash).toBeUndefined();
    }
  );
  it('changes revision for same-millisecond attempt status changes', async () => {
    const before = marketOperationRevision(row);
    await begin();
    const active = marketOperationRevision(row);
    await rejectMarketSendAttempt(row, 'attempt', 'USER_REJECTED');
    expect(new Set([before, active, marketOperationRevision(row)]).size).toBe(
      3
    );
  });
});
