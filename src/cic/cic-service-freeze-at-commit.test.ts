import { CicStatementGroup } from '@/entities/ICICStatement';
import { profileActivityLogsDb } from '@/profileActivityLogs/profile-activity-logs.db';
import {
  expectCommitted,
  expectRefusedAtCommit,
  fakeTransactionalDb,
  freezeClock
} from '@/tests/fixtures/freeze-at-commit.fixture';
import { CicDb } from './cic.db';
import { CicService } from './cic.service';
import { AbusivenessCheckService } from '../profiles/abusiveness-check.service';

const STATEMENT = {
  id: 'statement-id',
  profile_id: 'profile-id',
  statement_group: CicStatementGroup.NFT_ACCOUNTS,
  statement_type: 'LINK',
  statement_comment: 'AOTM',
  statement_value: 'https://example.art/work'
};

/**
 * A profile statement service whose transaction is run by the real
 * my-sql.helpers on a fake connection. `onLock` runs at the profile lock
 * the write waits on.
 */
function setup(onLock: () => void) {
  const tx = fakeTransactionalDb();
  const db = {
    executeNativeQueriesInTransaction: tx.executeNativeQueriesInTransaction,
    lockProfileForCicStatementMutation: jest.fn(async () => onLock()),
    getCicStatementsByProfileId: jest.fn().mockResolvedValue([]),
    getCicStatementByIdAndProfileId: jest.fn().mockResolvedValue(STATEMENT),
    insertCicStatement: jest.fn(async (statement: object) => ({
      ...statement,
      id: STATEMENT.id,
      crated_at: new Date(0)
    })),
    deleteCicStatement: jest.fn()
  };
  jest
    .spyOn(profileActivityLogsDb, 'insert')
    .mockResolvedValue(undefined as any);
  const service = new CicService(
    db as unknown as CicDb,
    {} as AbusivenessCheckService
  );
  const add = () =>
    service.addCicStatement({
      statement: {
        profile_id: STATEMENT.profile_id,
        statement_group: STATEMENT.statement_group,
        statement_type: STATEMENT.statement_type,
        statement_comment: STATEMENT.statement_comment,
        statement_value: STATEMENT.statement_value
      },
      profile: {
        handle: 'someone',
        profile_id: STATEMENT.profile_id,
        classification: null
      }
    });
  const remove = () =>
    service.deleteCicStatement({
      profile_id: STATEMENT.profile_id,
      id: STATEMENT.id
    });
  return { tx, db, add, remove };
}

describe('a profile statement change admitted before the identity freeze that commits after it', () => {
  let clock: ReturnType<typeof freezeClock>;
  beforeEach(() => {
    clock = freezeClock();
  });
  afterEach(() => {
    clock.restore();
    jest.restoreAllMocks();
  });

  it('addCicStatement refuses at COMMIT and rolls the insert back', async () => {
    const { tx, db, add } = setup(() => clock.pass());
    await expectRefusedAtCommit(add(), tx.statements);
    expect(db.insertCicStatement).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ connection: tx.connection })
    );
  });

  it('deleteCicStatement refuses at COMMIT and rolls the delete back', async () => {
    const { tx, db, remove } = setup(() => clock.pass());
    await expectRefusedAtCommit(remove(), tx.statements);
    expect(db.deleteCicStatement).toHaveBeenCalledWith(
      { id: STATEMENT.id, profile_id: STATEMENT.profile_id },
      expect.objectContaining({ connection: tx.connection })
    );
  });

  it.each(['add', 'remove'] as const)(
    'commits a statement %s that ends before T',
    async (step) => {
      const fixture = setup(() => undefined);
      await fixture[step]();
      expectCommitted(fixture.tx.statements);
    }
  );
});
