import 'reflect-metadata';
import {
  COMPETITION_ENTRIES_TABLE,
  COMPETITION_VOTES_TABLE,
  COMPETITIONS_TABLE,
  DROPS_TABLE,
  EVENTS_TABLE,
  IDENTITIES_TABLE,
  IDENTITY_NOTIFICATIONS_TABLE,
  PROFILE_TOTAL_REP_SCORE_AGGREGATIONS_TABLE,
  PROFILES_ACTIVITY_LOGS_TABLE,
  RATINGS_TABLE,
  REP_RATING_REMOVALS_TABLE
} from '@/constants';
import { appFeatures } from '@/app-features';
import { nativeCompetitionRuntimeRepository } from '@/competitions/native-competition-runtime.repository';
import { revokeRepBasedDropOverVotes } from '@/drops/participation-drops-over-vote-revocation';
import { ProfileActivityLogType } from '@/entities/IProfileActivityLog';
import { identityMetricsSync } from '@/identity-metrics-sync';
import { ratingsDb } from '@/rates/ratings.db';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import { anIdentity, withIdentities } from '@/tests/fixtures/identity.fixture';
import { aProfile, withProfiles } from '@/tests/fixtures/profile.fixture';
import { aRepRating, withRatings } from '@/tests/fixtures/rating.fixture';
import {
  aTdhConsolidation,
  withTdhConsolidations
} from '@/tests/fixtures/tdh_consolidation.fixture';
import { aWave, withWaves } from '@/tests/fixtures/wave.fixture';
import {
  RepChange,
  RepRatingsRemovalApplyResult,
  RepRatingsRemovalDeps,
  RepRatingsRemovalDryRunResult,
  RepRatingsRemovalJob,
  STOP_MARGIN_MILLIS
} from './rep-ratings-removal';
import { repRatingsRemovalOvervotePreview } from './rep-ratings-removal-overvotes';
import { RepRatingsRemovalDb } from './rep-ratings-removal.db';
import {
  parseRepRatingsRemovalRequest,
  REP_RATINGS_REMOVE_JOB
} from './rep-ratings-removal.request';

// Synthetic profiles. Targets sort T1 < T2 < ... in binary order.
const RATER = 'bbbbbbbb-0000-4000-8000-000000000001';
const OTHER_RATER = 'bbbbbbbb-0000-4000-8000-000000000002';
const BOT = 'bbbbbbbb-0000-4000-8000-000000000003';
const T1 = 'bbbbbbbb-0000-4000-8000-000000000011';
const T2 = 'bbbbbbbb-0000-4000-8000-000000000012';
const T3 = 'bbbbbbbb-0000-4000-8000-000000000013';
const T4 = 'bbbbbbbb-0000-4000-8000-000000000014';
// T5 has no identity row.
const T5 = 'bbbbbbbb-0000-4000-8000-000000000015';
const ALPHA = 'Tag Alpha';
const BETA = 'Tag Beta';
const PERSONAL = 'Personal Note';
const HELP_CREDITS = 'Help6529 Credits';
const BOT_HANDLE = 'help6529';
const NOW = 1_700_000_000_000;
const FAR_FUTURE = '2100-01-01T00:00:00Z';
const TDH = 1000;

function address(n: number): string {
  return `0x${n.toString(16).padStart(40, '0')}`;
}

/** Identity values as the identity sync leaves them: level = REP + TDH. */
function identity(profileId: string, n: number, handle: string, rep: number) {
  return anIdentity(
    { rep, tdh: TDH, level_raw: rep + TDH, basetdh_rate: 1 },
    {
      profile_id: profileId,
      consolidation_key: address(n),
      primary_address: address(n),
      handle
    }
  );
}

function tdh(n: number) {
  return aTdhConsolidation([address(n)], {
    boosted_tdh: TDH,
    boosted_tdh_rate: 1
  });
}

function rating(
  rater: string,
  target: string,
  category: string,
  value: number
) {
  return aRepRating({
    rater_profile_id: rater,
    matter_target_id: target,
    matter_category: category,
    rating: value
  });
}

let logId = 0;
function ratingLog(
  rater: string,
  target: string,
  matter: string,
  category: string
) {
  logId++;
  return {
    id: `log-${String(logId).padStart(3, '0')}`,
    profile_id: rater,
    target_id: target,
    proxy_id: null,
    contents: JSON.stringify({ old_rating: 0, new_rating: 1 }),
    type: ProfileActivityLogType.RATING_EDIT,
    additional_data_1: matter,
    additional_data_2: category,
    created_at: new Date('2024-01-01T00:00:00Z')
  };
}

