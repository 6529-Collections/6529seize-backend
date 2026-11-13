import {
  CONSOLIDATED_WALLETS_TDH_TABLE,
  IDENTITIES_TABLE,
  IDENTITY_SUBSCRIPTIONS_TABLE,
  RATINGS_TABLE,
  WAVE_METRICS_TABLE
} from '@/constants';
import { IdentityEntity } from '@/entities/IIdentity';
import { RateMatter, Rating } from '@/entities/IRating';
import { ConnectionWrapper, sqlExecutor } from '@/sql-executor';
import { Seed } from '@/tests/_setup/seed';
import {
  anAddressConsolidationKeys,
  withAddressConsolidationKeys
} from '@/tests/fixtures/address-consolidation-key.fixture';
import { anIdentity, withIdentities } from '@/tests/fixtures/identity.fixture';
import { aProfile, withProfiles } from '@/tests/fixtures/profile.fixture';
import {
  aCicRating,
  aRepRating,
  withRatings
} from '@/tests/fixtures/rating.fixture';
import {
  aTdhConsolidation,
  withTdhConsolidations
} from '@/tests/fixtures/tdh_consolidation.fixture';

/**
 * Identities whose metrics the consolidated-TDH identities sync recomputes:
 * stale values, REP and CIC (positive, negative, mixed, none), consolidated
 * TDH or none, fractional xTDH (including halves, where rounding matters),
 * profiles without an id, and a profile merge: bob (0x3) and mary (0x4)
 * consolidate into 0x3-0x4 and bob's profile, ratings and wave
 * subscriptions merge into mary's. alice (0x1-0x2) splits.
 */
const EXTRA_COUNT = 27;
const XTDH = [0, 0.5, 1.5, 2.5, 3.25, 7, 0.49999, 12.75, 1e-9, 100.5];

const extraKey = (i: number) => `0xe${String(i).padStart(2, '0')}`;
/** Two extras have no profile id. */
const extraProfileId = (i: number) =>
  i === 9 || i === 18 ? null : `p-e${String(i).padStart(2, '0')}`;

function extraIdentity(i: number): IdentityEntity {
  const key = extraKey(i);
  // e20 starts at its final values (no ratings, no TDH, no xTDH).
  const stale = i === 20 ? 0 : 1;
  return anIdentity(
    {
      rep: stale * (i * 7 - 50),
      cic: stale * (1000 + i),
      tdh: stale * i,
      basetdh_rate: stale * (i / 3),
      level_raw: stale * (i * 11),
      xtdh: i === 20 ? 0 : XTDH[i % XTDH.length]
    },
    {
      consolidation_key: key,
      profile_id: extraProfileId(i) as string,
      primary_address: key,
      handle: `extra${i}`
    }
  );
}

/** Extras 1-15 have consolidated TDH (extra 13 with zero). */
const extraTdh = (i: number) =>
  aTdhConsolidation([extraKey(i)], {
    boosted_tdh: i === 13 ? 0 : i * 101,
    boosted_tdh_rate: i === 13 ? 0 : 0.1 * i + 0.2
  });

