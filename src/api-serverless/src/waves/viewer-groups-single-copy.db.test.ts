import 'reflect-metadata';
import {
  DROP_BOOSTS_TABLE,
  DROPS_TABLE,
  IDENTITY_SUBSCRIPTIONS_TABLE,
  WAVE_METRICS_TABLE,
  WAVE_READER_METRICS_TABLE
} from '@/constants';
import { DropsDb } from '@/drops/drops.db';
import {
  ActivityEventAction,
  ActivityEventTargetType
} from '@/entities/IActivityEvent';
import { DropType } from '@/entities/IDrop';
import { WaveType } from '@/entities/IWave';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import { seedNativeOriginalPrimaryFixture } from '@/tests/fixtures/native-competition.fixture';
import { anIdentity, withIdentities } from '@/tests/fixtures/identity.fixture';
import { aWave, withWaves } from '@/tests/fixtures/wave.fixture';
import { resetViewerGroupsCteSupport } from '@/waves/viewer-groups-cte';
import { ApiWaveScoreSort } from '../generated/models/ApiWaveScoreSort';
import { WavesApiDb } from './waves.api.db';

const MEMBER = 'sc2-member-group';
const OTHER = 'sc2-other-group';
const viewer = anIdentity(
  {},
  {
    consolidation_key: 'sc2-viewer',
    profile_id: 'sc2-viewer',
    primary_address: 'sc2-viewer-wallet',
    handle: 'sc2-viewer'
  }
);
const poster = anIdentity(
  {},
  {
    consolidation_key: 'sc2-poster',
    profile_id: 'sc2-poster',
    primary_address: 'sc2-poster-wallet',
    handle: 'sc2-poster'
  }
);

// Open TDH approval voting, so the roots also show up as active voting waves.
const voting = { type: WaveType.APPROVE };
const roots = [
  aWave({ ...voting }, { id: 'sc2-public', serial_no: 1, name: 'Public' }),
  aWave(
    { ...voting, visibility_group_id: MEMBER },
    { id: 'sc2-member', serial_no: 2, name: 'Member' }
  ),
  aWave(
    { ...voting, visibility_group_id: OTHER },
    { id: 'sc2-other', serial_no: 3, name: 'Other' }
  )
];
const children = [
  aWave(
    { parent_wave_id: 'sc2-public' },
    { id: 'sc2-public-open', serial_no: 4, name: 'Public open' }
  ),
  aWave(
    { parent_wave_id: 'sc2-public', visibility_group_id: MEMBER },
    { id: 'sc2-public-members', serial_no: 5, name: 'Public members' }
  ),
  aWave(
    { parent_wave_id: 'sc2-member' },
    { id: 'sc2-member-open', serial_no: 6, name: 'Member open' }
  )
];
const dms = [
  aWave(
    { is_direct_message: true, visibility_group_id: MEMBER },
    { id: 'sc2-dm-member', serial_no: 7, name: 'DM member' }
  ),
  aWave(
    { is_direct_message: true, visibility_group_id: OTHER },
    { id: 'sc2-dm-other', serial_no: 8, name: 'DM other' }
  )
];
const allWaves = [...roots, ...children, ...dms];
const follow = (waveId: string) => ({
  subscriber_id: viewer.profile_id!,
  target_id: waveId,
  target_type: ActivityEventTargetType.WAVE,
  target_action: ActivityEventAction.DROP_CREATED,
  wave_id: waveId,
  subscribed_to_all_drops: false
});
const drop = (waveId: string, index: number) => ({
  id: `sc2-drop-${waveId}`,
  serial_no: 100 + index,
  wave_id: waveId,
  author_id: poster.profile_id!,
  created_at: 1_000 + index,
  updated_at: null,
  title: null,
  parts_count: 1,
  reply_to_drop_id: null,
  reply_to_part_id: null,
  drop_type: DropType.CHAT,
  signature: null,
  hide_link_preview: false
});

const viewerGroupSets = [
  [MEMBER],
  [OTHER],
  [MEMBER, OTHER],
  ['sc2-unrelated-group'],
  // Matching follows the column collation (case-insensitive), as the
  // inlined literal list does.
  [MEMBER.toUpperCase()]
];

type Read = (
  waves: WavesApiDb,
  drops: DropsDb,
  groups: string[]
) => Promise<unknown>;
const byId = (a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id);
/** Unordered reads (id sets, waves by ids) compare as sorted lists. */
const sorted = (value: unknown) => {
  if (value instanceof Set) return Array.from(value).sort();
  if (Array.isArray(value) && value.every((it) => typeof it?.id === 'string'))
    return [...value].sort(byId);
  return value;
};
const hasRows = (value: unknown): boolean => {
  if (typeof value === 'number') return value > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (value && typeof value === 'object')
    return Object.values(value).some(hasRows);
  return false;
};