const seeds = [
  withProfiles([
    aProfile({
      external_id: RATER,
      handle: 'raterone',
      primary_wallet: address(1)
    }),
    aProfile({
      external_id: OTHER_RATER,
      handle: 'ratertwo',
      primary_wallet: address(2)
    }),
    aProfile({
      external_id: BOT,
      handle: BOT_HANDLE,
      primary_wallet: address(3)
    })
  ]),
  withIdentities([
    identity(RATER, 1, 'raterone', 0),
    identity(OTHER_RATER, 2, 'ratertwo', 0),
    identity(BOT, 3, BOT_HANDLE, 0),
    // REP is the sum of each target's REP ratings below.
    identity(T1, 11, 'alice', 101),
    identity(T2, 12, 'bob', 27),
    identity(T3, 13, `id-${address(13)}`, 12),
    identity(T4, 14, `id-${address(14)}`, -3)
  ]),
  withTdhConsolidations([1, 2, 3, 11, 12, 13, 14].map(tdh)),
  withRatings([
    rating(RATER, T1, ALPHA, 10),
    rating(RATER, T2, ALPHA, 20),
    rating(RATER, T3, ALPHA, 5),
    rating(RATER, T4, ALPHA, -3),
    rating(RATER, T5, ALPHA, 7),
    rating(RATER, T1, BETA, 1),
    rating(RATER, T2, BETA, 2),
    rating(RATER, T3, BETA, 3),
    rating(RATER, T4, BETA, 0),
    // Out of scope for the rater's run: another category, another rater.
    rating(RATER, T1, PERSONAL, 50),
    rating(OTHER_RATER, T1, ALPHA, 40),
    // The help bot's credits, written without rating events.
    rating(BOT, T2, HELP_CREDITS, 5),
    rating(BOT, T3, HELP_CREDITS, 4)
  ]),
  {
    // As the rate event listener left them: the bot's credits never counted.
    table: PROFILE_TOTAL_REP_SCORE_AGGREGATIONS_TABLE,
    rows: [
      { profile_id: T1, score: 101, rater_count: 4 },
      { profile_id: T2, score: 22, rater_count: 2 },
      { profile_id: T3, score: 8, rater_count: 2 },
      { profile_id: T4, score: -3, rater_count: 1 },
      { profile_id: T5, score: 7, rater_count: 1 }
    ]
  },
  {
    table: PROFILES_ACTIVITY_LOGS_TABLE,
    rows: [
      ratingLog(RATER, T1, 'REP', ALPHA),
      ratingLog(RATER, T2, 'REP', ALPHA),
      ratingLog(RATER, T1, 'REP', BETA),
      ratingLog(RATER, T1, 'REP', PERSONAL),
      ratingLog(RATER, T1, 'CIC', 'CIC'),
      ratingLog(OTHER_RATER, T1, 'REP', ALPHA),
      ratingLog(BOT, T2, 'REP', HELP_CREDITS),
      ratingLog(BOT, T2, 'REP', HELP_CREDITS),
      // Another category that differs only in case: not in scope.
      ratingLog(RATER, T1, 'REP', 'tag alpha')
    ]
  },
  {
    table: COMPETITIONS_TABLE,
    rows: [
      competition('cccccccc-0000-4000-8000-000000000001', 'ACTIVE', 'REP'),
      competition('cccccccc-0000-4000-8000-000000000002', 'DISABLED', 'REP'),
      competition('cccccccc-0000-4000-8000-000000000003', 'ACTIVE', 'TDH')
    ]
  },
  {
    table: COMPETITION_ENTRIES_TABLE,
    rows: [
      entry(
        'eeeeeeee-0000-4000-8000-000000000001',
        'cccccccc-0000-4000-8000-000000000001'
      ),
      entry(
        'eeeeeeee-0000-4000-8000-000000000002',
        'cccccccc-0000-4000-8000-000000000002'
      ),
      entry(
        'eeeeeeee-0000-4000-8000-000000000003',
        'cccccccc-0000-4000-8000-000000000003'
      )
    ]
  },
  {
    table: COMPETITION_VOTES_TABLE,
    rows: [
      // T1 votes in the active competition; T4 too, but T4's REP goes up.
      vote(
        '1',
        'cccccccc-0000-4000-8000-000000000001',
        'eeeeeeee-0000-4000-8000-000000000001',
        T1
      ),
      vote(
        '4',
        'cccccccc-0000-4000-8000-000000000001',
        'eeeeeeee-0000-4000-8000-000000000001',
        T4
      ),
      // T2 votes in a disabled REP competition and an active TDH one.
      vote(
        '2',
        'cccccccc-0000-4000-8000-000000000002',
        'eeeeeeee-0000-4000-8000-000000000002',
        T2
      ),
      vote(
        '3',
        'cccccccc-0000-4000-8000-000000000003',
        'eeeeeeee-0000-4000-8000-000000000003',
        T2
      )
    ]
  }
];

function competition(id: string, executionMode: string, creditType: string) {
  return {
    id,
    wave_id: `wave-${id}`,
    legacy_wave_id: null,
    execution_mode: executionMode,
    type: 'RANK',
    lifecycle: 'PUBLISHED',
    title: 'Test competition',
    participation_config: {},
    voting_config: { credit_type: creditType },
    decision_config: {},
    winner_config: {},
    outcome_config: [],
    created_at: 1,
    updated_at: 1
  };
}

function entry(id: string, competitionId: string) {
  return {
    id,
    competition_id: competitionId,
    wave_id: `wave-${competitionId}`,
    drop_id: `drop-${id}`,
    submitter_id: OTHER_RATER,
    status: 'ACTIVE',
    config_version: 1,
    submitted_at: 1
  };
}

function vote(
  suffix: string,
  competitionId: string,
  entryId: string,
  voter: string
) {
  return {
    id: `dddddddd-0000-4000-8000-00000000000${suffix}`,
    competition_id: competitionId,
    entry_id: entryId,
    voter_profile_id: voter,
    value: 5,
    credit_spent: 5,
    created_at: 1,
    updated_at: 1
  };
}

const NO_OVERVOTES = {
  revocation_enabled: true,
  voters_checked: 0,
  voters_losing_votes: 0,
  votes_reduced: 0,
  weight_removed: 0,
  competitions: []
};

function aJob({
  revokeOvervotes = jest.fn().mockResolvedValue(undefined),
  overvoteRevocationEnabled = true,
  recomputeIdentities,
  overvotePreview = { preview: jest.fn().mockResolvedValue(NO_OVERVOTES) },
  activityLogDeleteBatch
}: {
  revokeOvervotes?: RepRatingsRemovalDeps['revokeOvervotes'];
  overvoteRevocationEnabled?: boolean;
  recomputeIdentities?: RepRatingsRemovalDeps['recomputeIdentities'];
  overvotePreview?: RepRatingsRemovalDeps['overvotePreview'];
  activityLogDeleteBatch?: number;
} = {}) {
  return new RepRatingsRemovalJob({
    db: new RepRatingsRemovalDb(() => sqlExecutor),
    ratingsDb,
    revokeOvervotes,
    isOvervoteRevocationEnabled: () => overvoteRevocationEnabled,
    recomputeIdentities:
      recomputeIdentities ??
      (async (profileIds) => {
        await identityMetricsSync.syncScoped({
          consolidationKeys: [],
          profileIds
        });
      }),
    overvotePreview,
    activityLogDeleteBatch,
    now: () => NOW,
    sleep: () => Promise.resolve()
  });
}

const PLENTY_OF_TIME = { remainingMillis: () => 10 * 60 * 1000 };

function request(overrides: Record<string, unknown> = {}) {
  return parseRepRatingsRemovalRequest({
    job: REP_RATINGS_REMOVE_JOB,
    mode: 'APPLY',
    rater_profile_id: RATER,
    categories: [ALPHA, BETA],
    min_targets_per_category: 2,
    not_after: FAR_FUTURE,
    ...overrides
  });
}

async function apply(
  job: RepRatingsRemovalJob,
  overrides: Record<string, unknown> = {},
  limits = PLENTY_OF_TIME
) {
  return (await job.run(
    request(overrides),
    limits
  )) as RepRatingsRemovalApplyResult;
}

