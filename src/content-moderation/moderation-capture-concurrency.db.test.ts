import { dbSupplier, sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import { ModerationReviewDb } from './moderation-review.db';
import { ModerationInput } from './moderation-review.types';
import { CONTENT_MODERATION_EVALUATIONS_TABLE as EVALUATIONS } from '@/constants';

const input: ModerationInput = {
  subject_type: 'REP_CATEGORY',
  subject_id: 'Builder',
  author_profile_id: null,
  actor_profile_id: 'actor',
  operation: 'CLASSIFY',
  policy_family: 'PUBLIC_FIELDS',
  policy_version: 'test',
  scope: {},
  evidence: { text: 'Builder' }
};

describeWithSeed('moderation capture concurrency', [], () => {
  let db: ModerationReviewDb;
  beforeEach(() => {
    db = new ModerationReviewDb(dbSupplier);
  });
  afterEach(() => jest.restoreAllMocks());

  it('rolls back partial capture before retrying a server deadlock error', async () => {
    const execute = sqlExecutor.execute.bind(sqlExecutor);
    let injected = false;
    jest
      .spyOn(sqlExecutor, 'execute')
      .mockImplementation(async (sql, params, options) => {
        if (!injected && sql.startsWith(`insert into ${EVALUATIONS}`)) {
          injected = true;
          // Exercise the real driver, budget owner and rollback after item insertion.
          return execute(
            "SIGNAL SQLSTATE '40001' SET MYSQL_ERRNO=1213, MESSAGE_TEXT='synthetic deadlock'",
            {},
            options
          );
        }
        return execute(sql, params, options);
      });
    const check = await db.start(input, 'PUBLIC_FIELD');
    expect(injected).toBe(true);
    expect(
      await sqlExecutor.execute(
        `select id from ${EVALUATIONS} where item_id=:id`,
        { id: check.item.id }
      )
    ).toEqual([{ id: check.evaluationId }]);
    expect(check.item.version).toBe(1);
  });

  it('bounds a held item lock without replaying an unacknowledged cleanup', async () => {
    const check = await db.start(input, 'PUBLIC_FIELD');
    const started = Date.now();
    await db.executeNativeQueriesInTransaction(async (connection) => {
      await db.get(check.item.id, { connection }, true);
      const error = await db
        .start(input, 'PUBLIC_FIELD')
        .catch((failure) => failure);
      expect(error.getStatusCode()).toBe(503);
      expect(error.message).not.toContain('Builder');
    });
    expect(Date.now() - started).toBeLessThan(5000);
    expect(
      await sqlExecutor.execute(
        `select id from ${EVALUATIONS} where item_id=:id`,
        { id: check.item.id }
      )
    ).toHaveLength(1);
  });

  it('retains every concurrent same-category evaluation and the latest result', async () => {
    const checks = await Promise.all(
      Array.from({ length: 20 }, async (_, i) => {
        const check = await db.start(
          { ...input, actor_profile_id: `actor-${i}` },
          'PUBLIC_FIELD'
        );
        await db.finish(check.evaluationId, {
          outcome: i % 2 ? 'ALLOW' : 'REJECT',
          result: { status: i }
        });
        return check;
      })
    );
    expect(new Set(checks.map((check) => check.item.id)).size).toBe(1);
    const evaluations = await sqlExecutor.execute<{
      id: string;
      outcome: string;
      completed_at: number | null;
    }>(
      `select id,outcome,completed_at from ${EVALUATIONS} where item_id=:id order by started_at desc,id desc`,
      { id: checks[0].item.id }
    );
    expect(evaluations).toHaveLength(20);
    expect(evaluations.every((row) => row.completed_at !== null)).toBe(true);
    expect((await db.get(checks[0].item.id)).outcome).toBe(
      evaluations[0].outcome
    );
  });

  it('does not hold an evaluation lock while waiting for its item', async () => {
    const check = await db.start(input, 'PUBLIC_FIELD');
    await sqlExecutor.execute(
      `update ${EVALUATIONS} set started_at=1 where id=:id`,
      { id: check.evaluationId }
    );
    const newer = await db.start(input, 'PUBLIC_FIELD');
    let reachedItem!: () => void;
    const waiting = new Promise<void>((resolve) => {
      reachedItem = resolve;
    });
    const get = db.get.bind(db);
    const spy = jest.spyOn(db, 'get').mockImplementation((id, ctx, lock) => {
      if (lock) reachedItem();
      return get(id, ctx, lock);
    });
    let completion: Promise<void> | undefined;
    try {
      await db.executeNativeQueriesInTransaction(async (connection) => {
        await get(check.item.id, { connection }, true);
        completion = db.finish(check.evaluationId, {
          outcome: 'ALLOW',
          result: {}
        });
        // Observe rejection immediately, even if the assertion below fails.
        void completion.catch(() => {});
        await waiting;
        // Would fail immediately if the waiting finalizer had locked its evaluation
        // first. No timing-based sleep or lock-timeout assumption is needed.
        await sqlExecutor.execute(
          `select id from ${EVALUATIONS} where id=:id for update nowait`,
          { id: check.evaluationId },
          { wrappedConnection: connection }
        );
        await db.finish(
          newer.evaluationId,
          { outcome: 'REJECT', result: {} },
          { connection }
        );
      });
      await completion;
      // The older finalizer's ownership read predates this commit. Its later
      // current-read update must still preserve the newer completed decision.
      expect((await db.get(check.item.id)).outcome).toBe('REJECT');
    } finally {
      spy.mockRestore();
      await completion?.catch(() => {});
    }
  });

  it('rechecks stale candidates so retention cannot overwrite a completed evaluation', async () => {
    const check = await db.start(input, 'PUBLIC_FIELD');
    await sqlExecutor.execute(
      `update ${EVALUATIONS} set started_at=1 where id=:id`,
      { id: check.evaluationId }
    );
    const execute = sqlExecutor.execute.bind(sqlExecutor);
    let raced = false;
    jest
      .spyOn(sqlExecutor, 'execute')
      .mockImplementation(async (sql, params, options) => {
        const result = await execute(sql, params, options);
        if (
          !raced &&
          sql.startsWith(
            `select id,item_id from ${EVALUATIONS} where completed_at`
          )
        ) {
          raced = true;
          await db.finish(check.evaluationId, {
            outcome: 'REJECT',
            result: { status: 'DISALLOWED' }
          });
        }
        return result;
      });
    await db.retain();
    expect(raced).toBe(true);
    expect((await db.get(check.item.id)).outcome).toBe('REJECT');
    const evaluation = await sqlExecutor.oneOrNull<{
      outcome: string;
      fallback: string | null;
    }>(`select outcome,fallback from ${EVALUATIONS} where id=:id`, {
      id: check.evaluationId
    });
    expect(evaluation).toEqual({ outcome: 'REJECT', fallback: null });
  });
});
