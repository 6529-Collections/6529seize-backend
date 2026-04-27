import 'reflect-metadata';
import {
  DROP_CURATIONS_TABLE,
  DROP_MEDIA_TABLE,
  DROPS_PARTS_TABLE,
  DROPS_TABLE,
  PROFILE_WAVES_TABLE,
  WAVE_CURATIONS_TABLE
} from '@/constants';
import { DropType } from '@/entities/IDrop';
import { RequestContext } from '@/request.context';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import { anIdentity, withIdentities } from '@/tests/fixtures/identity.fixture';
import { aWave, withWaves } from '@/tests/fixtures/wave.fixture';
import { DropsDb } from './drops.db';

const repo = new DropsDb(() => sqlExecutor);
const ctx: RequestContext = { timer: undefined };

const publicWaveA = aWave(
  { visibility_group_id: null },
  { id: 'wave-public-a', serial_no: 1, name: 'Public A' }
);
const publicWaveB = aWave(
  { visibility_group_id: null },
  { id: 'wave-public-b', serial_no: 2, name: 'Public B' }
);
const privateWave = aWave(
  { visibility_group_id: 'group-1', admin_group_id: 'admin-group' },
  { id: 'wave-private', serial_no: 3, name: 'Private Wave' }
);

const authorAlice = anIdentity(
  {},
  {
    consolidation_key: 'identity-alice',
    profile_id: 'profile-alice',
    primary_address: 'wallet-alice',
    handle: 'alice'
  }
);

const explicitProfileWave = aWave(
  { visibility_group_id: null, is_direct_message: false },
  { id: 'profile-wave-explicit', serial_no: 11, name: 'Profile Explicit' }
);
const fallbackProfileWave = aWave(
  { visibility_group_id: null, is_direct_message: false },
  { id: 'profile-wave-fallback', serial_no: 12, name: 'Profile Fallback' }
);
const privateProfileWave = aWave(
  { visibility_group_id: 'private-profile-group', is_direct_message: false },
  { id: 'profile-wave-private', serial_no: 13, name: 'Profile Private' }
);
const directMessageProfileWave = aWave(
  { visibility_group_id: null, is_direct_message: true },
  { id: 'profile-wave-dm', serial_no: 14, name: 'Profile DM' }
);