async function ratingsState() {
  const rows = await sqlExecutor.execute<{
    rater_profile_id: string;
    matter_target_id: string;
    matter_category: string;
    rating: number;
  }>(
    `select * from ${RATINGS_TABLE}
     order by rater_profile_id, matter_category, matter_target_id`
  );
  return rows.map(
    (it) =>
      `${it.rater_profile_id.slice(-2)} ${it.matter_category} ${it.matter_target_id.slice(-2)} ${it.rating}`
  );
}

async function identitiesState() {
  const rows = await sqlExecutor.execute<{
    profile_id: string;
    rep: number;
    level_raw: number;
  }>(
    `select profile_id, rep, level_raw from ${IDENTITIES_TABLE}
     where profile_id in (:ids) order by profile_id`,
    { ids: [T1, T2, T3, T4] }
  );
  return rows.map((it) => [
    it.profile_id.slice(-2),
    Number(it.rep),
    Number(it.level_raw)
  ]);
}

async function aggregatesState() {
  const rows = await sqlExecutor.execute<{
    profile_id: string;
    score: number;
    rater_count: number;
  }>(
    `select * from ${PROFILE_TOTAL_REP_SCORE_AGGREGATIONS_TABLE} order by profile_id`
  );
  return rows.map((it) => [
    it.profile_id.slice(-2),
    Number(it.score),
    Number(it.rater_count)
  ]);
}

async function removalsState() {
  const rows = await sqlExecutor.execute<{
    rater_profile_id: string;
    matter_category: string;
    matter_target_id: string;
    old_rating: number;
    removed_at: number;
    recomputed_at: number | null;
  }>(
    `select * from ${REP_RATING_REMOVALS_TABLE}
     order by rater_profile_id, matter_category, matter_target_id`
  );
  return rows.map((it) => [
    it.rater_profile_id.slice(-2),
    it.matter_category,
    it.matter_target_id.slice(-2),
    Number(it.old_rating),
    it.recomputed_at === null ? null : Number(it.recomputed_at)
  ]);
}

async function logsState() {
  const rows = await sqlExecutor.execute<{ id: string }>(
    `select id from ${PROFILES_ACTIVITY_LOGS_TABLE} order by id`
  );
  return rows.map((it) => it.id);
}

async function countRows(table: string): Promise<number> {
  const row = await sqlExecutor.oneOrNull<{ cnt: number }>(
    `select count(*) as cnt from ${table}`
  );
  return Number(row?.cnt);
}

async function snapshot() {
  return {
    ratings: await ratingsState(),
    identities: await identitiesState(),
    aggregates: await aggregatesState(),
    removals: await removalsState(),
    logs: await logsState()
  };
}

const RATINGS_AFTER_RATER_RUN = [
  '01 Personal Note 11 50',
  '02 Tag Alpha 11 40',
  '03 Help6529 Credits 12 5',
  '03 Help6529 Credits 13 4'
];
// T1 keeps 50 + 40, T2 the bot's 5, T3 the bot's 4; level = REP + TDH.
const IDENTITIES_AFTER_RATER_RUN = [
  ['11', 90, 1090],
  ['12', 5, 1005],
  ['13', 4, 1004],
  ['14', 0, 1000]
];
// Logs 1-3 (the rater's REP logs in scope) are gone; log 9 is in
// `tag alpha`, another category.
const LOGS_AFTER_RATER_RUN = [
  'log-004',
  'log-005',
  'log-006',
  'log-007',
  'log-008',
  'log-009'
];

