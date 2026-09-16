import { MEMBERSHIP_REFRESH_TARGETS_TABLE } from '@/constants';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import { withMembershipPrimaryTransaction } from './membership-primary';
import { MembershipRefreshTargetsDb } from './membership-refresh-targets.db';

const requests = [
  { scope: 'PROFILE' as const, target_id: 'profile-1', reason: 'input' },
  { scope: 'GROUP' as const, target_id: 'group-1', reason: 'input' },
  { scope: 'FULL' as const, target_id: '*', reason: 'input' }
];

describeWithSeed('membership backlog without processing', [], () => {
  it('coalesces repeated invalidations into one durable row per target key', async () => {
    const targets = new MembershipRefreshTargetsDb(() => sqlExecutor);
    await withMembershipPrimaryTransaction(sqlExecutor, async (ctx) => {
      await targets.request([...requests, requests[0]], ctx);
      await targets.request(requests, ctx);
    });

    const rows = await sqlExecutor.execute<{
      scope: string;
      target_id: string;
      requested_version: string;
      completed_version: string;
      available_at_millis: string | null;
    }>(
      `SELECT scope,target_id,CAST(requested_version AS CHAR) requested_version,
      CAST(completed_version AS CHAR) completed_version,
      CAST(available_at_millis AS CHAR) available_at_millis
      FROM ${MEMBERSHIP_REFRESH_TARGETS_TABLE} ORDER BY scope,target_id`
    );
    expect(rows).toHaveLength(3);
    expect(rows.map(({ scope, target_id }) => `${scope}/${target_id}`)).toEqual(
      ['FULL/*', 'GROUP/group-1', 'PROFILE/profile-1']
    );
    expect(
      rows.every(
        (row) =>
          row.requested_version === '2' &&
          row.completed_version === '0' &&
          row.available_at_millis !== null
      )
    ).toBe(true);
  });
});