describeWithSeed(
  'DropsDb curated profile wave drops',
  [
    withWaves([
      explicitProfileWave,
      fallbackProfileWave,
      privateProfileWave,
      directMessageProfileWave
    ]),
    {
      table: DROPS_TABLE,
      rows: [
        aDropRow({
          id: 'drop-explicit-old',
          serial_no: 301,
          wave_id: explicitProfileWave.id,
          author_id: 'profile-alice',
          created_at: 301
        }),
        aDropRow({
          id: 'drop-explicit-selected',
          serial_no: 302,
          wave_id: explicitProfileWave.id,
          author_id: 'profile-bob',
          created_at: 302,
          reply_to_drop_id: 'drop-parent'
        }),
        aDropRow({
          id: 'drop-fallback-old',
          serial_no: 304,
          wave_id: fallbackProfileWave.id,
          author_id: 'profile-carol',
          created_at: 304
        }),
        aDropRow({
          id: 'drop-fallback-newer',
          serial_no: 305,
          wave_id: fallbackProfileWave.id,
          author_id: 'profile-dave',
          created_at: 305
        }),
        aDropRow({
          id: 'drop-private-profile',
          serial_no: 306,
          wave_id: privateProfileWave.id,
          author_id: 'profile-alice',
          created_at: 306
        }),
        aDropRow({
          id: 'drop-dm-profile',
          serial_no: 307,
          wave_id: directMessageProfileWave.id,
          author_id: 'profile-bob',
          created_at: 307
        })
      ]
    },
    {
      table: WAVE_CURATIONS_TABLE,
      rows: [
        {
          id: 'curation-explicit-old',
          name: 'Old explicit',
          wave_id: explicitProfileWave.id,
          community_group_id: 'group-public',
          created_at: 1,
          updated_at: 1
        },
        {
          id: 'curation-explicit-selected',
          name: 'Selected explicit',
          wave_id: explicitProfileWave.id,
          community_group_id: 'group-public',
          created_at: 2,
          updated_at: 2
        },
        {
          id: 'curation-fallback-old',
          name: 'Old fallback',
          wave_id: fallbackProfileWave.id,
          community_group_id: 'group-public',
          created_at: 1,
          updated_at: 1
        },
        {
          id: 'curation-fallback-newer',
          name: 'New fallback',
          wave_id: fallbackProfileWave.id,
          community_group_id: 'group-public',
          created_at: 2,
          updated_at: 2
        },
        {
          id: 'curation-private-profile',
          name: 'Private profile',
          wave_id: privateProfileWave.id,
          community_group_id: 'group-public',
          created_at: 1,
          updated_at: 1
        },
        {
          id: 'curation-dm-profile',
          name: 'DM profile',
          wave_id: directMessageProfileWave.id,
          community_group_id: 'group-public',
          created_at: 1,
          updated_at: 1
        }
      ]
    },
    {
      table: DROP_CURATIONS_TABLE,
      rows: [
        {
          drop_id: 'drop-explicit-old',
          curation_id: 'curation-explicit-old',
          created_at: 1,
          updated_at: 1,
          wave_id: explicitProfileWave.id,
          curated_by: 'profile-explicit',
          priority_order: 1
        },
        {
          drop_id: 'drop-explicit-selected',
          curation_id: 'curation-explicit-selected',
          created_at: 2,
          updated_at: 2,
          wave_id: explicitProfileWave.id,
          curated_by: 'profile-explicit',
          priority_order: 1
        },
        {
          drop_id: 'drop-fallback-old',
          curation_id: 'curation-fallback-old',
          created_at: 3,
          updated_at: 3,
          wave_id: fallbackProfileWave.id,
          curated_by: 'profile-fallback',
          priority_order: 1
        },
        {
          drop_id: 'drop-fallback-newer',
          curation_id: 'curation-fallback-newer',
          created_at: 4,
          updated_at: 4,
          wave_id: fallbackProfileWave.id,
          curated_by: 'profile-fallback',
          priority_order: 1
        },
        {
          drop_id: 'drop-private-profile',
          curation_id: 'curation-private-profile',
          created_at: 5,
          updated_at: 5,
          wave_id: privateProfileWave.id,
          curated_by: 'profile-private',
          priority_order: 1
        },
        {
          drop_id: 'drop-dm-profile',
          curation_id: 'curation-dm-profile',
          created_at: 6,
          updated_at: 6,
          wave_id: directMessageProfileWave.id,
          curated_by: 'profile-dm',
          priority_order: 1
        }
      ]
    },
    {
      table: PROFILE_WAVES_TABLE,
      rows: [
        {
          profile_id: 'profile-explicit',
          wave_id: explicitProfileWave.id,
          profile_curation_id: 'curation-explicit-selected'
        },
        {
          profile_id: 'profile-fallback',
          wave_id: fallbackProfileWave.id,
          profile_curation_id: null
        },
        {
          profile_id: 'profile-private',
          wave_id: privateProfileWave.id,
          profile_curation_id: 'curation-private-profile'
        },
        {
          profile_id: 'profile-dm',
          wave_id: directMessageProfileWave.id,
          profile_curation_id: 'curation-dm-profile'
        }
      ]
    }
  ],
  () => {
    it('finds newest drops from effective public profile curations', async () => {
      const results = await repo.findCuratedProfileWaveDrops(
        {
          limit: 10,
          offset: 0
        },
        ctx
      );

      expect(results.map((it) => it.id)).toEqual([
        'drop-fallback-old',
        'drop-explicit-selected'
      ]);
      expect(
        results.find((it) => it.id === 'drop-explicit-selected')
          ?.reply_to_drop_id
      ).toBe('drop-parent');
    });

    it('paginates curated profile wave drops by global recency', async () => {
      const results = await repo.findCuratedProfileWaveDrops(
        {
          limit: 1,
          offset: 1
        },
        ctx
      );

      expect(results.map((it) => it.id)).toEqual(['drop-explicit-selected']);
    });
  }
);
const authorBob = anIdentity(
  {},
  {
    consolidation_key: 'identity-bob',
    profile_id: 'profile-bob',
    primary_address: 'wallet-bob',
    handle: 'bob'
  }
);
const authorCarol = anIdentity(
  {},
  {
    consolidation_key: 'identity-carol',
    profile_id: 'profile-carol',
    primary_address: 'wallet-carol',
    handle: 'carol'
  }
);
const authorDave = anIdentity(
  {},
  {
    consolidation_key: 'identity-dave',
    profile_id: 'profile-dave',
    primary_address: 'wallet-dave',
    handle: 'dave'
  }
);