describeWithSeed('RepRatingsRemovalJob', seeds, () => {
  it('dry run: counts what would go and changes nothing', async () => {
    const before = await snapshot();
    const preview = jest.fn().mockResolvedValue(NO_OVERVOTES);
    const result = (await aJob({ overvotePreview: { preview } }).run(
      request({ mode: 'DRY_RUN' }),
      PLENTY_OF_TIME
    )) as RepRatingsRemovalDryRunResult;

    expect(result.complete).toBe(false);
    expect(result.rater_profile_id).toBe(RATER);
    expect(result.categories).toEqual([
      {
        category: ALPHA,
        ratings: 5,
        non_zero_ratings: 5,
        rep_sum: 39,
        targets_real_handle: 2,
        targets_placeholder_handle: 2,
        targets_other: 1,
        other_raters_ratings: 1,
        activity_logs: 2,
        rep_score_aggregates: 'ADJUSTED',
        rating_events: null,
        removed_before: { ratings: 0, rep_sum: 0, not_recomputed: 0 }
      },
      {
        category: BETA,
        ratings: 4,
        non_zero_ratings: 3,
        rep_sum: 6,
        targets_real_handle: 2,
        targets_placeholder_handle: 2,
        targets_other: 0,
        other_raters_ratings: 0,
        activity_logs: 1,
        rep_score_aggregates: 'ADJUSTED',
        rating_events: null,
        removed_before: { ratings: 0, rep_sum: 0, not_recomputed: 0 }
      }
    ]);
    expect(result.totals).toEqual({
      ratings: 9,
      rep_sum: 45,
      distinct_targets: 5,
      activity_logs: 3
    });
    expect(result.overvotes).toEqual(NO_OVERVOTES);
    // Only T1 loses REP and votes in an active REP-credit competition (T2's
    // active competition pays votes with TDH).
    expect(preview).toHaveBeenCalledWith(RATER, [
      { matter_target_id: T1, matter_category: ALPHA, rating: 10 },
      { matter_target_id: T1, matter_category: BETA, rating: 1 }
    ]);
    expect(await snapshot()).toEqual(before);
  });

  it('apply: deletes the scope and recomputes REP, Level and the aggregates', async () => {
    const revokeOvervotes = jest.fn().mockResolvedValue(undefined);
    const result = await apply(aJob({ revokeOvervotes }));

    expect(result.complete).toBe(true);
    expect(result.stopped_by).toBeNull();
    expect(result.this_run).toMatchObject({
      batches: 2,
      ratings_deleted: 9,
      rep_removed: 45,
      targets_recomputed: 9,
      voters_overvote_checked: 2,
      activity_logs_deleted: 3,
      lock_retries: 0,
      slowest_batch_ms: 0
    });
    expect(result.categories).toEqual([
      {
        category: ALPHA,
        ratings_deleted: 5,
        rep_removed: 39,
        remaining_ratings: 0,
        remaining_rep_sum: 0,
        removal_records: 5,
        removed_rep_sum: 39,
        not_recomputed: 0,
        remaining_activity_logs: 0
      },
      {
        category: BETA,
        ratings_deleted: 4,
        rep_removed: 6,
        remaining_ratings: 0,
        remaining_rep_sum: 0,
        removal_records: 4,
        removed_rep_sum: 6,
        not_recomputed: 0,
        remaining_activity_logs: 0
      }
    ]);
    expect(result.read_back).toEqual({
      remaining_ratings: 0,
      remaining_rep_sum: 0,
      removal_records: 9,
      removed_rep_sum: 45,
      not_recomputed: 0,
      remaining_activity_logs: 0
    });

    expect(await ratingsState()).toEqual(RATINGS_AFTER_RATER_RUN);
    expect(await identitiesState()).toEqual(IDENTITIES_AFTER_RATER_RUN);
    // The rate event listener's deltas: score down, one rater less for each
    // non-zero rating removed.
    expect(await aggregatesState()).toEqual([
      ['11', 90, 2],
      ['12', 0, 0],
      ['13', 0, 0],
      ['14', 0, 0],
      ['15', 0, 0]
    ]);
    expect(await removalsState()).toEqual([
      ['01', ALPHA, '11', 10, NOW],
      ['01', ALPHA, '12', 20, NOW],
      ['01', ALPHA, '13', 5, NOW],
      ['01', ALPHA, '14', -3, NOW],
      ['01', ALPHA, '15', 7, NOW],
      ['01', BETA, '11', 1, NOW],
      ['01', BETA, '12', 2, NOW],
      ['01', BETA, '13', 3, NOW],
      ['01', BETA, '14', 0, NOW]
    ]);
    expect(await logsState()).toEqual(LOGS_AFTER_RATER_RUN);
    // Only T1 lost REP and votes in an active competition.
    const changes: RepChange[] = revokeOvervotes.mock.calls.map(
      ([change]) => change
    );
    expect(changes).toEqual([
      { rep_recipient_id: T1, rep_giver_id: RATER, credit_category: ALPHA },
      { rep_recipient_id: T1, rep_giver_id: RATER, credit_category: BETA }
    ]);
    // Nothing announced: no notification or rating event.
    expect(await countRows(IDENTITY_NOTIFICATIONS_TABLE)).toBe(0);
    expect(await countRows(EVENTS_TABLE)).toBe(0);
  });

  it("removes the help bot's credits by handle, leaving the REP score aggregates alone", async () => {
    const aggregatesBefore = await aggregatesState();
    const dryRun = (await aJob().run(
      request({
        mode: 'DRY_RUN',
        rater_profile_id: undefined,
        rater_handle: 'Help6529',
        categories: [HELP_CREDITS],
        min_targets_per_category: 0
      }),
      PLENTY_OF_TIME
    )) as RepRatingsRemovalDryRunResult;
    expect(dryRun.categories[0]).toMatchObject({
      ratings: 2,
      rep_sum: 9,
      activity_logs: 2,
      rep_score_aggregates: 'NOT_COUNTED',
      rating_events: { events: 0, score: 0, rater_count: 0 }
    });

    const result = await apply(aJob(), {
      rater_profile_id: undefined,
      rater_handle: 'Help6529',
      categories: [HELP_CREDITS],
      min_targets_per_category: 0
    });

    expect(result.complete).toBe(true);
    expect(result.rater_profile_id).toBe(BOT);
    expect(result.read_back).toEqual({
      remaining_ratings: 0,
      remaining_rep_sum: 0,
      removal_records: 2,
      removed_rep_sum: 9,
      not_recomputed: 0,
      remaining_activity_logs: 0
    });
    expect(await ratingsState()).not.toContainEqual(
      expect.stringContaining(HELP_CREDITS)
    );
    expect(await identitiesState()).toEqual([
      ['11', 101, 1101],
      ['12', 22, 1022],
      ['13', 8, 1008],
      ['14', -3, 997]
    ]);
    expect(await aggregatesState()).toEqual(aggregatesBefore);
    expect(await logsState()).toEqual([
      'log-001',
      'log-002',
      'log-003',
      'log-004',
      'log-005',
      'log-006',
      'log-009'
    ]);
  });

  it("takes back what rating events added to the aggregates for the help bot's credits", async () => {
    // Before the bot's credits were exempt, the over-rate cleanup could cut
    // one with a rating event: T2's 5 became 3 and the listener took 2 off
    // T2's aggregate.
    await sqlExecutor.execute(
      `insert into ${EVENTS_TABLE} (type, status, data, created_at)
       values ('PROFILE_REP_RATE', 'PROCESSED', :data, 1)`,
      {
        data: JSON.stringify({
          rater_profile_id: BOT,
          target_profile_id: T2,
          category: HELP_CREDITS,
          old_score: 5,
          new_score: 3
        })
      }
    );
    await sqlExecutor.execute(
      `update ${RATINGS_TABLE} set rating = 3
       where rater_profile_id = :bot and matter_target_id = :target and matter_category = :category`,
      { bot: BOT, target: T2, category: HELP_CREDITS }
    );
    await sqlExecutor.execute(
      `update ${PROFILE_TOTAL_REP_SCORE_AGGREGATIONS_TABLE} set score = score - 2 where profile_id = :target`,
      { target: T2 }
    );
    await sqlExecutor.execute(
      `update ${IDENTITIES_TABLE} set rep = rep - 2, level_raw = level_raw - 2 where profile_id = :target`,
      { target: T2 }
    );
    const botRun = {
      rater_profile_id: undefined,
      rater_handle: BOT_HANDLE,
      categories: [HELP_CREDITS],
      min_targets_per_category: 0
    };
    const dryRun = (await aJob().run(
      request({ ...botRun, mode: 'DRY_RUN' }),
      PLENTY_OF_TIME
    )) as RepRatingsRemovalDryRunResult;
    expect(dryRun.categories[0].rating_events).toEqual({
      events: 1,
      score: -2,
      rater_count: 0
    });

    const result = await apply(aJob(), botRun);

    expect(result.complete).toBe(true);
    // T2 is back to its other ratings, 20 + 2; T3 was never counted.
    expect(await aggregatesState()).toEqual([
      ['11', 101, 4],
      ['12', 22, 2],
      ['13', 8, 2],
      ['14', -3, 1],
      ['15', 7, 1]
    ]);
    expect((await identitiesState())[1]).toEqual(['12', 22, 1022]);
  });

  it("adjusts the aggregates for anyone else's ratings in the help bot's category", async () => {
    await sqlExecutor.execute(
      `insert into ${RATINGS_TABLE}
         (rater_profile_id, matter_target_id, matter, matter_category, rating, last_modified)
       values (:rater, :target, 'REP', :category, 6, current_timestamp)`,
      { rater: OTHER_RATER, target: T4, category: HELP_CREDITS }
    );
    await sqlExecutor.execute(
      `update ${PROFILE_TOTAL_REP_SCORE_AGGREGATIONS_TABLE}
       set score = score + 6, rater_count = rater_count + 1
       where profile_id = :target`,
      { target: T4 }
    );
    const result = await apply(aJob(), {
      rater_profile_id: OTHER_RATER,
      categories: [HELP_CREDITS],
      min_targets_per_category: 0
    });
    expect(result.complete).toBe(true);
    expect((await aggregatesState())[3]).toEqual(['14', -3, 1]);
  });

  it('a second run changes nothing and reports complete', async () => {
    await apply(aJob());
    const before = await snapshot();
    const revokeOvervotes = jest.fn().mockResolvedValue(undefined);
    const result = await apply(aJob({ revokeOvervotes }));

    expect(result.complete).toBe(true);
    expect(result.this_run).toMatchObject({
      batches: 0,
      ratings_deleted: 0,
      targets_recomputed: 0
    });
    expect(result.read_back.removal_records).toBe(9);
    expect(revokeOvervotes).not.toHaveBeenCalled();
    expect(await snapshot()).toEqual(before);
  });

  it('stops at max_ratings and the next run finishes', async () => {
    const first = await apply(aJob(), { batch_size: 1, max_ratings: 3 });
    expect(first.complete).toBe(false);
    expect(first.stopped_by).toBe('MAX_RATINGS');
    expect(first.this_run).toMatchObject({
      batches: 3,
      ratings_deleted: 3,
      activity_logs_deleted: 0
    });
    expect(first.read_back).toMatchObject({
      remaining_ratings: 6,
      removal_records: 3,
      not_recomputed: 0,
      // Not counted while ratings are left.
      remaining_activity_logs: null
    });
    expect((await removalsState()).map((it) => it[2])).toEqual([
      '11',
      '12',
      '13'
    ]);

    const second = await apply(aJob(), { batch_size: 2 });
    expect(second.complete).toBe(true);
    expect(second.this_run.ratings_deleted).toBe(6);
    expect(await ratingsState()).toEqual(RATINGS_AFTER_RATER_RUN);
    expect(await identitiesState()).toEqual(IDENTITIES_AFTER_RATER_RUN);
    expect(await logsState()).toEqual(LOGS_AFTER_RATER_RUN);
  });

  it('a rating created again after a run is removed by the next run', async () => {
    await apply(aJob());
    // Rated again after the run, as a rating write does it.
    await sqlExecutor.execute(
      `insert into ${RATINGS_TABLE}
         (rater_profile_id, matter_target_id, matter, matter_category, rating, last_modified)
       values (:rater, :target, 'REP', :category, 9, current_timestamp)`,
      { rater: RATER, target: T1, category: ALPHA }
    );
    await sqlExecutor.execute(
      `update ${IDENTITIES_TABLE} set rep = rep + 9, level_raw = level_raw + 9 where profile_id = :target`,
      { target: T1 }
    );

    const result = await apply(aJob());

    expect(result.complete).toBe(true);
    expect(result.this_run).toMatchObject({
      ratings_deleted: 1,
      rep_removed: 9
    });
    expect((await identitiesState())[0]).toEqual(['11', 90, 1090]);
    expect((await removalsState())[0]).toEqual(['01', ALPHA, '11', 9, NOW]);
  });

  it('a run stopped between a batch and its recompute is recomputed by the next run', async () => {
    const failOnce = jest
      .fn()
      .mockRejectedValueOnce(new Error('connection lost'))
      .mockImplementation(async (profileIds: string[]) => {
        await identityMetricsSync.syncScoped({
          consolidationKeys: [],
          profileIds
        });
      });
    await expect(
      apply(aJob({ recomputeIdentities: failOnce }))
    ).rejects.toThrow('connection lost');
    // The first batch committed; its targets still have their old REP.
    expect((await removalsState()).filter((it) => it[4] === null)).toHaveLength(
      5
    );
    expect((await identitiesState())[0]).toEqual(['11', 101, 1101]);

    const result = await apply(aJob());

    expect(result.complete).toBe(true);
    expect(result.this_run.targets_recomputed).toBe(9);
    expect(result.read_back.not_recomputed).toBe(0);
    expect(await identitiesState()).toEqual(IDENTITIES_AFTER_RATER_RUN);
  });

  it('deletes log rows over several statements', async () => {
    const result = await apply(aJob({ activityLogDeleteBatch: 1 }));
    expect(result.complete).toBe(true);
    expect(result.this_run.activity_logs_deleted).toBe(3);
    expect(await logsState()).toEqual(LOGS_AFTER_RATER_RUN);
  });

  it("recomputes from the ratings as they are, with another rater's write before the recompute", async () => {
    let written = false;
    const recomputeIdentities = async (profileIds: string[]) => {
      if (!written) {
        written = true;
        // Another rater rates T1 after the batch commits, as a rating write
        // does: the rating, then its delta on the identity.
        await sqlExecutor.execute(
          `insert into ${RATINGS_TABLE}
             (rater_profile_id, matter_target_id, matter, matter_category, rating, last_modified)
           values (:rater, :target, 'REP', 'Late', 3, current_timestamp)`,
          { rater: OTHER_RATER, target: T1 }
        );
        await sqlExecutor.execute(
          `update ${IDENTITIES_TABLE} set rep = rep + 3, level_raw = level_raw + 3 where profile_id = :target`,
          { target: T1 }
        );
      }
      await identityMetricsSync.syncScoped({
        consolidationKeys: [],
        profileIds
      });
    };
    const result = await apply(aJob({ recomputeIdentities }));
    expect(result.complete).toBe(true);
    expect((await identitiesState())[0]).toEqual(['11', 93, 1093]);
  });

  it('retries a batch that hits a deadlock', async () => {
    const deadlock = Object.assign(
      new Error('Deadlock found when trying to get lock'),
      { code: 'ER_LOCK_DEADLOCK', errno: 1213 }
    );
    const spy = jest
      .spyOn(ratingsDb, 'lockRaterCreditOnMatter')
      .mockRejectedValueOnce(deadlock);
    try {
      const result = await apply(aJob());
      expect(result.complete).toBe(true);
      expect(result.this_run).toMatchObject({
        ratings_deleted: 9,
        lock_retries: 1
      });
    } finally {
      spy.mockRestore();
    }
    expect(await identitiesState()).toEqual(IDENTITIES_AFTER_RATER_RUN);
  });

  it('does not reconcile votes when overvote revocation is off', async () => {
    const revokeOvervotes = jest.fn().mockResolvedValue(undefined);
    const result = await apply(
      aJob({ revokeOvervotes, overvoteRevocationEnabled: false })
    );
    expect(result.complete).toBe(true);
    expect(result.this_run.voters_overvote_checked).toBe(0);
    expect(revokeOvervotes).not.toHaveBeenCalled();
  });

  it('stops before a batch when the invocation is nearly out of time', async () => {
    const before = await snapshot();
    const result = await apply(aJob(), {}, { remainingMillis: () => 60_000 });
    expect(result.complete).toBe(false);
    expect(result.stopped_by).toBe('TIME_BUDGET');
    expect(result.this_run.batches).toBe(0);
    expect(result.read_back.remaining_ratings).toBe(9);
    expect(await snapshot()).toEqual(before);
  });

  it('starts no batch at or after not_after', async () => {
    const before = await snapshot();
    const result = await apply(aJob(), {
      not_after: new Date(NOW).toISOString()
    });
    expect(result.stopped_by).toBe('NOT_AFTER');
    expect(result.complete).toBe(false);
    expect(await snapshot()).toEqual(before);
  });

  it('stops mid-category on the time budget and the next run finishes it', async () => {
    let calls = 0;
    // Time for the leftover check and three batches, then less than the
    // stop margin.
    const limits = {
      remainingMillis: () =>
        ++calls <= 4 ? PLENTY_OF_TIME.remainingMillis() : STOP_MARGIN_MILLIS - 1
    };
    const first = await apply(aJob(), { batch_size: 1 }, limits);
    expect(first.stopped_by).toBe('TIME_BUDGET');
    expect(first.complete).toBe(false);
    expect(first.this_run.ratings_deleted).toBe(3);
    expect(first.categories[0]).toMatchObject({
      ratings_deleted: 3,
      remaining_ratings: 2,
      removal_records: 3,
      not_recomputed: 0
    });

    const second = await apply(aJob(), { batch_size: 1 });
    expect(second.complete).toBe(true);
    expect(second.this_run.ratings_deleted).toBe(6);
    expect(await ratingsState()).toEqual(RATINGS_AFTER_RATER_RUN);
    expect(await identitiesState()).toEqual(IDENTITIES_AFTER_RATER_RUN);
  });

  it('does not retry a failed batch without time left, and reports instead of failing', async () => {
    const before = await snapshot();
    const deadlock = Object.assign(
      new Error('Deadlock found when trying to get lock'),
      { code: 'ER_LOCK_DEADLOCK', errno: 1213 }
    );
    const spy = jest
      .spyOn(ratingsDb, 'lockRaterCreditOnMatter')
      .mockRejectedValueOnce(deadlock);
    let calls = 0;
    // Time for the leftover check and the first batch, none when it fails.
    const limits = {
      remainingMillis: () =>
        ++calls <= 2 ? PLENTY_OF_TIME.remainingMillis() : STOP_MARGIN_MILLIS
    };
    try {
      const result = await apply(aJob(), {}, limits);
      expect(result.stopped_by).toBe('TIME_BUDGET');
      expect(result.complete).toBe(false);
      expect(result.this_run).toMatchObject({ batches: 0, lock_retries: 0 });
      expect(result.read_back.remaining_ratings).toBe(9);
    } finally {
      spy.mockRestore();
    }
    expect(await snapshot()).toEqual(before);
  });

  it('refuses a missing rater, a missing category or a small one, before any change', async () => {
    const before = await snapshot();
    await expect(
      aJob().run(
        request({ rater_profile_id: 'bbbbbbbb-0000-4000-8000-000000000099' }),
        PLENTY_OF_TIME
      )
    ).rejects.toThrow('the rater profile does not exist');
    await expect(
      aJob().run(
        request({ rater_profile_id: undefined, rater_handle: 'nobody' }),
        PLENTY_OF_TIME
      )
    ).rejects.toThrow('no profile has the rater_handle given');
    await expect(
      aJob().run(request({ categories: [ALPHA, 'Tag Gamma'] }), PLENTY_OF_TIME)
    ).rejects.toThrow(
      'categories[1] "Tag Gamma": the rater has no REP rating in it'
    );
    // Exact names: another case is another category.
    await expect(
      aJob().run(request({ categories: ['tag alpha'] }), PLENTY_OF_TIME)
    ).rejects.toThrow('the rater has no REP rating in it');
    await expect(
      aJob().run(
        request({ categories: [ALPHA, PERSONAL], min_targets_per_category: 2 }),
        PLENTY_OF_TIME
      )
    ).rejects.toThrow(
      'categories[1] "Personal Note": the rater rated 1 targets in it, not more than 2'
    );
    await expect(
      aJob().run(request({ min_targets_per_category: 5 }), PLENTY_OF_TIME)
    ).rejects.toThrow('the rater rated 5 targets in it, not more than 5');
    expect(await snapshot()).toEqual(before);
  });
});

