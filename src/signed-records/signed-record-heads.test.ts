import type { SqlExecutor } from '@/sql-executor';
import {
  RecordChange,
  RecordIndexer,
  RecordRegistry,
  RecordRuleError,
  SenderKeyring
} from './record-index';
import {
  SavepointRollbackError,
  SignedRecordHeadsDb
} from './signed-record-heads.db';

/** An executor that records each statement and fails the rollback. */
function failingRollbackExecutor(statements: string[]): SqlExecutor {
  return {
    execute: async (sql: string) => {
      statements.push(sql.trim().split(/\s+/).slice(0, 3).join(' '));
      if (/rollback to savepoint/i.test(sql)) {
        throw new Error('connection lost');
      }
      return [];
    }
  } as unknown as SqlExecutor;
}

const callerCtx = { connection: {} as never };

describe("SignedRecordHeadsDb in the caller's transaction", () => {
  it('throws an infrastructure error, caused by the refusal, when the rollback fails', async () => {
    const statements: string[] = [];
    const db = new SignedRecordHeadsDb(() =>
      failingRollbackExecutor(statements)
    );
    const refusal = new RecordRuleError('A rule refuses it', 'TEST_RULE');
    const thrown = await db
      .inTransaction(callerCtx, async () => {
        throw refusal;
      })
      .catch((error: unknown) => error);
    expect(thrown).toBeInstanceOf(SavepointRollbackError);
    expect(thrown).not.toBeInstanceOf(RecordRuleError);
    expect((thrown as SavepointRollbackError).cause).toBe(refusal);
    expect((thrown as Error).message).toContain('connection lost');
    expect(statements).toEqual([
      'savepoint signed_record_1',
      'rollback to savepoint'
    ]);
  });

  it('so the indexer never reports that record as a clean refusal', async () => {
    const db = new SignedRecordHeadsDb(() => failingRollbackExecutor([]));
    const registry = new RecordRegistry();
    registry.register({
      family: 'ps',
      type: 'follow',
      sealed: false,
      validate: () => undefined,
      apply: async () => {
        throw new RecordRuleError('A rule refuses it', 'TEST_RULE');
      }
    });
    const indexer = new RecordIndexer({
      registry,
      heads: db,
      keyring: new SenderKeyring([])
    });
    const change: RecordChange = {
      owner: `0x${'0'.repeat(63)}1`,
      family: 'ps',
      type: 'follow',
      key: 'p',
      body: {},
      order: { anchor: 1, claimedTime: 1, eventId: `0x${'a'.repeat(64)}` },
      eventId: null,
      sealedClass: null,
      writer: 'author'
    };
    await expect(
      indexer.ingestImported([change], false, 'live', callerCtx)
    ).rejects.toBeInstanceOf(SavepointRollbackError);
  });
});
