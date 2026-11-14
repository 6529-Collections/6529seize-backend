import { DataSource, QueryRunner } from 'typeorm';
import * as Entities from '@/entities/entities';
import { describeWithSeed } from '@/tests/_setup/seed';
import { aRepRating, withRatings } from '@/tests/fixtures/rating.fixture';
import { anIdentity, withIdentities } from '@/tests/fixtures/identity.fixture';
import {
  executeProxyRepRollback,
  inspectProxyRepRollback
} from './proxy-rep-rollback';

const GRANTOR = 'grantor-profile';
const GRANTEE = 'grantee-profile';
const OTHER_RATER = 'other-rater';

function source() {
  return new DataSource({
    type: 'mysql',
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT),
    username: process.env.DB_USER,
    password: process.env.DB_PASS,
    database: process.env.DB_NAME,
    charset: 'utf8mb4',
    timezone: 'Z',
    entities: Object.values(Entities).filter(
      (entity) => typeof entity === 'function'
    ),
    synchronize: false
  });
}

function identity(profileId: string, rep: number, tdh = 0) {
  return anIdentity(
    { rep, tdh, level_raw: rep + tdh },
    {
      consolidation_key: `0x${profileId}`,
      profile_id: profileId,
      primary_address: `0x${profileId}`,
      handle: profileId
    }
  );
}

function ratingLog(
  id: string,
  category: string,
  proxyId: string | null,
  target = 'target-1'
) {
  return {
    id,
    profile_id: GRANTOR,
    target_id: target,
    proxy_id: proxyId,
    type: 'RATING_EDIT',
    contents: {
      old_rating: 0,
      new_rating: 1,
      rating_matter: 'REP',
      rating_category: category,
      change_reason: 'USER_EDIT'
    },
    additional_data_1: 'REP',
    additional_data_2: category,
    created_at: new Date('2024-08-01T00:00:00Z')
  };
}

function repNotification(target: string, category: string) {
  return {
    identity_id: target,
    additional_identity_id: GRANTOR,
    cause: 'IDENTITY_REP',
    additional_data: { amount: 1, rater_rating: 1, total: 1, category },
    created_at: 1,
    read_at: null,
    related_drop_id: null,
    related_drop_part_no: null,
    related_drop_2_id: null,
    related_drop_2_part_no: null,
    visibility_group_id: null,
    wave_id: null
  };
}

const seeds = [
  {
    table: 'profile_proxies',
    rows: [
      { id: 'proxy-1', target_id: GRANTEE, created_by: GRANTOR, created_at: 1 }
    ]
  },
  {
    table: 'profile_proxy_actions',
    rows: [
      {
        id: 'action-1',
        proxy_id: 'proxy-1',
        action_type: 'ALLOCATE_REP',
        credit_amount: 1000,
        credit_spent: 8,
        created_at: 1,
        start_time: 1,
        end_time: null,
        accepted_at: 1,
        rejected_at: null,
        revoked_at: 2,
        is_active: false
      }
    ]
  },
  withRatings([
    aRepRating({
      rater_profile_id: GRANTOR,
      matter_target_id: 'target-1',
      matter_category: 'A Holder',
      rating: 5
    }),
    aRepRating({
      rater_profile_id: GRANTOR,
      matter_target_id: 'target-1',
      matter_category: 'B Holder',
      rating: 0
    }),
    aRepRating({
      rater_profile_id: GRANTOR,
      matter_target_id: 'target-2',
      matter_category: 'A Holder',
      rating: 3
    }),
    aRepRating({
      rater_profile_id: GRANTOR,
      matter_target_id: 'target-2',
      matter_category: 'Manual',
      rating: 7
    }),
    aRepRating({
      rater_profile_id: OTHER_RATER,
      matter_target_id: 'target-1',
      matter_category: 'A Holder',
      rating: 2
    }),
    aRepRating({
      rater_profile_id: GRANTOR,
      matter_target_id: 'target-3',
      matter_category: 'Hand Picked',
      rating: 4
    }),
    aRepRating({
      rater_profile_id: GRANTOR,
      matter_target_id: 'target-4',
      matter_category: 'A Holder',
      rating: 1
    })
  ]),
  withIdentities([
    identity('target-1', 7, 100),
    identity('target-2', 10),
    identity('target-3', 4),
    identity('target-4', 1)
  ]),
  {
    table: 'profile_total_rep_score_aggregations',
    rows: [
      { profile_id: 'target-1', score: 7, rater_count: 2 },
      { profile_id: 'target-2', score: 10, rater_count: 2 },
      { profile_id: 'target-3', score: 4, rater_count: 1 },
      { profile_id: 'target-4', score: 1, rater_count: 1 }
    ]
  },
  {
    table: 'profile_activity_logs',
    rows: [
      ratingLog('log-1', 'A Holder', GRANTEE),
      ratingLog('log-2', 'A Holder', GRANTEE, 'target-2'),
      ratingLog('log-3', 'B Holder', GRANTEE),
      ratingLog('log-4', 'Manual', GRANTEE, 'target-2'),
      ratingLog('log-5', 'Manual', null, 'target-2'),
      ratingLog('log-6', 'Hand Picked', null, 'target-3')
    ]
  },
  {
    table: 'identity_notifications',
    rows: [
      repNotification('target-1', 'A Holder'),
      repNotification('target-2', 'A Holder'),
      repNotification('target-2', 'Manual')
    ]
  },
  {
    table: 'profile_proxy_rating_credit_balances',
    rows: [
      {
        proxy_action_id: 'action-1',
        matter: 'REP',
        matter_target_id: 'target-1',
        matter_category: 'A Holder',
        credit_spent_outstanding: 5,
        created_at: 1,
        updated_at: 1
      }
    ]
  }
];

