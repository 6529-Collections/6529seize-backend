import 'reflect-metadata';
import {
  DROPS_TABLE,
  WAVE_CHAT_DROP_COOLDOWNS_TABLE,
  WAVE_DROPPER_METRICS_TABLE
} from '@/constants';
import { DropType } from '@/entities/IDrop';
import { RequestContext } from '@/request.context';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import { anIdentity, withIdentities } from '@/tests/fixtures/identity.fixture';
import { aWave, withWaves } from '@/tests/fixtures/wave.fixture';
import { Time } from '@/time';
import { WavesApiDb, WaveSubwavesSort } from './waves.api.db';

const repo = new WavesApiDb(() => sqlExecutor);
const ctx: RequestContext = { timer: undefined };

const author = anIdentity(
  {},
  {
    consolidation_key: 'identity-wave-author',
    profile_id: 'profile-wave-author',
    primary_address: 'wallet-wave-author',
    handle: 'wave-author'
  }
);

const publicWave = aWave(
  {
    created_by: author.profile_id!,
    chat_links_disabled: true
  },
  { id: 'wave-public', serial_no: 1, name: 'Public Wave' }
);

const privateWave = aWave(
  {
    created_by: author.profile_id!,
    visibility_group_id: 'visibility-group',
    admin_group_id: 'admin-group'
  },
  { id: 'wave-private', serial_no: 2, name: 'Private Wave' }
);

const parentWave = aWave(
  {
    created_by: author.profile_id!
  },
  { id: 'wave-parent', serial_no: 10, name: 'Parent Wave' }
);

const alphaSubwave = aWave(
  {
    created_by: author.profile_id!,
    parent_wave_id: parentWave.id
  },
  { id: 'wave-sub-alpha', serial_no: 11, name: 'Alpha Subwave' }
);

const betaSubwave = aWave(
  {
    created_by: author.profile_id!,
    parent_wave_id: parentWave.id
  },
  { id: 'wave-sub-beta', serial_no: 12, name: 'Beta Subwave' }
);

const hiddenParentWave = aWave(
  {
    created_by: author.profile_id!,
    visibility_group_id: 'hidden-parent-group'
  },
  { id: 'wave-hidden-parent', serial_no: 13, name: 'Hidden Parent Wave' }
);

const publicSubwaveOfHiddenParent = aWave(
  {
    created_by: author.profile_id!,
    parent_wave_id: hiddenParentWave.id
  },
  { id: 'wave-hidden-parent-child', serial_no: 14, name: 'Visible Child' }
);

describeWithSeed(
  'WavesApiDb read visibility',
  [
    withIdentities([author]),
    withWaves([publicWave, privateWave]),
    {
      table: WAVE_DROPPER_METRICS_TABLE,
      rows: [
        {
          wave_id: publicWave.id,
          dropper_id: author.profile_id!,
          drops_count: 1,
          participatory_drops_count: 0,
          latest_drop_timestamp: 1001
        },
        {
          wave_id: privateWave.id,
          dropper_id: author.profile_id!,
          drops_count: 2,
          participatory_drops_count: 0,
          latest_drop_timestamp: 1002
        }
      ]
    }
  ],
  () => {
    it('does not read private waves through admin-group-only eligibility by ids', async () => {
      const adminOnlyResults = await repo.findWavesByIdsEligibleForRead(
        [publicWave.id, privateWave.id],
        ['admin-group'],
        undefined
      );
      expect(adminOnlyResults.map((wave) => wave.id)).toEqual([publicWave.id]);
      expect(adminOnlyResults[0]?.chat_links_disabled).toBe(true);

      const visibilityResults = await repo.findWavesByIdsEligibleForRead(
        [publicWave.id, privateWave.id],
        ['visibility-group'],
        undefined
      );
      expect(visibilityResults.map((wave) => wave.id).sort()).toEqual([
        privateWave.id,
        publicWave.id
      ]);
    });

    it('does not search private waves through admin-group-only eligibility', async () => {
      const baseParams = {
        limit: 10,
        direct_message: false
      };

      await expect(
        repo.searchWaves(baseParams, ['admin-group'], ctx)
      ).resolves.toEqual([expect.objectContaining({ id: publicWave.id })]);
      await expect(
        repo.searchWaves(baseParams, ['visibility-group'], ctx)
      ).resolves.toEqual([
        expect.objectContaining({ id: privateWave.id }),
        expect.objectContaining({ id: publicWave.id })
      ]);
    });

    it('does not return favorite private waves through admin-group-only eligibility', async () => {
      await expect(
        repo.findFavouriteWavesOfIdentity(
          {
            identityId: author.profile_id!,
            eligibleGroups: ['admin-group'],
            limit: 10,
            offset: 0
          },
          ctx
        )
      ).resolves.toEqual([expect.objectContaining({ id: publicWave.id })]);
      await expect(
        repo.findFavouriteWavesOfIdentity(
          {
            identityId: author.profile_id!,
            eligibleGroups: ['visibility-group'],
            limit: 10,
            offset: 0
          },
          ctx
        )
      ).resolves.toEqual([
        expect.objectContaining({ id: privateWave.id }),
        expect.objectContaining({ id: publicWave.id })
      ]);
    });
  }
);