// Enough targets that one batch's statements split into several chunks.
const MANY = 700;
const manyTargets = Array.from(
  { length: MANY },
  (_, i) => `cccccccc-0000-4000-8000-${(i + 1).toString().padStart(12, '0')}`
);

describeWithSeed(
  'RepRatingsRemovalJob with batches larger than one statement',
  [
    withProfiles([
      aProfile({
        external_id: RATER,
        handle: 'raterone',
        primary_wallet: address(1)
      })
    ]),
    withIdentities(
      manyTargets.map((target, i) =>
        identity(target, 1000 + i, `id-${address(1000 + i)}`, 3)
      )
    ),
    withTdhConsolidations(manyTargets.map((_, i) => tdh(1000 + i))),
    withRatings(manyTargets.map((target) => rating(RATER, target, ALPHA, 3)))
  ],
  () => {
    it('deletes and recomputes every rating of a batch split across statements', async () => {
      const result = await apply(aJob(), {
        categories: [ALPHA],
        batch_size: MANY
      });

      expect(result.complete).toBe(true);
      expect(result.this_run).toMatchObject({
        batches: 1,
        ratings_deleted: MANY,
        rep_removed: 3 * MANY,
        targets_recomputed: MANY
      });
      expect(result.read_back).toEqual({
        remaining_ratings: 0,
        remaining_rep_sum: 0,
        removal_records: MANY,
        removed_rep_sum: 3 * MANY,
        not_recomputed: 0,
        remaining_activity_logs: 0
      });
      const identities = await sqlExecutor.oneOrNull<{
        n: number;
        rep: number;
        level_raw: number;
      }>(
        `select count(*) as n, sum(rep) as rep, sum(level_raw) as level_raw
         from ${IDENTITIES_TABLE} where profile_id in (:targets)`,
        { targets: manyTargets }
      );
      expect([
        Number(identities?.n),
        Number(identities?.rep),
        Number(identities?.level_raw)
      ]).toEqual([MANY, 0, TDH * MANY]);
      const aggregates = await sqlExecutor.oneOrNull<{
        score: number;
        raters: number;
      }>(
        `select sum(score) as score, sum(rater_count) as raters
         from ${PROFILE_TOTAL_REP_SCORE_AGGREGATIONS_TABLE}`
      );
      expect([Number(aggregates?.score), Number(aggregates?.raters)]).toEqual([
        -3 * MANY,
        -MANY
      ]);
    });
  }
);