function ratings(): Rating[] {
  const all: Rating[] = [];
  const profile = (i: number) => extraProfileId(i) ?? 'p-orphan-rater';
  for (let i = 1; i <= EXTRA_COUNT; i++) {
    const target = extraProfileId(i);
    if (!target || i === 20) continue;
    // REP from two raters in two categories, sometimes negative.
    if (i % 3 !== 0) {
      all.push(
        aRepRating({
          rater_profile_id: profile(((i + 1) % EXTRA_COUNT) + 1),
          matter_target_id: target,
          matter_category: 'art',
          rating: i % 4 === 0 ? -i * 3 : i * 5
        }),
        aRepRating({
          rater_profile_id: profile(((i + 4) % EXTRA_COUNT) + 1),
          matter_target_id: target,
          matter_category: 'dev',
          rating: i * 2 - 11
        })
      );
    }
    // CIC, sometimes the only rating.
    if (i % 2 === 0) {
      all.push(
        aCicRating({
          rater_profile_id: profile(((i + 6) % EXTRA_COUNT) + 1),
          matter_target_id: target,
          rating: i % 8 === 0 ? -i : i * 9
        })
      );
    }
  }
  // Not an identity metric: WAVE_REP ratings must not count.
  all.push({
    rater_profile_id: 'p-e01',
    matter_target_id: 'p-e02',
    matter: RateMatter.WAVE_REP,
    matter_category: 'wave',
    rating: 999,
    last_modified: new Date('2024-01-01T00:00:00Z')
  });
  // The merge: bob gives and receives, mary gives and receives, bob rates
  // mary (dropped by the merge), and both rate the same target.
  all.push(
    aRepRating({
      rater_profile_id: 'bobPID',
      matter_target_id: 'p-e01',
      matter_category: 'merge',
      rating: 40
    }),
    aRepRating({
      rater_profile_id: 'p-e02',
      matter_target_id: 'bobPID',
      matter_category: 'merge',
      rating: 25
    }),
    aCicRating({
      rater_profile_id: 'p-e03',
      matter_target_id: 'bobPID',
      rating: -6
    }),
    aRepRating({
      rater_profile_id: 'p-e01',
      matter_target_id: 'maryPID',
      matter_category: 'merge',
      rating: 17
    }),
    aCicRating({
      rater_profile_id: 'maryPID',
      matter_target_id: 'p-e04',
      rating: 8
    }),
    aRepRating({
      rater_profile_id: 'bobPID',
      matter_target_id: 'maryPID',
      matter_category: 'friend',
      rating: 30
    }),
    aRepRating({
      rater_profile_id: 'maryPID',
      matter_target_id: 'p-e05',
      matter_category: 'shared',
      rating: 12
    }),
    aRepRating({
      rater_profile_id: 'bobPID',
      matter_target_id: 'p-e06',
      matter_category: 'shared',
      rating: -9
    }),
    aRepRating({
      rater_profile_id: 'p-e07',
      matter_target_id: 'alicePID',
      matter_category: 'art',
      rating: 21
    })
  );
  return all;
}

function subscription(subscriberId: string, waveId: string) {
  return {
    subscriber_id: subscriberId,
    target_id: waveId,
    target_type: 'WAVE',
    target_action: 'DROP_CREATED',
    wave_id: waveId,
    subscribed_to_all_drops: false
  };
}

/** bob and mary both follow wave-both, so the merge lowers its count. */
const SUBSCRIPTIONS = [
  subscription('bobPID', 'wave-both'),
  subscription('maryPID', 'wave-both'),
  subscription('p-e01', 'wave-both'),
  subscription('bobPID', 'wave-bob'),
  subscription('p-e01', 'wave-other'),
  subscription('p-e02', 'wave-other')
];

const WAVE_METRICS = [
  { wave_id: 'wave-both', subscribers_count: 3 },
  { wave_id: 'wave-bob', subscribers_count: 1 },
  { wave_id: 'wave-other', subscribers_count: 2 }
];

export function identityMetricsSyncSeeds(): Seed[] {
  const extras = Array.from({ length: EXTRA_COUNT }, (_, i) =>
    extraIdentity(i + 1)
  );
  return [
    withAddressConsolidationKeys([
      ...anAddressConsolidationKeys(['0x1', '0x2']),
      ...anAddressConsolidationKeys(['0x3']),
      ...anAddressConsolidationKeys(['0x4']),
      ...Array.from({ length: 15 }, (_, i) =>
        anAddressConsolidationKeys([extraKey(i + 1)])
      ).flat()
    ]),
    withIdentities([
      anIdentity(
        {
          rep: 10,
          tdh: 10,
          basetdh_rate: 10,
          cic: 10,
          level_raw: 3,
          xtdh: 2.5
        },
        {
          consolidation_key: '0x1-0x2',
          profile_id: 'alicePID',
          primary_address: '0x1',
          handle: 'alice'
        }
      ),
      anIdentity(
        { rep: 1, tdh: 1, basetdh_rate: 1, cic: 1, level_raw: 1, xtdh: 0.5 },
        {
          consolidation_key: '0x3',
          profile_id: 'bobPID',
          primary_address: '0x3',
          handle: 'bob'
        }
      ),
      anIdentity(
        { rep: 1, tdh: 1, basetdh_rate: 1, cic: 1, level_raw: 9, xtdh: 1.5 },
        {
          consolidation_key: '0x4',
          profile_id: 'maryPID',
          primary_address: '0x4',
          handle: 'mary'
        }
      ),
      ...extras
    ]),
    withProfiles([
      aProfile({
        external_id: 'alicePID',
        primary_wallet: '0x1',
        handle: 'alice'
      }),
      aProfile({ external_id: 'bobPID', primary_wallet: '0x3', handle: 'bob' }),
      aProfile({
        external_id: 'maryPID',
        primary_wallet: '0x4',
        handle: 'mary'
      })
    ]),
    withTdhConsolidations([
      aTdhConsolidation(['0x1'], { boosted_tdh: 5, boosted_tdh_rate: 5.25 }),
      aTdhConsolidation(['0x2'], { boosted_tdh: 4, boosted_tdh_rate: 4 }),
      aTdhConsolidation(['0x3-0x4'], {
        boosted_tdh: 3,
        boosted_tdh_rate: 3.5
      }),
      ...Array.from({ length: 15 }, (_, i) => extraTdh(i + 1))
    ]),
    withRatings(ratings()),
    { table: IDENTITY_SUBSCRIPTIONS_TABLE, rows: SUBSCRIPTIONS },
    { table: WAVE_METRICS_TABLE, rows: WAVE_METRICS }
  ];
}