describeWithSeed(
  'WavesApiDb subwaves',
  [
    withIdentities([author]),
    withWaves([
      parentWave,
      alphaSubwave,
      betaSubwave,
      hiddenParentWave,
      publicSubwaveOfHiddenParent
    ]),
    {
      table: WAVE_DROPPER_METRICS_TABLE,
      rows: [
        {
          wave_id: alphaSubwave.id,
          dropper_id: author.profile_id!,
          drops_count: 5,
          participatory_drops_count: 0,
          latest_drop_timestamp: 2005
        },
        {
          wave_id: betaSubwave.id,
          dropper_id: author.profile_id!,
          drops_count: 4,
          participatory_drops_count: 0,
          latest_drop_timestamp: 2004
        }
      ]
    }
  ],
  () => {
    it('excludes subwaves from top-level search results', async () => {
      const waves = await repo.searchWaves(
        {
          limit: 10,
          direct_message: false
        },
        ['hidden-parent-group'],
        ctx
      );

      expect(waves.map((wave) => wave.id)).toEqual([
        hiddenParentWave.id,
        parentWave.id
      ]);
    });

    it('lists visible subwaves alphabetically by default', async () => {
      const subwaves = await repo.findSubwaves(
        {
          parentWaveId: parentWave.id,
          eligibleGroups: [],
          limit: 10,
          offset: 0,
          sort: WaveSubwavesSort.NAME
        },
        ctx
      );

      expect(subwaves.map((wave) => wave.id)).toEqual([
        alphaSubwave.id,
        betaSubwave.id
      ]);
    });

    it('hides subwaves when the parent is not visible', async () => {
      await expect(
        repo.findWavesByIdsEligibleForRead(
          [publicSubwaveOfHiddenParent.id],
          [],
          undefined
        )
      ).resolves.toEqual([]);

      await expect(
        repo.findWavesByIdsEligibleForRead(
          [publicSubwaveOfHiddenParent.id],
          ['hidden-parent-group'],
          undefined
        )
      ).resolves.toEqual([
        expect.objectContaining({ id: publicSubwaveOfHiddenParent.id })
      ]);
    });
  }
);

const slowModeCooldownMs = Time.minutes(5).toMillis();
const recentDropTimestamp = Time.minutesAgo(1).toMillis();
const expiredDropTimestamp = Time.minutesAgo(10).toMillis();
const staleCooldownTimestamp = Time.minutesFromNow(30).toMillis();
const slowModeWave = aWave(
  {
    created_by: author.profile_id!,
    chat_slow_mode_cooldown_ms: slowModeCooldownMs
  },
  { id: 'wave-slow-mode', serial_no: 3, name: 'Slow Mode Wave' }
);
const reserveSlowModeWave = aWave(
  {
    created_by: author.profile_id!,
    chat_slow_mode_cooldown_ms: slowModeCooldownMs
  },
  { id: 'wave-slow-mode-reserve', serial_no: 4, name: 'Slow Reserve Wave' }
);

