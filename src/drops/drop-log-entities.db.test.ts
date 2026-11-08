import 'reflect-metadata';
import { PROFILES_ACTIVITY_LOGS_TABLE } from '@/constants';
import { PageSortDirection } from '@/api/page-request';
import { ProfileActivityLogType } from '@/entities/IProfileActivityLog';
import { RequestContext } from '@/request.context';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import { DropsDb } from './drops.db';

const repo = new DropsDb(() => sqlExecutor);
const ctx: RequestContext = { timer: undefined };

const log = (
  id: string,
  dropId: string,
  waveId: string,
  type: ProfileActivityLogType,
  minute: number
) => ({
  id,
  profile_id: 'profile-1',
  target_id: dropId,
  type,
  additional_data_2: waveId,
  contents: {},
  created_at: new Date(Date.UTC(2026, 10, 7, 12, minute))
});

describeWithSeed(
  'DropsDb drop and wave activity logs',
  [
    {
      table: PROFILES_ACTIVITY_LOGS_TABLE,
      rows: [
        log(
          'vote-1',
          'drop-1',
          'wave-1',
          ProfileActivityLogType.DROP_VOTE_EDIT,
          1
        ),
        log(
          'vote-2',
          'drop-1',
          'wave-1',
          ProfileActivityLogType.DROP_VOTE_EDIT,
          3
        ),
        log(
          'created-1',
          'drop-1',
          'wave-1',
          ProfileActivityLogType.DROP_CREATED,
          0
        ),
        log(
          'vote-other-drop',
          'drop-2',
          'wave-1',
          ProfileActivityLogType.DROP_VOTE_EDIT,
          2
        ),
        log(
          'vote-other-wave',
          'drop-1',
          'wave-2',
          ProfileActivityLogType.DROP_VOTE_EDIT,
          4
        )
      ]
    }
  ],
  () => {
    const page = {
      offset: 0,
      limit: 20,
      sort_direction: PageSortDirection.DESC
    };

    it("returns one drop's logs of the requested types, newest first", async () => {
      const logs = await repo.findDropLogEntities(
        {
          ...page,
          wave_id: 'wave-1',
          drop_id: 'drop-1',
          log_types: [
            ProfileActivityLogType.DROP_VOTE_EDIT,
            ProfileActivityLogType.DROP_CREATED
          ]
        },
        ctx
      );
      expect(logs.map((it) => it.id)).toEqual([
        'vote-2',
        'vote-1',
        'created-1'
      ]);
    });

    it("returns a whole wave's logs under the budget", async () => {
      const logs = await repo.findDropLogEntities(
        {
          ...page,
          wave_id: 'wave-1',
          drop_id: null,
          log_types: [ProfileActivityLogType.DROP_VOTE_EDIT]
        },
        ctx
      );
      expect(logs.map((it) => it.id)).toEqual([
        'vote-2',
        'vote-other-drop',
        'vote-1'
      ]);
    });

    it("returns one drop's vote edits in that wave, oldest first on request", async () => {
      const logs = await repo.findDropVoteEditLogEntities(
        {
          ...page,
          sort_direction: PageSortDirection.ASC,
          wave_id: 'wave-1',
          drop_id: 'drop-1'
        },
        ctx
      );
      expect(logs.map((it) => it.id)).toEqual(['vote-1', 'vote-2']);
    });
  }
);
