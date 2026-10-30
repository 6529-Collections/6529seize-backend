import { AuthenticationContext } from '@/auth-context';
import { ProfileActivityLogType } from '@/entities/IProfileActivityLog';
import { SqlExecutor } from '@/sql-executor';
import { ProfileActivityLogsDb } from './profile-activity-logs.db';

it('excludes identifying anonymous drop activity in every profile branch before pagination', async () => {
  const execute = jest.fn().mockResolvedValue([]);
  const repository = new ProfileActivityLogsDb(
    () => ({ execute }) as unknown as SqlExecutor,
    { getSqlAndParamsByGroupId: jest.fn() } as never
  );
  await repository.searchLogs(
    {
      profile_id: 'artist',
      type: [ProfileActivityLogType.DROP_CREATED],
      includeProfileIdToIncoming: true,
      viewer_eligible_group_ids: [],
      group_id: null,
      order: 'desc',
      pageRequest: { page: 2, page_size: 10 }
    },
    { authenticationContext: AuthenticationContext.fromProfileId('reader') }
  );
  const [sql, params] = execute.mock.calls[0];
  const branches = sql.split('UNION ALL').slice(0, 3);
  expect(branches).toHaveLength(3);
  for (const branch of branches) {
    expect(
      branch.indexOf('anonymous_log_entry.drop_id = pa_logs.target_id')
    ).toBeLessThan(branch.indexOf('LIMIT'));
    expect(branch).toContain('anonymous_log_entry.won_at is null');
  }
  expect(params.anonymityViewerId).toBe('reader');
  expect(params.anonymityDropLogTypes).toContain(
    ProfileActivityLogType.DROP_CREATED
  );
});

it('leaves profile changes unrelated to drops outside the anonymity filter', async () => {
  const execute = jest.fn().mockResolvedValue([]);
  const repository = new ProfileActivityLogsDb(
    () => ({ execute }) as unknown as SqlExecutor,
    { getSqlAndParamsByGroupId: jest.fn() } as never
  );
  await repository.searchLogs(
    {
      type: [ProfileActivityLogType.HANDLE_EDIT],
      includeProfileIdToIncoming: false,
      viewer_eligible_group_ids: [],
      group_id: null,
      order: 'desc',
      pageRequest: { page: 1, page_size: 10 }
    },
    {}
  );
  const [sql] = execute.mock.calls[0];
  expect(sql).not.toContain('anonymous_log_entry');
});