// A wave whose votes are paid with REP the rater gives in ALPHA.
const REP_COMPETITION = 'cccccccc-1000-4000-8000-000000000001';
const REP_ENTRY = 'eeeeeeee-1000-4000-8000-000000000001';
const REP_WAVE = 'rep-credit-wave';

function repCreditCompetition() {
  return {
    id: REP_COMPETITION,
    wave_id: REP_WAVE,
    legacy_wave_id: null,
    execution_mode: 'ACTIVE',
    type: 'RANK',
    lifecycle: 'PUBLISHED',
    title: 'REP credit',
    description: null,
    config_version: 1,
    participation_config: {
      group_id: null,
      signature_required: false,
      max_entries_per_participant: null,
      required_metadata: [],
      required_media: [],
      submission_type: null,
      identity_submission_strategy: null,
      identity_submission_duplicates: null,
      starts_at: 0,
      ends_at: null,
      terms: null
    },
    voting_config: {
      group_id: null,
      credit_type: 'REP',
      credit_scope: 'WAVE',
      credit_category: ALPHA,
      credit_creditor: RATER,
      credit_nfts: [],
      signature_required: false,
      starts_at: 0,
      ends_at: null,
      max_votes_per_identity_to_entry: null,
      forbid_negative_votes: false
    },
    decision_config: {
      strategy: {
        first_decision_time: 4_000_000_000_000,
        subsequent_decisions: [],
        is_rolling: false
      },
      next_decision_time: 4_000_000_000_000,
      time_lock_ms: null,
      winning_min_threshold: null,
      winning_max_threshold: null,
      winning_threshold_min_duration_ms: 0,
      max_winners: null
    },
    winner_config: {
      max_winners: null,
      winning_min_threshold: null,
      winning_max_threshold: null,
      winning_threshold_min_duration_ms: 0
    },
    outcome_config: [],
    participation_starts_at: 0,
    participation_ends_at: null,
    voting_starts_at: 0,
    voting_ends_at: null,
    created_at: 0,
    updated_at: 0,
    published_at: 0,
    ended_at: null,
    cancelled_at: null,
    archived_at: null
  };
}

