import { randomUUID } from 'node:crypto';
import { marketOperationsDb } from './market-operations.db';
import {
  marketOperationRevision,
  operationSendAttempt,
  reviewedTransactionDigest
} from './market-operation-state';
import {
  beginMarketSendAttempt,
  rejectMarketSendAttempt
} from './market-send-attempts';
import type { MarketTransaction } from './provider.types';

const wallet = '0x1111111111111111111111111111111111111111';
const transaction: MarketTransaction = {
  kind: 'TRANSACTION',
  chainId: 1,
  from: wallet,
  to: '0x2222222222222222222222222222222222222222',
  data: '0x1234',
  value: '0',
  purpose: 'APPROVE_NFT'
};
async function create() {
  const result = await marketOperationsDb.create({
    wallet,
    profileId: randomUUID(),
    key: randomUUID(),
    currency: transaction.to,
    request: {}
  });
  const row = result.operation;
  await marketOperationsDb.transition(row.id, ['PREPARING'], 'APPROVAL', {
    prepared: {
      approvalTransactions: [transaction],
      snapshot: { block_number: 100 }
    },
    expiresAt: Date.now() + 20000
  });
  return marketOperationsDb.get(row.id, row.profile_id);
}

describe('send attempt MySQL locking', () => {
  it('commits exactly one of two concurrent device sends and fences ordinary transitions', async () => {
    const row = await create();
    const base = {
      expected_revision: marketOperationRevision(row),
      transaction_digest: reviewedTransactionDigest(transaction),
      purpose: 'APPROVAL' as const
    };
    const results = await Promise.allSettled([
      beginMarketSendAttempt(row, { ...base, attempt_id: randomUUID() }),
      beginMarketSendAttempt(row, { ...base, attempt_id: randomUUID() })
    ]);
    expect(
      results.filter((result) => result.status === 'fulfilled')
    ).toHaveLength(1);
    const active = await marketOperationsDb.get(row.id, row.profile_id);
    expect(active.state).toBe('UNKNOWN');
    expect(operationSendAttempt(active)?.status).toBe('ACTIVE');
    await expect(
      marketOperationsDb.transition(row.id, ['UNKNOWN'], 'REVIEW')
    ).rejects.toMatchObject({ code: 'OPERATION_CHANGED' });
    await expect(
      marketOperationsDb.transition(row.id, ['UNKNOWN'], 'EXPIRED', {
        liabilityWei: '0'
      })
    ).rejects.toThrow();
  });
  it('allows concurrent retries of the same attempt without recording another send', async () => {
    const row = await create();
    const input = {
      expected_revision: marketOperationRevision(row),
      transaction_digest: reviewedTransactionDigest(transaction),
      purpose: 'APPROVAL' as const,
      attempt_id: randomUUID()
    };
    const results = await Promise.all([
      beginMarketSendAttempt(row, input),
      beginMarketSendAttempt(row, input)
    ]);
    expect(
      results.map((result) => operationSendAttempt(result)?.attempt_id)
    ).toEqual([input.attempt_id, input.attempt_id]);
  });
  it('rejects a stale revision inside the lock even if the operation remains in the same state', async () => {
    const row = await create();
    await marketOperationsDb.transition(row.id, ['APPROVAL'], 'APPROVAL', {
      prepared: {
        approvalTransactions: [transaction],
        snapshot: { block_number: 101 }
      }
    });
    await expect(
      beginMarketSendAttempt(row, {
        expected_revision: marketOperationRevision(row),
        transaction_digest: reviewedTransactionDigest(transaction),
        purpose: 'APPROVAL',
        attempt_id: randomUUID()
      })
    ).rejects.toMatchObject({ code: 'OPERATION_CHANGED' });
  });
  it('rejects stale rejection after another device durably attaches a transaction hash', async () => {
    const row = await create();
    const active = await beginMarketSendAttempt(row, {
      expected_revision: marketOperationRevision(row),
      transaction_digest: reviewedTransactionDigest(transaction),
      purpose: 'APPROVAL',
      attempt_id: randomUUID()
    });
    const attempt = operationSendAttempt(active)!;
    await marketOperationsDb.transition(row.id, ['UNKNOWN'], 'UNKNOWN', {
      expectedRevision: marketOperationRevision(active),
      expectedAttemptId: attempt.attempt_id,
      sendAttempt: { ...attempt, transaction_hash: `0x${'ab'.repeat(32)}` }
    });
    await expect(
      rejectMarketSendAttempt(active, attempt.attempt_id, 'USER_REJECTED')
    ).rejects.toThrow();
    expect(
      operationSendAttempt(await marketOperationsDb.get(row.id, row.profile_id))
    ).toMatchObject({
      status: 'ACTIVE',
      transaction_hash: `0x${'ab'.repeat(32)}`
    });
  });
  it('fences a delayed original begin after same-ID recovery and rejection, including same-millisecond updates', async () => {
    const row = await create();
    const input = {
      expected_revision: marketOperationRevision(row),
      transaction_digest: reviewedTransactionDigest(transaction),
      purpose: 'APPROVAL' as const,
      attempt_id: randomUUID()
    };
    const active = await beginMarketSendAttempt(row, input);
    const rejected = await rejectMarketSendAttempt(
      active,
      input.attempt_id,
      'WALLET_NOT_REQUESTED'
    );
    // The old HTTP request still holds its original REVIEW row and revision.
    const replayed = await beginMarketSendAttempt(row, input);
    expect(operationSendAttempt(replayed)?.status).toBe('REJECTED');
    expect(marketOperationRevision(replayed)).toBe(
      marketOperationRevision(rejected)
    );
    expect(Number(rejected.updated_at)).toBeGreaterThan(
      Number(active.updated_at)
    );
  });
  it('rolls back a new attempt when the saved-rule guard rejects before exposure', async () => {
    const row = await create();
    await expect(
      beginMarketSendAttempt(
        row,
        {
          expected_revision: marketOperationRevision(row),
          transaction_digest: reviewedTransactionDigest(transaction),
          purpose: 'APPROVAL',
          attempt_id: randomUUID()
        },
        async () => {
          throw new Error('Rule paused');
        }
      )
    ).rejects.toThrow('Rule paused');
    const saved = await marketOperationsDb.get(row.id, row.profile_id);
    expect(saved.state).toBe('APPROVAL');
    expect(operationSendAttempt(saved)).toBeUndefined();
  });
  it('records a no-wallet tombstone for an expired quote and fences any delayed original begin', async () => {
    const row = await create();
    await marketOperationsDb.transition(row.id, ['APPROVAL'], 'APPROVAL', {
      expiresAt: Date.now() - 1
    });
    const expired = await marketOperationsDb.get(row.id, row.profile_id);
    const input = {
      expected_revision: marketOperationRevision(expired),
      transaction_digest: reviewedTransactionDigest(transaction),
      purpose: 'APPROVAL' as const,
      attempt_id: randomUUID()
    };
    const rejected = await rejectMarketSendAttempt(
      expired,
      input.attempt_id,
      'WALLET_NOT_REQUESTED',
      input.expected_revision
    );
    expect(operationSendAttempt(rejected)?.status).toBe('REJECTED');
    // Replaying after the durable rejection returns terminal metadata, never ACTIVE.
    expect(
      operationSendAttempt(await beginMarketSendAttempt(rejected, input))
        ?.status
    ).toBe('REJECTED');
    await expect(beginMarketSendAttempt(expired, input)).rejects.toThrow();
  });
  it('serializes a no-wallet tombstone racing the original begin without leaving an active request', async () => {
    const row = await create();
    const input = {
      expected_revision: marketOperationRevision(row),
      transaction_digest: reviewedTransactionDigest(transaction),
      purpose: 'APPROVAL' as const,
      attempt_id: randomUUID()
    };
    await Promise.allSettled([
      beginMarketSendAttempt(row, input),
      rejectMarketSendAttempt(
        row,
        input.attempt_id,
        'WALLET_NOT_REQUESTED',
        input.expected_revision
      )
    ]);
    const latest = await marketOperationsDb.get(row.id, row.profile_id);
    expect(operationSendAttempt(latest)).toMatchObject({
      attempt_id: input.attempt_id,
      status: 'REJECTED'
    });
    expect(latest.expires_at).toBe(0);
  });
  it('requires the exact current revision and no conflicting active request for a tombstone', async () => {
    const row = await create();
    await expect(
      rejectMarketSendAttempt(
        row,
        randomUUID(),
        'WALLET_NOT_REQUESTED',
        'stale'
      )
    ).rejects.toThrow();
    expect(
      operationSendAttempt(await marketOperationsDb.get(row.id, row.profile_id))
    ).toBeUndefined();
    const active = await beginMarketSendAttempt(row, {
      expected_revision: marketOperationRevision(row),
      transaction_digest: reviewedTransactionDigest(transaction),
      purpose: 'APPROVAL',
      attempt_id: randomUUID()
    });
    await expect(
      rejectMarketSendAttempt(
        active,
        randomUUID(),
        'WALLET_NOT_REQUESTED',
        marketOperationRevision(active)
      )
    ).rejects.toThrow();
    expect(
      operationSendAttempt(await marketOperationsDb.get(row.id, row.profile_id))
        ?.status
    ).toBe('ACTIVE');
  });
});
