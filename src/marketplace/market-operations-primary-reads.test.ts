import { DbPoolName, DbQueryOptions } from '@/db-query.options';
import { NotFoundException } from '@/exceptions';
import { ConnectionWrapper, SqlExecutor } from '@/sql-executor';
import {
  MarketOperationsDb,
  MarketOperationRow
} from '@/marketplace/market-operations.db';
import {
  MarketSendAttempt,
  operationSendAttempt
} from '@/marketplace/market-operation-state';

const wallet = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd';
const otherWallet = '0x1111111111111111111111111111111111111111';
const prepared = { transaction: { to: otherWallet, data: '0x1234' } };
const attempt: MarketSendAttempt = {
  attempt_id: 'attempt-1',
  purpose: 'TRANSACTION',
  transaction_digest: 'review-digest',
  transaction: {
    kind: 'TRANSACTION',
    chainId: 1,
    from: wallet,
    to: otherWallet,
    value: '0',
    data: '0x1234',
    purpose: 'FULFILL'
  },
  snapshot_block: 100,
  previous_state: 'REVIEW',
  status: 'ACTIVE'
};

function operation(
  patch: Partial<MarketOperationRow> = {}
): MarketOperationRow {
  return {
    id: 'operation-1',
    profile_id: 'profile-1',
    wallet,
    idempotency_key: 'request-1',
    request_hash: 'request-hash',
    state: 'PREPARING',
    request_json: '{}',
    prepared_json: null,
    send_attempt_json: null,
    transaction_hash: null,
    order_hash: null,
    liability_wei: '0',
    currency: otherWallet,
    error_code: null,
    created_at: 100,
    updated_at: 100,
    expires_at: 20100,
    ...patch
  };
}

interface JournalRow {
  operation_id: string;
  transaction_digest: string;
  prepared_json: unknown;
}

// Model committed writes that have not reached the read replica. Keep SQL
// predicates in the fixture so routing cannot accidentally bypass actor scope.
class LaggingReadReplica extends SqlExecutor {
  primary: MarketOperationRow[] = [];
  replica: MarketOperationRow[] = [];
  journal: JournalRow[] = [];

  async execute<T>(
    sql: string,
    params: Record<string, unknown> = {},
    options?: DbQueryOptions
  ): Promise<T[]> {
    const fromPrimary = options?.forcePool === DbPoolName.WRITE;
    if (
      sql.startsWith('SELECT prepared_json FROM market_reviewed_transactions')
    ) {
      expect(sql).toContain('operation_id=:id AND transaction_digest=:digest');
      return (fromPrimary ? this.journal : []).filter(
        (row) =>
          row.operation_id === params.id &&
          row.transaction_digest === params.digest
      ) as T[];
    }
    expect(sql).toMatch(
      /^SELECT \* FROM market_operations WHERE id = :id AND /
    );
    const rows = fromPrimary ? this.primary : this.replica;
    const actorScope = sql.includes(
      '(profile_id = :profileId OR wallet = :wallet)'
    );
    if (!actorScope) expect(sql).toContain('AND profile_id = :profileId');
    return rows.filter(
      (row) =>
        row.id === params.id &&
        (row.profile_id === params.profileId ||
          (actorScope && row.wallet === params.wallet))
    ) as T[];
  }

  async executeNativeQueriesInTransaction<T>(
    _executable: (connection: ConnectionWrapper<unknown>) => Promise<T>
  ): Promise<T> {
    throw new Error('This fixture only models reads after a committed write.');
  }
}

describe('market operation reads with replica lag', () => {
  let executor: LaggingReadReplica;
  let db: MarketOperationsDb;

  beforeEach(() => {
    executor = new LaggingReadReplica();
    db = new MarketOperationsDb(() => executor);
  });

  it('finds a just-created operation before it exists on the replica', async () => {
    const created = operation();
    executor.primary = [created];
    expect(executor.replica).toEqual([]);

    await expect(db.get(created.id, created.profile_id)).resolves.toEqual(
      created
    );
    await expect(
      db.getForActor(created.id, created.profile_id, wallet)
    ).resolves.toEqual(created);
  });

  it('returns the committed review instead of stale preparation data', async () => {
    const reviewed = operation({
      state: 'REVIEW',
      prepared_json: JSON.stringify(prepared),
      updated_at: 101
    });
    executor.primary = [reviewed];
    executor.replica = [operation()];

    await expect(db.get(reviewed.id, reviewed.profile_id)).resolves.toEqual(
      reviewed
    );
    await expect(
      db.getForActor(reviewed.id, reviewed.profile_id, wallet)
    ).resolves.toEqual(reviewed);
  });

  it('returns the armed send attempt instead of a stale actionable review', async () => {
    const armed = operation({
      state: 'UNKNOWN',
      prepared_json: JSON.stringify(prepared),
      send_attempt_json: JSON.stringify(attempt),
      updated_at: 102
    });
    executor.primary = [armed];
    executor.replica = [
      operation({ state: 'REVIEW', prepared_json: prepared })
    ];

    const rows = await Promise.all([
      db.get(armed.id, armed.profile_id),
      db.getForActor(armed.id, armed.profile_id, wallet)
    ]);
    for (const row of rows) {
      expect(row.state).toBe('UNKNOWN');
      expect(operationSendAttempt(row)).toEqual(attempt);
    }
  });

  it('preserves profile access and signing-wallet recovery after a profile move', async () => {
    const row = operation();
    executor.primary = [row];
    await expect(
      db.getForActor(row.id, row.profile_id, otherWallet)
    ).resolves.toEqual(row);
    await expect(
      db.getForActor(row.id, 'new-profile', wallet.toUpperCase())
    ).resolves.toEqual(row);
    await expect(db.get(row.id, 'new-profile')).rejects.toBeInstanceOf(
      NotFoundException
    );
    await expect(
      db.getForActor(row.id, 'other-profile', otherWallet)
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      db.get('other-operation', row.profile_id)
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      db.getForActor('other-operation', row.profile_id, wallet)
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('finds the newly committed immutable review by exact operation and digest', async () => {
    executor.journal = [
      {
        operation_id: 'operation-1',
        transaction_digest: 'review-digest',
        prepared_json: JSON.stringify(prepared)
      }
    ];

    await expect(
      db.reviewedTransaction('operation-1', 'review-digest')
    ).resolves.toBe(JSON.stringify(prepared));
    await expect(
      db.reviewedTransaction('other-operation', 'review-digest')
    ).resolves.toBeUndefined();
    await expect(
      db.reviewedTransaction('operation-1', 'other-digest')
    ).resolves.toBeUndefined();
  });
});
