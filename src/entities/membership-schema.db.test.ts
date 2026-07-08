import 'reflect-metadata';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import {
  MEMBERSHIP_REFRESH_REQUESTS_TABLE,
  MEMBERSHIP_WATERMARKS_TABLE,
  USER_GROUP_MEMBERS_TABLE
} from '@/constants';

describeWithSeed('Membership materialization schema', [], () => {
  it('user_group_members: inserts and reads back a row', async () => {
    await sqlExecutor.execute(
      `insert into ${USER_GROUP_MEMBERS_TABLE}
         (group_id, profile_id, spec_version, as_of_millis)
       values (:groupId, :profileId, :specVersion, :asOfMillis)`,
      {
        groupId: 'group-1',
        profileId: 'profile-1',
        specVersion: 3,
        asOfMillis: 1751900000000
      }
    );
    const rows = await sqlExecutor.execute<{
      group_id: string;
      profile_id: string;
      spec_version: number;
      as_of_millis: number | string;
    }>(
      `select group_id, profile_id, spec_version, as_of_millis
       from ${USER_GROUP_MEMBERS_TABLE}
       where profile_id = :profileId and group_id = :groupId`,
      { profileId: 'profile-1', groupId: 'group-1' }
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].group_id).toBe('group-1');
    expect(rows[0].profile_id).toBe('profile-1');
    expect(Number(rows[0].spec_version)).toBe(3);
    expect(Number(rows[0].as_of_millis)).toBe(1751900000000);
  });

  it('membership_refresh_requests: inserts and reads back a row with bookkeeping defaults', async () => {
    await sqlExecutor.execute(
      `insert into ${MEMBERSHIP_REFRESH_REQUESTS_TABLE}
         (scope, target_id, reason, dirty_at, created_at, updated_at)
       values (:scope, :targetId, :reason, :dirtyAt, :createdAt, :updatedAt)`,
      {
        scope: 'PROFILE',
        targetId: 'profile-1',
        reason: 'RATING_CHANGED',
        dirtyAt: 1751900000001,
        createdAt: 1751900000001,
        updatedAt: 1751900000001
      }
    );
    const rows = await sqlExecutor.execute<{
      scope: string;
      target_id: string;
      reason: string;
      dirty_at: number | string;
      attempts: number;
      last_error: string | null;
      created_at: number | string;
      updated_at: number | string;
    }>(
      `select scope, target_id, reason, dirty_at, attempts, last_error, created_at, updated_at
       from ${MEMBERSHIP_REFRESH_REQUESTS_TABLE}
       where scope = :scope and target_id = :targetId`,
      { scope: 'PROFILE', targetId: 'profile-1' }
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].scope).toBe('PROFILE');
    expect(rows[0].target_id).toBe('profile-1');
    expect(rows[0].reason).toBe('RATING_CHANGED');
    expect(Number(rows[0].dirty_at)).toBe(1751900000001);
    expect(Number(rows[0].attempts)).toBe(0);
    expect(rows[0].last_error).toBeNull();
    expect(Number(rows[0].created_at)).toBe(1751900000001);
    expect(Number(rows[0].updated_at)).toBe(1751900000001);
  });

  it('membership_watermarks: inserts and reads back a row', async () => {
    await sqlExecutor.execute(
      `insert into ${MEMBERSHIP_WATERMARKS_TABLE}
         (dimension, watermark_millis, detail, updated_at_millis)
       values (:dimension, :watermarkMillis, :detail, :updatedAtMillis)`,
      {
        dimension: 'RATINGS',
        watermarkMillis: 1751900000002,
        detail: null,
        updatedAtMillis: 1751900000003
      }
    );
    const rows = await sqlExecutor.execute<{
      dimension: string;
      watermark_millis: number | string;
      detail: string | null;
      updated_at_millis: number | string;
    }>(
      `select dimension, watermark_millis, detail, updated_at_millis
       from ${MEMBERSHIP_WATERMARKS_TABLE}
       where dimension = :dimension`,
      { dimension: 'RATINGS' }
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].dimension).toBe('RATINGS');
    expect(Number(rows[0].watermark_millis)).toBe(1751900000002);
    expect(rows[0].detail).toBeNull();
    expect(Number(rows[0].updated_at_millis)).toBe(1751900000003);
  });
});