function aDropRow({
  id,
  serial_no,
  wave_id,
  author_id,
  created_at,
  title = null,
  reply_to_drop_id = null
}: {
  id: string;
  serial_no: number;
  wave_id: string;
  author_id: string;
  created_at: number;
  title?: string | null;
  reply_to_drop_id?: string | null;
}) {
  return {
    id,
    serial_no,
    wave_id,
    author_id,
    created_at,
    title,
    parts_count: 2,
    drop_type: DropType.CHAT,
    reply_to_drop_id
  };
}

function aDropPartRow({
  drop_id,
  drop_part_id,
  content,
  quoted_drop_id = null
}: {
  drop_id: string;
  drop_part_id: number;
  content: string;
  quoted_drop_id?: string | null;
}) {
  return {
    drop_id,
    drop_part_id,
    content,
    quoted_drop_id
  };
}

function aDropMediaRow({
  drop_id,
  drop_part_id,
  url,
  mime_type
}: {
  drop_id: string;
  drop_part_id: number;
  url: string;
  mime_type: string;
}) {
  return {
    drop_id,
    drop_part_id,
    url,
    mime_type
  };
}

describeWithSeed(
  'DropsDb light drops',
  [
    withWaves([publicWaveA, publicWaveB, privateWave]),
    withIdentities([authorAlice, authorBob, authorCarol, authorDave]),
    {
      table: DROPS_TABLE,
      rows: [
        aDropRow({
          id: 'drop-public-a-old',
          serial_no: 101,
          wave_id: publicWaveA.id,
          author_id: authorAlice.profile_id!,
          created_at: 1001,
          title: 'Old public A'
        }),
        aDropRow({
          id: 'drop-private',
          serial_no: 102,
          wave_id: privateWave.id,
          author_id: authorDave.profile_id!,
          created_at: 1002
        }),
        aDropRow({
          id: 'drop-public-a-new',
          serial_no: 103,
          wave_id: publicWaveA.id,
          author_id: authorBob.profile_id!,
          created_at: 1003,
          reply_to_drop_id: 'drop-parent'
        }),
        aDropRow({
          id: 'drop-public-b',
          serial_no: 104,
          wave_id: publicWaveB.id,
          author_id: authorCarol.profile_id!,
          created_at: 1004
        })
      ]
    },
    {
      table: DROPS_PARTS_TABLE,
      rows: [
        aDropPartRow({
          drop_id: 'drop-public-a-old',
          drop_part_id: 1,
          content: 'Old public A part 1'
        }),
        aDropPartRow({
          drop_id: 'drop-private',
          drop_part_id: 1,
          content: 'Private part 1'
        }),
        aDropPartRow({
          drop_id: 'drop-public-a-new',
          drop_part_id: 1,
          content: 'Newest public A part 1',
          quoted_drop_id: 'quoted-drop-1'
        }),
        aDropPartRow({
          drop_id: 'drop-public-a-new',
          drop_part_id: 2,
          content: 'Newest public A part 2'
        }),
        aDropPartRow({
          drop_id: 'drop-public-b',
          drop_part_id: 1,
          content: 'Public B part 1'
        })
      ]
    },
    {
      table: WAVE_CURATIONS_TABLE,
      rows: [
        {
          id: 'curation-public-a-art',
          name: 'Art',
          wave_id: publicWaveA.id,
          community_group_id: 'group-public',
          created_at: 2001,
          updated_at: 2001
        },
        {
          id: 'curation-public-b-art',
          name: 'Art',
          wave_id: publicWaveB.id,
          community_group_id: 'group-public',
          created_at: 2002,
          updated_at: 2002
        },
        {
          id: 'curation-private-art',
          name: 'Art',
          wave_id: privateWave.id,
          community_group_id: 'group-public',
          created_at: 2003,
          updated_at: 2003
        },
        {
          id: 'curation-public-a-other',
          name: 'Other',
          wave_id: publicWaveA.id,
          community_group_id: 'group-public',
          created_at: 2004,
          updated_at: 2004
        }
      ]
    },
    {
      table: DROP_CURATIONS_TABLE,
      rows: [
        {
          drop_id: 'drop-public-a-old',
          curation_id: 'curation-public-a-art',
          created_at: 3001,
          updated_at: 3001,
          wave_id: publicWaveA.id,
          curated_by: authorAlice.profile_id!,
          priority_order: 1
        },
        {
          drop_id: 'drop-public-b',
          curation_id: 'curation-public-b-art',
          created_at: 3002,
          updated_at: 3002,
          wave_id: publicWaveB.id,
          curated_by: authorBob.profile_id!,
          priority_order: 1
        },
        {
          drop_id: 'drop-private',
          curation_id: 'curation-private-art',
          created_at: 3003,
          updated_at: 3003,
          wave_id: privateWave.id,
          curated_by: authorCarol.profile_id!,
          priority_order: 1
        },
        {
          drop_id: 'drop-public-a-new',
          curation_id: 'curation-public-a-other',
          created_at: 3004,
          updated_at: 3004,
          wave_id: publicWaveA.id,
          curated_by: authorDave.profile_id!,
          priority_order: 1
        },
        {
          drop_id: 'drop-public-a-old',
          curation_id: 'curation-public-a-other',
          created_at: 3005,
          updated_at: 3005,
          wave_id: publicWaveA.id,
          curated_by: authorAlice.profile_id!,
          priority_order: 2
        }
      ]
    },
    {
      table: DROP_MEDIA_TABLE,
      rows: [
        aDropMediaRow({
          drop_id: 'drop-public-a-new',
          drop_part_id: 1,
          url: 'https://example.com/new-public-a-1.png',
          mime_type: 'image/png'
        }),
        aDropMediaRow({
          drop_id: 'drop-public-a-new',
          drop_part_id: 2,
          url: 'https://example.com/new-public-a-2.mp4',
          mime_type: 'video/mp4'
        }),
        aDropMediaRow({
          drop_id: 'drop-private',
          drop_part_id: 1,
          url: 'https://example.com/private.png',
          mime_type: 'image/png'
        })
      ]
    }
  ],
  () => {
    it('finds the latest visible ids within a wave and respects max serial', async () => {
      await expect(
        repo.findLightDropIdsByWave(
          {
            limit: 10,
            max_serial_no: 103,
            min_serial_no: 0,
            older_first: false,
            group_ids_user_is_eligible_for: [],
            wave_id: publicWaveA.id
          },
          ctx
        )
      ).resolves.toEqual([
        { id: 'drop-public-a-new', serial_no: 103 },
        { id: 'drop-public-a-old', serial_no: 101 }
      ]);
    });

    it('returns no wave-scoped rows when the wave is not visible', async () => {
      await expect(
        repo.findLightDropIdsByWave(
          {
            limit: 10,
            max_serial_no: null,
            min_serial_no: null,
            older_first: false,
            group_ids_user_is_eligible_for: [],
            wave_id: privateWave.id
          },
          ctx
        )
      ).resolves.toEqual([]);
    });

    it('finds the latest visible ids globally and skips private waves without membership', async () => {
      await expect(
        repo.findVisibleLightDropIds(
          {
            limit: 10,
            min_serial_no: null,
            max_serial_no: null,
            older_first: false,
            group_ids_user_is_eligible_for: []
          },
          ctx
        )
      ).resolves.toEqual([
        { id: 'drop-public-b', serial_no: 104 },
        { id: 'drop-public-a-new', serial_no: 103 },
        { id: 'drop-public-a-old', serial_no: 101 }
      ]);
    });

    it('includes eligible private waves in the global selector', async () => {
      await expect(
        repo.findVisibleLightDropIds(
          {
            limit: 10,
            min_serial_no: null,
            max_serial_no: null,
            older_first: false,
            group_ids_user_is_eligible_for: ['group-1']
          },
          ctx
        )
      ).resolves.toEqual([
        { id: 'drop-public-b', serial_no: 104 },
        { id: 'drop-public-a-new', serial_no: 103 },
        { id: 'drop-private', serial_no: 102 },
        { id: 'drop-public-a-old', serial_no: 101 }
      ]);
    });

    it('does not include private waves for admin-group-only eligibility in the global selector', async () => {
      await expect(
        repo.findVisibleLightDropIds(
          {
            limit: 10,
            min_serial_no: null,
            max_serial_no: null,
            older_first: false,
            group_ids_user_is_eligible_for: ['admin-group']
          },
          ctx
        )
      ).resolves.toEqual([
        { id: 'drop-public-b', serial_no: 104 },
        { id: 'drop-public-a-new', serial_no: 103 },
        { id: 'drop-public-a-old', serial_no: 101 }
      ]);
    });

    it('does not include private wave-scoped rows for admin-group-only eligibility', async () => {
      await expect(
        repo.findLightDropIdsByWave(
          {
            limit: 10,
            max_serial_no: null,
            min_serial_no: null,
            older_first: false,
            group_ids_user_is_eligible_for: ['admin-group'],
            wave_id: privateWave.id
          },
          ctx
        )
      ).resolves.toEqual([]);
    });

    it('finds latest drops by curation name across visible waves', async () => {
      const results = await repo.findLatestDrops(
        {
          amount: 10,
          serial_no_less_than: null,
          group_ids_user_is_eligible_for: [],
          group_id: null,
          wave_id: null,
          curation_id: null,
          curation_name: 'Art',
          author_id: null,
          include_replies: false,
          drop_type: null,
          ids: null,
          contains_media: false
        },
        ctx
      );

      expect(results.map((it) => it.id)).toEqual([
        'drop-public-b',
        'drop-public-a-old'
      ]);
    });

    it('does not find latest drops by author through admin-group-only eligibility', async () => {
      const results = await repo.findLatestDrops(
        {
          amount: 10,
          serial_no_less_than: null,
          group_ids_user_is_eligible_for: ['admin-group'],
          group_id: null,
          wave_id: null,
          curation_id: null,
          curation_name: null,
          author_id: authorDave.profile_id,
          include_replies: false,
          drop_type: null,
          ids: null,
          contains_media: false
        },
        ctx
      );

      expect(results).toEqual([]);
    });

    it('does not find a private drop by id through admin-group-only eligibility', async () => {
      await expect(
        repo.findDropByIdWithEligibilityCheck(
          'drop-private',
          ['admin-group'],
          undefined
        )
      ).resolves.toBeNull();
      await expect(
        repo.findDropByIdWithEligibilityCheck(
          'drop-private',
          ['group-1'],
          undefined
        )
      ).resolves.toMatchObject({ id: 'drop-private' });
    });

    it('does not find private drop ids in a wave range through admin-group-only eligibility', async () => {
      await expect(
        repo.findDropIdsInWaveRange(
          {
            wave_id: privateWave.id,
            min_serial_no: 0,
            max_serial_no: 200,
            limit: 10,
            group_ids_user_is_eligible_for: ['admin-group']
          },
          ctx
        )
      ).resolves.toEqual([]);
      await expect(
        repo.findDropIdsInWaveRange(
          {
            wave_id: privateWave.id,
            min_serial_no: 0,
            max_serial_no: 200,
            limit: 10,
            group_ids_user_is_eligible_for: ['group-1']
          },
          ctx
        )
      ).resolves.toEqual([{ id: 'drop-private', serial_no: 102 }]);
    });

    it('finds drops in a curation by priority order', async () => {
      const results = await repo.findDropsByCurationPriorityOrder(
        {
          wave_id: publicWaveA.id,
          curation_id: 'curation-public-a-other',
          limit: 10,
          offset: 0
        },
        ctx
      );

      expect(
        results.map((it) => ({
          id: it.id,
          drop_priority_order: it.drop_priority_order
        }))
      ).toEqual([
        { id: 'drop-public-a-old', drop_priority_order: 2 },
        { id: 'drop-public-a-new', drop_priority_order: 1 }
      ]);
    });

    it('hydrates wave, author, first part and first-part media only', async () => {
      const results = await repo.findLightDropsByIds(
        ['drop-public-a-old', 'drop-public-a-new'],
        ctx
      );

      expect(results.map((it) => it.id)).toEqual([
        'drop-public-a-new',
        'drop-public-a-old'
      ]);
      expect(results[0]).toMatchObject({
        id: 'drop-public-a-new',
        wave_name: 'Public A',
        author: 'bob',
        created_at: 1003,
        part_drop_part_id: 1,
        part_content: 'Newest public A part 1',
        part_quoted_drop_id: 'quoted-drop-1'
      });
      expect(JSON.parse(results[0].medias_json ?? '[]')).toEqual([
        {
          url: 'https://example.com/new-public-a-1.png',
          mime_type: 'image/png'
        }
      ]);
    });
  }
);