describeWithSeed(
  'RepRatingsRemovalJob with the real vote reconciliation',
  [
    withProfiles([
      aProfile({
        external_id: RATER,
        handle: 'raterone',
        primary_wallet: address(1)
      })
    ]),
    withIdentities([
      identity(RATER, 1, 'raterone', 0),
      identity(T1, 11, 'alice', 10),
      identity(T2, 12, 'bob', 20),
      identity(T3, 13, `id-${address(13)}`, 5)
    ]),
    withTdhConsolidations([1, 11, 12, 13].map(tdh)),
    withRatings([
      rating(RATER, T1, ALPHA, 10),
      rating(RATER, T2, ALPHA, 20),
      rating(RATER, T3, ALPHA, 5)
    ]),
    withWaves([
      aWave({ created_by: OTHER_RATER }, { id: REP_WAVE, name: REP_WAVE })
    ]),
    { table: COMPETITIONS_TABLE, rows: [repCreditCompetition()] },
    {
      table: COMPETITION_ENTRIES_TABLE,
      rows: [
        {
          id: REP_ENTRY,
          competition_id: REP_COMPETITION,
          wave_id: REP_WAVE,
          drop_id: 'rep-credit-drop',
          submitter_id: OTHER_RATER,
          status: 'ACTIVE',
          config_version: 1,
          submitted_at: 1
        }
      ]
    },
    {
      table: DROPS_TABLE,
      rows: [
        {
          id: 'rep-credit-drop',
          wave_id: REP_WAVE,
          author_id: OTHER_RATER,
          created_at: 1,
          parts_count: 1,
          drop_type: 'COMPETITION'
        }
      ]
    },
    {
      table: COMPETITION_VOTES_TABLE,
      rows: [
        // T1 spent all 10 of its REP credit from the rater in ALPHA.
        vote('9', REP_COMPETITION, REP_ENTRY, T1)
      ].map((it) => ({ ...it, value: 10, credit_spent: 10 }))
    }
  ],
  () => {
    it('the dry run predicts the votes the removal takes, and the apply takes them', async () => {
      const enabled = jest
        .spyOn(appFeatures, 'isDropOvervoteRevocationEnabled')
        .mockReturnValue(true);
      try {
        const job = aJob({
          revokeOvervotes: revokeRepBasedDropOverVotes,
          overvotePreview: repRatingsRemovalOvervotePreview
        });
        const dryRun = (await job.run(
          request({ mode: 'DRY_RUN', categories: [ALPHA] }),
          PLENTY_OF_TIME
        )) as RepRatingsRemovalDryRunResult;
        expect(dryRun.overvotes).toEqual({
          revocation_enabled: true,
          voters_checked: 1,
          voters_losing_votes: 1,
          votes_reduced: 1,
          weight_removed: 10,
          competitions: [
            {
              competition_id: REP_COMPETITION,
              wave_id: REP_WAVE,
              wave_name: REP_WAVE,
              credit_scope: 'WAVE',
              credit_category: ALPHA,
              voters_losing_votes: 1,
              votes_reduced: 1,
              weight_removed: 10
            }
          ]
        });

        const result = await apply(job, { categories: [ALPHA] });
        expect(result.complete).toBe(true);
        expect(result.this_run).toMatchObject({
          ratings_deleted: 3,
          voters_overvote_checked: 1
        });
      } finally {
        enabled.mockRestore();
      }
      expect(
        await nativeCompetitionRuntimeRepository.getVoterActiveVotes(
          REP_COMPETITION,
          T1,
          {}
        )
      ).toEqual([{ entryId: REP_ENTRY, value: 0 }]);
      expect(await identitiesState()).toEqual([
        ['11', 0, 1000],
        ['12', 0, 1000],
        ['13', 0, 1000]
      ]);
    });
  }
);