describeWithSeed('proxy REP rollback', seeds, () => {
  let db: DataSource;
  let runner: QueryRunner;
  beforeAll(async () => {
    db = await source().initialize();
  });
  afterAll(async () => {
    await db.destroy();
  });
  beforeEach(() => {
    runner = db.createQueryRunner('master');
  });
  afterEach(async () => {
    await runner.release();
  });

  it('plans only categories this proxy alone wrote', async () => {
    const { plan, targets } = await inspectProxyRepRollback(runner, 'proxy-1');
    expect(plan.categories).toEqual(['A Holder', 'B Holder']);
    expect(plan.skipped_categories).toEqual(['Manual']);
    expect(targets).toEqual(['target-1', 'target-2', 'target-4']);
    expect(plan.counts).toEqual({
      rating_rows: 4,
      nonzero_rating_rows: 3,
      rep_sum: 9,
      targets: 3,
      activity_logs: 3,
      notifications: 2,
      credit_balance_rows: 1
    });
  });

  it('removes the proxy REP silently and leaves everything else', async () => {
    const { plan, targets } = await inspectProxyRepRollback(runner, 'proxy-1');
    const backup: Record<string, unknown[]> = {};
    const sink = {
      write(table: string, rows: readonly object[]) {
        backup[table] = [...(backup[table] ?? []), ...rows];
      }
    };
    const result = await executeProxyRepRollback(runner, plan, targets, sink, {
      batchSize: 1
    });
    expect(result).toEqual({
      rating_rows: 4,
      rep_removed: 9,
      identities_updated: 3,
      aggregation_rows_deleted: 1,
      notifications: 2,
      activity_logs: 3,
      credit_balance_rows: 1
    });
    expect(
      await runner.query(
        'SELECT rater_profile_id, matter_target_id, matter_category, rating FROM ratings ORDER BY matter_target_id, rater_profile_id'
      )
    ).toEqual([
      {
        rater_profile_id: OTHER_RATER,
        matter_target_id: 'target-1',
        matter_category: 'A Holder',
        rating: 2
      },
      {
        rater_profile_id: GRANTOR,
        matter_target_id: 'target-2',
        matter_category: 'Manual',
        rating: 7
      },
      {
        rater_profile_id: GRANTOR,
        matter_target_id: 'target-3',
        matter_category: 'Hand Picked',
        rating: 4
      }
    ]);
    expect(
      await runner.query(
        'SELECT profile_id, rep, level_raw FROM identities ORDER BY profile_id'
      )
    ).toEqual([
      { profile_id: 'target-1', rep: 2, level_raw: 102 },
      { profile_id: 'target-2', rep: 7, level_raw: 7 },
      { profile_id: 'target-3', rep: 4, level_raw: 4 },
      { profile_id: 'target-4', rep: 0, level_raw: 0 }
    ]);
    expect(
      await runner.query(
        'SELECT profile_id, score, rater_count FROM profile_total_rep_score_aggregations ORDER BY profile_id'
      )
    ).toEqual([
      { profile_id: 'target-1', score: 2, rater_count: 1 },
      { profile_id: 'target-2', score: 7, rater_count: 1 },
      { profile_id: 'target-3', score: 4, rater_count: 1 }
    ]);
    expect(
      await runner.query('SELECT id FROM profile_activity_logs ORDER BY id')
    ).toEqual([{ id: 'log-4' }, { id: 'log-5' }, { id: 'log-6' }]);
    expect(
      await runner.query(
        `SELECT JSON_UNQUOTE(JSON_EXTRACT(additional_data, '$.category')) AS category FROM identity_notifications`
      )
    ).toEqual([{ category: 'Manual' }]);
    expect(
      await runner.query('SELECT * FROM profile_proxy_rating_credit_balances')
    ).toEqual([]);
    expect(await runner.query('SELECT * FROM events')).toEqual([]);
    expect(backup.ratings).toHaveLength(4);
    expect(backup.profile_activity_logs).toHaveLength(3);

    const again = await executeProxyRepRollback(runner, plan, targets, sink);
    expect(again.rating_rows).toBe(0);
    expect(again.rep_removed).toBe(0);
  });

  it('refuses while the grantor has unprocessed REP events', async () => {
    await runner.query(
      `INSERT INTO events (type, status, data, created_at) VALUES ('PROFILE_REP_RATE', 'NEW', ?, 1)`,
      [JSON.stringify({ rater_profile_id: GRANTOR })]
    );
    await expect(inspectProxyRepRollback(runner, 'proxy-1')).rejects.toThrow(
      'unprocessed'
    );
  });

  it('refuses a proxy that can still rate', async () => {
    await runner.query(
      'UPDATE profile_proxy_actions SET revoked_at = NULL WHERE id = ?',
      ['action-1']
    );
    await expect(inspectProxyRepRollback(runner, 'proxy-1')).rejects.toThrow(
      'Revoke every ALLOCATE_REP action'
    );
  });

  it('refuses when categories were edited by hand after planning', async () => {
    const { plan, targets } = await inspectProxyRepRollback(runner, 'proxy-1');
    await runner.query(
      `INSERT INTO profile_activity_logs (id, profile_id, target_id, proxy_id, type, contents, created_at)
       VALUES ('log-late', ?, 'target-1', NULL, 'RATING_EDIT', ?, ?)`,
      [
        GRANTOR,
        JSON.stringify({
          rating_matter: 'REP',
          rating_category: 'A Holder',
          change_reason: 'USER_EDIT'
        }),
        new Date(plan.planned_at + 60_000)
      ]
    );
    await expect(
      executeProxyRepRollback(runner, plan, targets, { write: () => undefined })
    ).rejects.toThrow('edited by others after planning');
  });
});