const reads: [string, string, Read][] = [
  [
    'follow candidates',
    'fc_viewer_groups',
    (waves, _, groups) =>
      (waves as any).findFollowedCandidateWaveIds({
        authenticated_user_id: viewer.profile_id,
        waveIds: roots.map((it) => it.id),
        eligibleGroups: groups
      })
  ],
  [
    'waves by ids',
    'wi_viewer_groups',
    (waves, _, groups) =>
      waves.findWavesByIds(
        allWaves.map((it) => it.id),
        groups
      )
  ],
  [
    'waves by ids eligible for read',
    'wr_viewer_groups',
    (waves, _, groups) =>
      waves.findWavesByIdsEligibleForRead(
        allWaves.map((it) => it.id),
        groups
      )
  ],
  [
    'active TDH voting waves',
    'tv_viewer_groups',
    (waves, _, groups) =>
      waves.findActiveTdhVotingWaves(
        { eligibleGroups: groups, now: 2_000, limit: 10, offset: 0 },
        {}
      )
  ],
  [
    'recently dropped overview, followed',
    'ov_viewer_groups',
    (waves, _, groups) =>
      waves.findRecentlyDroppedToWaves({
        authenticated_user_id: viewer.profile_id!,
        only_waves_followed_by_authenticated_user: true,
        offset: 0,
        limit: 20,
        eligibleGroups: groups,
        pinned: null
      })
  ],
  [
    'scored overview, followed',
    'ov_viewer_groups',
    (waves, _, groups) =>
      waves.findScoredRecentlyDroppedToWaves({
        authenticated_user_id: viewer.profile_id!,
        only_waves_followed_by_authenticated_user: true,
        offset: 0,
        limit: 20,
        eligibleGroups: groups,
        pinned: null,
        score_sort: ApiWaveScoreSort.Quality,
        exclude_followed: false
      })
  ],
  [
    'DM unread states',
    'dm_viewer_groups',
    (waves, _, groups) =>
      waves.findDmUnreadConversationStates(
        { identityId: viewer.profile_id!, eligibleGroups: groups },
        {}
      )
  ],
  [
    'boosted drops',
    'bd_viewer_groups',
    (_, drops, groups) =>
      drops.findBoostedDrops(
        {
          wave_id: null,
          eligibile_groups: groups,
          limit: 50,
          offset: 0,
          booster_id: null,
          author_id: null,
          min_boosts: null,
          order_by: 'drop_created_at',
          count_only_boosts_after: 0,
          order: 'DESC'
        },
        {}
      )
  ],
  [
    'boosted drops count',
    'bd_viewer_groups',
    (_, drops, groups) =>
      drops.countBoostedDrops(
        {
          wave_id: null,
          eligibile_groups: groups,
          booster_id: null,
          author_id: null,
          min_boosts: null,
          count_only_boosts_after: 0
        },
        {}
      )
  ]
];

describeWithSeed(
  'Single-copy viewer groups, batch 2',
  [
    withIdentities([viewer, poster]),
    withWaves(allWaves),
    {
      table: WAVE_METRICS_TABLE,
      rows: allWaves.map((wave, index) => ({
        wave_id: wave.id,
        latest_drop_timestamp: 1_000 + index,
        wave_quality_score: 10 + index
      }))
    },
    {
      table: IDENTITY_SUBSCRIPTIONS_TABLE,
      rows: [...roots, ...children].map((wave) => follow(wave.id))
    },
    {
      table: WAVE_READER_METRICS_TABLE,
      rows: dms.map((wave) => ({
        wave_id: wave.id,
        reader_id: viewer.profile_id!,
        latest_read_timestamp: 0,
        latest_read_serial_no: 0,
        muted: false
      }))
    },
    {
      table: DROPS_TABLE,
      rows: allWaves.map((wave, index) => drop(wave.id, index))
    },
    {
      table: DROP_BOOSTS_TABLE,
      rows: allWaves.map((wave, index) => ({
        drop_id: `sc2-drop-${wave.id}`,
        booster_id: viewer.profile_id!,
        boosted_at: 2_000 + index,
        wave_id: wave.id
      }))
    }
  ],
  () => {
    // A fresh repository per read: repositories keep the executor they first
    // saw, while each test installs a new one.
    const repos = () => ({
      waves: new WavesApiDb(() => sqlExecutor),
      drops: new DropsDb(() => sqlExecutor)
    });

    beforeEach(async () => {
      for (const wave of roots) await seedNativeOriginalPrimaryFixture(wave);
    });
    afterEach(() => resetViewerGroupsCteSupport());

    it.each(reads)(
      '%s returns exactly what the inlined list does',
      async (_name, _cte, read) => {
        let sawRows = false;
        for (const groups of viewerGroupSets) {
          resetViewerGroupsCteSupport(false);
          let r = repos();
          const inline = sorted(await read(r.waves, r.drops, groups));
          resetViewerGroupsCteSupport(true);
          r = repos();
          const shared = sorted(await read(r.waves, r.drops, groups));
          expect({ groups, result: shared }).toEqual({
            groups,
            result: inline
          });
          sawRows ||= hasRows(inline);
        }
        // The seed makes every read return something for some viewer.
        expect(sawRows).toBe(true);
      },
      120_000
    );

    it.each(reads)(
      '%s reads the groups once per statement',
      async (_name, cte, read) => {
        resetViewerGroupsCteSupport();
        const r = repos();
        const captured: [string, Record<string, unknown>][] = [];
        // Both repositories share one executor: spy on it once.
        for (const db of Array.from(
          new Set([
            (r.waves as unknown as { db: typeof sqlExecutor }).db,
            (r.drops as unknown as { db: typeof sqlExecutor }).db
          ])
        )) {
          const original = db.execute.bind(db);
          jest.spyOn(db, 'execute').mockImplementation((sql, params, opts) => {
            if (sql.includes(`${cte} as (`))
              captured.push([sql, (params ?? {}) as Record<string, unknown>]);
            return original(sql, params, opts);
          });
        }
        try {
          await read(r.waves, r.drops, [MEMBER, OTHER]);
        } finally {
          jest.restoreAllMocks();
        }
        expect(captured.length).toBeGreaterThan(0);
        for (const [sql, params] of captured) {
          const [row] = await sqlExecutor.execute<Record<string, string>>(
            `explain format=tree ${sql}`,
            params
          );
          const plan = Object.values(row)[0];
          expect(plan.match(/Materialize table function/g)).toHaveLength(1);
          expect(plan).toContain(`Materialize CTE ${cte}`);
          expect(plan).not.toMatch(/visibility_group_id,\s*<exists>/);
        }
      },
      120_000
    );
  }
);