const ALL_REP_COMPETITION = 'cccccccc-2000-4000-8000-000000000001';
const ALL_REP_ENTRY = 'eeeeeeee-2000-4000-8000-000000000001';
const ALL_REP_WAVE = 'all-rep-credit-wave';
const ALL_REP_VOTE = 'dddddddd-2000-4000-8000-000000000001';

/** Votes paid with all of a voter's REP, from anyone, in any category. */
function allRepCreditCompetition() {
  const base = repCreditCompetition();
  return {
    ...base,
    id: ALL_REP_COMPETITION,
    wave_id: ALL_REP_WAVE,
    voting_config: {
      ...base.voting_config,
      credit_category: null,
      credit_creditor: null
    }
  };
}

describeWithSeed(
  'RepRatingsRemovalJob with a wave that counts every REP category',
  [
    withProfiles([
      aProfile({
        external_id: RATER,
        handle: 'raterone',
        primary_wallet: address(1)
      }),
      aProfile({
        external_id: OTHER_RATER,
        handle: 'ratertwo',
        primary_wallet: address(2)
      })
    ]),
    withIdentities([
      identity(RATER, 1, 'raterone', 0),
      identity(OTHER_RATER, 2, 'ratertwo', 0),
      identity(T1, 11, 'alice', 21),
      identity(T2, 12, 'bob', 20),
      identity(T3, 13, `id-${address(13)}`, 5)
    ]),
    withTdhConsolidations([1, 2, 11, 12, 13].map(tdh)),
    withRatings([
      rating(RATER, T1, ALPHA, 10),
      rating(RATER, T1, BETA, 5),
      rating(RATER, T2, ALPHA, 20),
      rating(RATER, T3, BETA, 5),
      // T1 keeps 6 REP from someone else.
      rating(OTHER_RATER, T1, PERSONAL, 6)
    ]),
    withWaves([
      aWave(
        { created_by: OTHER_RATER },
        { id: ALL_REP_WAVE, name: ALL_REP_WAVE }
      )
    ]),
    { table: COMPETITIONS_TABLE, rows: [allRepCreditCompetition()] },
    {
      table: COMPETITION_ENTRIES_TABLE,
      rows: [
        {
          id: ALL_REP_ENTRY,
          competition_id: ALL_REP_COMPETITION,
          wave_id: ALL_REP_WAVE,
          drop_id: 'all-rep-credit-drop',
          submitter_id: OTHER_RATER,
          status: 'ACTIVE',
          config_version: 1,
          submitted_at: 1
        }
      ]
    },
    {
      table: DROPS_TABLE,
      rows: [
        {
          id: 'all-rep-credit-drop',
          wave_id: ALL_REP_WAVE,
          author_id: OTHER_RATER,
          created_at: 1,
          parts_count: 1,
          drop_type: 'COMPETITION'
        }
      ]
    },
    {
      table: COMPETITION_VOTES_TABLE,
      rows: [
        // T1 spent 15 of its 21 REP credit.
        {
          ...vote('0', ALL_REP_COMPETITION, ALL_REP_ENTRY, T1),
          id: ALL_REP_VOTE,
          value: 15,
          credit_spent: 15
        }
      ]
    }
  ],
  () => {
    async function t1Vote(): Promise<number> {
      const votes =
        await nativeCompetitionRuntimeRepository.getVoterActiveVotes(
          ALL_REP_COMPETITION,
          T1,
          {}
        );
      return votes[0].value;
    }

    it('previews losses in several categories against one competition', async () => {
      const enabled = jest
        .spyOn(appFeatures, 'isDropOvervoteRevocationEnabled')
        .mockReturnValue(true);
      try {
        const dryRun = (await aJob({
          overvotePreview: repRatingsRemovalOvervotePreview
        }).run(
          request({ mode: 'DRY_RUN', min_targets_per_category: 1 }),
          PLENTY_OF_TIME
        )) as RepRatingsRemovalDryRunResult;
        // 21 - (10 + 5) leaves 6 of the 15 spent.
        expect(dryRun.overvotes).toMatchObject({
          voters_checked: 1,
          voters_losing_votes: 1,
          votes_reduced: 1,
          weight_removed: 9,
          competitions: [
            expect.objectContaining({
              competition_id: ALL_REP_COMPETITION,
              wave_name: ALL_REP_WAVE,
              credit_category: null,
              weight_removed: 9
            })
          ]
        });
      } finally {
        enabled.mockRestore();
      }
      expect(await t1Vote()).toBe(15);
    });

    it('keeps a vote lowered by its voter while a batch runs', async () => {
      const enabled = jest
        .spyOn(appFeatures, 'isDropOvervoteRevocationEnabled')
        .mockReturnValue(true);
      let changed = false;
      const revokeOvervotes: RepRatingsRemovalDeps['revokeOvervotes'] = async (
        change,
        connection
      ) => {
        if (!changed) {
          changed = true;
          // The voter lowers the vote to 4, committed on another connection
          // after the batch's first read.
          await sqlExecutor.execute(
            `update ${COMPETITION_VOTES_TABLE} set value = 4, credit_spent = 4 where id = :id`,
            { id: ALL_REP_VOTE }
          );
        }
        await revokeRepBasedDropOverVotes(change, connection);
      };
      try {
        const result = await apply(aJob({ revokeOvervotes }), {
          min_targets_per_category: 1
        });
        expect(result.complete).toBe(true);
        expect(result.this_run.voters_overvote_checked).toBe(2);
      } finally {
        enabled.mockRestore();
      }
      // 4 fits the 6 REP left; a reconciliation reading the batch's first
      // snapshot would have written 6 over it.
      expect(await t1Vote()).toBe(4);
      expect((await identitiesState())[0]).toEqual(['11', 6, 1006]);
    });
  }
);
