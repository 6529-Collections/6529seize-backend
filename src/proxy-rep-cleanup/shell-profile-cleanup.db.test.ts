import { DataSource, QueryRunner } from 'typeorm';
import * as Entities from '@/entities/entities';
import { describeWithSeed } from '@/tests/_setup/seed';
import { anIdentity, withIdentities } from '@/tests/fixtures/identity.fixture';
import { aProfile, withProfiles } from '@/tests/fixtures/profile.fixture';
import { aRepRating, withRatings } from '@/tests/fixtures/rating.fixture';
import {
  executeShellProfileCleanup,
  inspectShellProfileCleanup
} from './shell-profile-cleanup';

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

const SHELLS = {
  empty: { id: '11111111-1111-4111-8111-111111111111', wallet: '0xa1' },
  ratedByOther: { id: '22222222-2222-4222-8222-222222222222', wallet: '0xa2' },
  loggedIn: { id: '33333333-3333-4333-8333-333333333333', wallet: '0xa3' },
  edited: { id: '44444444-4444-4444-8444-444444444444', wallet: '0xa4' }
};
const CLAIMED = { id: '55555555-5555-4555-8555-555555555555', wallet: '0xa5' };
const ALL = [...Object.values(SHELLS), CLAIMED];

function handleOf(key: { id: string; wallet: string }) {
  return key === CLAIMED ? 'RealCollector' : `id-${key.wallet}`;
}

function log(id: string, profileId: string, type: string) {
  return {
    id,
    profile_id: profileId,
    target_id: null,
    proxy_id: null,
    type,
    contents: {},
    created_at: new Date('2025-07-30T00:00:00Z')
  };
}

const seeds = [
  withProfiles(
    ALL.map((key) =>
      aProfile({
        external_id: key.id,
        handle: handleOf(key),
        primary_wallet: key.wallet
      })
    )
  ),
  {
    table: 'profiles_archive',
    rows: ALL.map((key) => ({
      external_id: key.id,
      handle: handleOf(key),
      normalised_handle: handleOf(key).toLowerCase(),
      primary_wallet: key.wallet,
      created_by_wallet: key.wallet,
      created_at: new Date('2025-07-30T00:00:00Z')
    }))
  },
  withIdentities(
    ALL.map((key) =>
      anIdentity(
        { sub_classification: null },
        {
          consolidation_key: key.wallet,
          profile_id: key.id,
          primary_address: key.wallet,
          handle: handleOf(key)
        }
      )
    )
  ),
  {
    table: 'address_consolidation_keys',
    rows: ALL.map((key) => ({
      address: key.wallet,
      consolidation_key: key.wallet
    }))
  },
  {
    table: 'profile_activity_logs',
    rows: [
      ...ALL.map((key, i) => log(`created-${i}`, key.id, 'PROFILE_CREATED')),
      log('pfp', SHELLS.edited.id, 'PFP_EDIT')
    ]
  },
  {
    table: 'profile_latest_logs',
    rows: ALL.map((key) => ({
      profile_id: key.id,
      latest_activity: new Date('2025-07-30T00:00:00Z')
    }))
  },
  withRatings([
    aRepRating({
      rater_profile_id: 'someone-else',
      matter_target_id: SHELLS.ratedByOther.id,
      matter_category: 'Friend',
      rating: 0
    })
  ]),
  {
    table: 'refresh_tokens',
    rows: [
      { address: SHELLS.loggedIn.wallet, refresh_token: 'token', role: null }
    ]
  }
];

describeWithSeed('shell profile cleanup', seeds, () => {
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

  it('keeps every shell that something else refers to', async () => {
    const { plan, shells } = await inspectShellProfileCleanup(
      runner,
      ALL.map((key) => key.id)
    );
    expect(shells).toEqual([
      { profile_id: SHELLS.empty.id, address: SHELLS.empty.wallet }
    ]);
    expect(plan.counts).toEqual({
      source_targets: 5,
      shell_candidates: 4,
      referenced_elsewhere: 3,
      shells: 1
    });
    expect(plan.referenced_by).toEqual({
      'own activity': 1,
      'ratings.matter_target_id': 1,
      'refresh_tokens.address': 1
    });
  });

  it('deletes only the planned shell rows and is safe to re-run', async () => {
    const { plan, shells } = await inspectShellProfileCleanup(
      runner,
      ALL.map((key) => key.id)
    );
    const backup: Record<string, unknown[]> = {};
    const sink = {
      write(table: string, rows: readonly object[]) {
        backup[table] = [...(backup[table] ?? []), ...rows];
      }
    };
    const result = await executeShellProfileCleanup(runner, plan, shells, sink);
    expect(result).toEqual({
      shells_deleted: 1,
      shells_skipped: 0,
      rows_deleted: {
        profile_activity_logs: 1,
        profile_latest_logs: 1,
        profile_total_rep_score_aggregations: 0,
        profiles_archive: 1,
        profiles: 1,
        address_consolidation_keys: 1,
        identities: 1
      }
    });
    const remaining: { external_id: string }[] = await runner.query(
      'SELECT external_id FROM profiles ORDER BY external_id'
    );
    expect(remaining.map((row) => row.external_id)).toEqual(
      ALL.filter((key) => key !== SHELLS.empty)
        .map((key) => key.id)
        .sort()
    );
    expect(
      await runner.query(
        'SELECT profile_id FROM identities WHERE profile_id = ?',
        [SHELLS.empty.id]
      )
    ).toEqual([]);
    expect(backup.profiles).toHaveLength(1);
    expect(backup.identities).toHaveLength(1);

    const again = await executeShellProfileCleanup(runner, plan, shells, sink);
    expect(again.shells_deleted).toBe(0);
    expect(again.shells_skipped).toBe(1);
  });

  it('skips a planned shell that became active before execution', async () => {
    const { plan, shells } = await inspectShellProfileCleanup(
      runner,
      ALL.map((key) => key.id)
    );
    await runner.query(
      'INSERT INTO refresh_tokens (address, refresh_token) VALUES (?, ?)',
      [SHELLS.empty.wallet, 'token']
    );
    const result = await executeShellProfileCleanup(runner, plan, shells, {
      write: () => undefined
    });
    expect(result.shells_deleted).toBe(0);
    expect(result.shells_skipped).toBe(1);
  });
});
