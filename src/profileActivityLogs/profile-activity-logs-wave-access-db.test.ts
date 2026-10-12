import 'reflect-metadata';
import { PROFILES_ACTIVITY_LOGS_TABLE } from '@/constants';
import { ProfileActivityLogType } from '@/entities/IProfileActivityLog';
import { RateMatter } from '@/entities/IRating';
import { RequestContext } from '@/request.context';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import { aWave, withWaves } from '@/tests/fixtures/wave.fixture';
import {
  ProfileActivityLogsDb,
  ProfileLogSearchParams
} from './profile-activity-logs.db';

const MEMBER_GROUP = 'member-group';
const publicWave = aWave({});
const memberWave = aWave({ visibility_group_id: MEMBER_GROUP });
const memberSubwave = aWave({ parent_wave_id: memberWave.id });
const otherWave = aWave({ visibility_group_id: 'other-group' });

function aLog({
  id,
  type,
  minute,
  target_id = null,
  additional_data_1 = null,
  additional_data_2 = null
}: {
  id: string;
  type: ProfileActivityLogType;
  minute: number;
  target_id?: string | null;
  additional_data_1?: string | null;
  additional_data_2?: string | null;
}) {
  return {
    id,
    profile_id: 'profile-1',
    target_id,
    contents: JSON.stringify({}),
    type,
    proxy_id: null,
    additional_data_1,
    additional_data_2,
    created_at: new Date(Date.UTC(2026, 0, 1, 0, minute))
  };
}

const logs = [
  aLog({
    id: 'public-drop',
    type: ProfileActivityLogType.DROP_CREATED,
    minute: 1,
    target_id: 'drop-1',
    additional_data_1: 'CHAT',
    additional_data_2: publicWave.id
  }),
  aLog({
    id: 'member-drop',
    type: ProfileActivityLogType.DROP_CREATED,
    minute: 2,
    target_id: 'drop-2',
    additional_data_1: 'CHAT',
    additional_data_2: memberWave.id
  }),
  aLog({
    id: 'member-subwave-reaction',
    type: ProfileActivityLogType.DROP_REACTED,
    minute: 3,
    target_id: 'drop-3',
    additional_data_1: 'author-1',
    additional_data_2: memberSubwave.id
  }),
  aLog({
    id: 'other-vote',
    type: ProfileActivityLogType.DROP_VOTE_EDIT,
    minute: 4,
    target_id: 'drop-4',
    additional_data_1: 'author-1',
    additional_data_2: otherWave.id
  }),
  aLog({
    id: 'unknown-wave-clap',
    type: ProfileActivityLogType.DROP_CLAPPED,
    minute: 5,
    target_id: 'drop-5'
  }),
  aLog({
    id: 'profile-rep',
    type: ProfileActivityLogType.RATING_EDIT,
    minute: 6,
    target_id: 'profile-2',
    additional_data_1: RateMatter.REP,
    additional_data_2: 'category'
  }),
  aLog({
    id: 'member-wave-rep',
    type: ProfileActivityLogType.RATING_EDIT,
    minute: 7,
    target_id: memberWave.id,
    additional_data_1: RateMatter.WAVE_REP,
    additional_data_2: 'category'
  }),
  aLog({
    id: 'handle',
    type: ProfileActivityLogType.HANDLE_EDIT,
    minute: 8
  }),
  aLog({
    id: 'legacy-comment-without-wave',
    type: ProfileActivityLogType.DROP_COMMENT,
    minute: 0,
    target_id: 'drop-6'
  })
];

describeWithSeed(
  'ProfileActivityLogsDb wave read access',
  [
    withWaves([publicWave, memberWave, memberSubwave, otherWave]),
    { table: PROFILES_ACTIVITY_LOGS_TABLE, rows: logs }
  ],
  () => {
    const repo = new ProfileActivityLogsDb(() => sqlExecutor, {} as any);
    const ctx: RequestContext = { timer: undefined };

    async function searchIds(
      params: Partial<ProfileLogSearchParams>
    ): Promise<string[]> {
      const results = await repo.searchLogs(
        {
          group_id: null,
          viewer_eligible_group_ids: [],
          pageRequest: { page: 1, page_size: 50 },
          includeProfileIdToIncoming: false,
          order: 'desc',
          ...params
        },
        ctx
      );
      return results.map((log) => log.id);
    }

    it('returns only public wave activity to anonymous viewers', async () => {
      await expect(searchIds({ profile_id: 'profile-1' })).resolves.toEqual([
        'handle',
        'profile-rep',
        'public-drop'
      ]);
    });

    it('returns activity in waves and subwaves the viewer can read', async () => {
      await expect(
        searchIds({
          profile_id: 'profile-1',
          viewer_eligible_group_ids: [MEMBER_GROUP]
        })
      ).resolves.toEqual([
        'handle',
        'member-wave-rep',
        'profile-rep',
        'member-subwave-reaction',
        'member-drop',
        'public-drop'
      ]);
    });

    it('applies the same rules to per-type branches', async () => {
      await expect(
        searchIds({
          profile_id: 'profile-1',
          viewer_eligible_group_ids: [MEMBER_GROUP],
          type: [
            ProfileActivityLogType.DROP_VOTE_EDIT,
            ProfileActivityLogType.DROP_CLAPPED,
            ProfileActivityLogType.DROP_COMMENT,
            ProfileActivityLogType.RATING_EDIT
          ]
        })
      ).resolves.toEqual(['member-wave-rep', 'profile-rep']);
    });

    it('applies the same rules without a profile filter', async () => {
      await expect(
        searchIds({
          type: [
            ProfileActivityLogType.DROP_CREATED,
            ProfileActivityLogType.DROP_REACTED
          ]
        })
      ).resolves.toEqual(['public-drop']);
      await expect(
        searchIds({
          target_id: memberWave.id,
          type: [ProfileActivityLogType.RATING_EDIT],
          rating_matter: RateMatter.WAVE_REP,
          viewer_eligible_group_ids: [MEMBER_GROUP]
        })
      ).resolves.toEqual(['member-wave-rep']);
    });

    it('filters before paging so hidden rows do not fill pages', async () => {
      const dropTypes = [
        ProfileActivityLogType.DROP_CREATED,
        ProfileActivityLogType.DROP_REACTED,
        ProfileActivityLogType.DROP_VOTE_EDIT,
        ProfileActivityLogType.DROP_CLAPPED
      ];

      await expect(
        searchIds({
          profile_id: 'profile-1',
          type: dropTypes,
          pageRequest: { page: 1, page_size: 1 }
        })
      ).resolves.toEqual(['public-drop']);
      await expect(
        searchIds({
          profile_id: 'profile-1',
          type: dropTypes,
          pageRequest: { page: 2, page_size: 1 }
        })
      ).resolves.toEqual([]);
    });
  }
);