describeWithSeed(
  'WavesApiDb chat slow mode cooldown reads',
  [
    withIdentities([author]),
    withWaves([slowModeWave]),
    {
      table: DROPS_TABLE,
      rows: [
        {
          id: 'recent-chat-drop',
          wave_id: slowModeWave.id,
          author_id: author.profile_id!,
          created_at: recentDropTimestamp,
          updated_at: null,
          title: null,
          parts_count: 1,
          reply_to_drop_id: null,
          reply_to_part_id: null,
          drop_type: DropType.CHAT,
          signature: null,
          hide_link_preview: false
        }
      ]
    }
  ],
  () => {
    it('infers next drop timestamp from recent chat drops when no cooldown row exists', async () => {
      await expect(
        repo.findWaveChatDropCooldownsByWaveIds(
          {
            profileId: author.profile_id!,
            waveIds: [slowModeWave.id]
          },
          ctx
        )
      ).resolves.toEqual({
        [slowModeWave.id]: expect.objectContaining({
          wave_id: slowModeWave.id,
          profile_id: author.profile_id!,
          next_drop_timestamp: recentDropTimestamp + slowModeCooldownMs
        })
      });
    });
  }
);

describeWithSeed(
  'WavesApiDb chat slow mode cooldown reconciliation',
  [
    withIdentities([author]),
    withWaves([slowModeWave, reserveSlowModeWave]),
    {
      table: DROPS_TABLE,
      rows: [
        {
          id: 'recent-chat-drop',
          wave_id: slowModeWave.id,
          author_id: author.profile_id!,
          created_at: recentDropTimestamp,
          updated_at: null,
          title: null,
          parts_count: 1,
          reply_to_drop_id: null,
          reply_to_part_id: null,
          drop_type: DropType.CHAT,
          signature: null,
          hide_link_preview: false
        },
        {
          id: 'expired-chat-drop',
          wave_id: reserveSlowModeWave.id,
          author_id: author.profile_id!,
          created_at: expiredDropTimestamp,
          updated_at: null,
          title: null,
          parts_count: 1,
          reply_to_drop_id: null,
          reply_to_part_id: null,
          drop_type: DropType.CHAT,
          signature: null,
          hide_link_preview: false
        }
      ]
    },
    {
      table: WAVE_CHAT_DROP_COOLDOWNS_TABLE,
      rows: [
        {
          wave_id: slowModeWave.id,
          profile_id: author.profile_id!,
          next_drop_timestamp: staleCooldownTimestamp,
          created_at: 1,
          updated_at: 1
        },
        {
          wave_id: reserveSlowModeWave.id,
          profile_id: author.profile_id!,
          next_drop_timestamp: staleCooldownTimestamp,
          created_at: 1,
          updated_at: 1
        }
      ]
    }
  ],
  () => {
    it('recomputes and persists stale stored cooldown rows on read', async () => {
      const expectedNextDropTimestamp =
        recentDropTimestamp + slowModeCooldownMs;

      await expect(
        repo.findWaveChatDropCooldownsByWaveIds(
          {
            profileId: author.profile_id!,
            waveIds: [slowModeWave.id]
          },
          ctx
        )
      ).resolves.toEqual({
        [slowModeWave.id]: expect.objectContaining({
          wave_id: slowModeWave.id,
          profile_id: author.profile_id!,
          next_drop_timestamp: expectedNextDropTimestamp
        })
      });

      const stored = await sqlExecutor.oneOrNull<{
        next_drop_timestamp: number;
      }>(
        `select next_drop_timestamp
         from ${WAVE_CHAT_DROP_COOLDOWNS_TABLE}
         where wave_id = :waveId and profile_id = :profileId`,
        { waveId: slowModeWave.id, profileId: author.profile_id! }
      );
      expect(Number(stored?.next_drop_timestamp)).toBe(
        expectedNextDropTimestamp
      );
    });

    it('recomputes stale stored cooldown rows before enforcing reserve', async () => {
      const now = Time.currentMillis();

      await sqlExecutor.executeNativeQueriesInTransaction(
        async (connection) => {
          await expect(
            repo.reserveWaveChatDropCooldown(
              {
                waveId: reserveSlowModeWave.id,
                profileId: author.profile_id!,
                now,
                cooldownMs: Time.hours(1).toMillis()
              },
              { timer: undefined, connection }
            )
          ).resolves.toBeNull();
        }
      );

      const stored = await sqlExecutor.oneOrNull<{
        next_drop_timestamp: number;
      }>(
        `select next_drop_timestamp
         from ${WAVE_CHAT_DROP_COOLDOWNS_TABLE}
         where wave_id = :waveId and profile_id = :profileId`,
        { waveId: reserveSlowModeWave.id, profileId: author.profile_id! }
      );
      expect(Number(stored?.next_drop_timestamp)).toBe(
        now + slowModeCooldownMs
      );
    });
  }
);