/** Deterministic primary addresses for the merge fixture's consolidations. */
export function fixturePrimaryAddress(
  wallets: string[],
  consolidationKey: string
): Promise<string> {
  if (wallets.length === 1) return Promise.resolve(wallets[0]);
  if (consolidationKey === '0x1-0x2') return Promise.resolve('0x1');
  if (consolidationKey === '0x3-0x4') return Promise.resolve('0x4');
  throw new Error(`Unmocked consolidation ${consolidationKey}`);
}

/**
 * The pre-change metrics sync, verbatim: the reference the chunked sync must
 * match. It ran inside the consolidated-TDH transaction, after the merge and
 * a full wave subscriber resync.
 */
export const OLD_ALGORITHM_SQL = [
  `update wave_metrics
        inner join (select target_id as wave_id, count(distinct subscriber_id) as followers_count
                    from ${IDENTITY_SUBSCRIPTIONS_TABLE}
                    where target_type = 'WAVE' and target_action = 'DROP_CREATED' group by 1) x on x.wave_id = ${WAVE_METRICS_TABLE}.wave_id
        set ${WAVE_METRICS_TABLE}.subscribers_count = x.followers_count
        where ${WAVE_METRICS_TABLE}.subscribers_count <> x.followers_count`,
  `update ${IDENTITIES_TABLE} set rep = 0, cic = 0, tdh = 0, basetdh_rate = 0`,
  `
    with cs as (
        select matter_target_id as profile_id, sum(rating) as rating from ${RATINGS_TABLE} where matter = 'REP' group by 1
    )
    update ${IDENTITIES_TABLE} i
        inner join cs on cs.profile_id = i.profile_id
    set i.rep = cs.rating
    where cs.rating <> i.rep
  `,
  `
        with cs as (
          select matter_target_id as profile_id, sum(rating) as rating from ${RATINGS_TABLE} where matter = 'CIC' group by 1
        )
        update ${IDENTITIES_TABLE} i
          inner join cs on cs.profile_id = i.profile_id
        set i.cic = cs.rating
        where cs.rating <> i.cic
      `,
  `
     update ${IDENTITIES_TABLE} i
            inner join ${CONSOLIDATED_WALLETS_TDH_TABLE} c  on c.consolidation_key = i.consolidation_key
        set i.tdh = c.boosted_tdh, i.basetdh_rate = c.boosted_tdh_rate
        where i.consolidation_key = c.consolidation_key
  `,
  `
        update ${IDENTITIES_TABLE} set level_raw = (rep+tdh+xtdh) where level_raw <> (rep+tdh+xtdh)
  `
];

export type IdentityRow = IdentityEntity;

export async function readIdentities(
  connection?: ConnectionWrapper<any>
): Promise<IdentityRow[]> {
  return sqlExecutor.execute<IdentityRow>(
    `select * from ${IDENTITIES_TABLE} order by consolidation_key asc`,
    undefined,
    connection ? { wrappedConnection: connection } : undefined
  );
}

export async function readWaveSubscriberCounts(
  connection?: ConnectionWrapper<any>
): Promise<{ wave_id: string; subscribers_count: number }[]> {
  return sqlExecutor.execute(
    `select wave_id, subscribers_count from ${WAVE_METRICS_TABLE} order by wave_id asc`,
    undefined,
    connection ? { wrappedConnection: connection } : undefined
  );
}

export const METRIC_COLUMNS = [
  'rep',
  'cic',
  'tdh',
  'basetdh_rate',
  'level_raw'
] as const;
