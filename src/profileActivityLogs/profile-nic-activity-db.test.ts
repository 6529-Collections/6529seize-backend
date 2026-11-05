import 'reflect-metadata';
import { sqlExecutor } from '@/sql-executor';
import { PROFILES_ACTIVITY_LOGS_TABLE } from '@/constants';
import { ProfileActivityLogType as Type } from '@/entities/IProfileActivityLog';
import { userGroupsService } from '@/api/community-members/user-groups.service';
import { describeWithSeed } from '@/tests/_setup/seed';
import { ProfileActivityLogsDb } from './profile-activity-logs.db';
import { ProfileNicActivityPosition } from './profile-nic-activity.query';

const logs = Array.from({ length: 1375 }, (_, i) => ({
  id: `nic-${String(i).padStart(6, '0')}`,
  profile_id: 'subject',
  proxy_id: i % 7 === 0 ? 'subject' : null,
  target_id: i % 3 === 0 ? 'subject' : 'visitor',
  type: i < 1305 ? Type.PFP_EDIT : Type.RATING_EDIT,
  additional_data_1:
    i < 1305 ? null : ['REP', 'CIC', 'WAVE_REP', null, 'FUTURE'][i % 5],
  contents: '{}',
  created_at:
    i < 3 ? null : new Date(Date.UTC(2025, 0, 1, 0, 0, Math.floor(i / 4)))
}));

describeWithSeed(
  'NIC activity cursor database',
  { table: PROFILES_ACTIVITY_LOGS_TABLE, rows: logs },
  () => {
    const db = new ProfileActivityLogsDb(() => sqlExecutor, userGroupsService);
    it('uses the entity DATETIME precision expected by the cursor boundary', async () => {
      const columns = await sqlExecutor.execute<{ precision: number }>(
        `SELECT DATETIME_PRECISION AS \`precision\` FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=:table AND COLUMN_NAME='created_at'`,
        { table: PROFILES_ACTIVITY_LOGS_TABLE }
      );
      expect(columns).toEqual([{ precision: 0 }]);
    });
    it('keeps the exact non-REP history with full pages, ties, null dates and overlapping matches', async () => {
      for (const direction of ['all', 'outgoing', 'incoming'] as const) {
        for (const types of [[], [Type.RATING_EDIT], [Type.PFP_EDIT]]) {
          const matching = logs.filter(
            (log) =>
              (direction !== 'incoming' || log.target_id === 'subject') &&
              (!types.length || types.includes(log.type)) &&
              (log.type !== Type.RATING_EDIT ||
                !['REP', 'WAVE_REP'].includes(log.additional_data_1 ?? ''))
          );
          const expected = await sqlExecutor.execute<{ id: string }>(
            `SELECT id FROM ${PROFILES_ACTIVITY_LOGS_TABLE} WHERE id IN (:ids) ORDER BY created_at DESC,id DESC`,
            { ids: matching.map((log) => log.id) }
          );
          const actual: string[] = [];
          let after: ProfileNicActivityPosition | null = null;
          do {
            const result = await db.searchNicLogs(
              { profileId: 'subject', direction, types, size: 10, after },
              [],
              {}
            );
            const page = result.logs.slice(0, 10);
            expect(page.map((log) => log.id)).toEqual(
              expected
                .slice(actual.length, actual.length + 10)
                .map((log) => log.id)
            );
            actual.push(...page.map((log) => log.id));
            expect(Boolean(result.nextPosition)).toBe(
              actual.length < expected.length
            );
            after = result.nextPosition;
          } while (after);
          expect(actual).toHaveLength(expected.length);
          expect(new Set(actual).size).toBe(actual.length);
        }
      }
    });
    it('retains a page boundary when a newer identity entry arrives', async () => {
      const search = {
        profileId: 'subject',
        direction: 'outgoing' as const,
        types: [],
        size: 10,
        after: null
      };
      const first = await db.searchNicLogs(search, [], {});
      const second = await db.searchNicLogs(
        { ...search, after: first.nextPosition },
        [],
        {}
      );
      await sqlExecutor.execute(`INSERT INTO ${PROFILES_ACTIVITY_LOGS_TABLE} (id,profile_id,type,contents,created_at)
      VALUES ('new-arrival','subject','HANDLE_EDIT','{}','2026-11-05 12:00:00')`);
      const again = await db.searchNicLogs(
        { ...search, after: first.nextPosition },
        [],
        {}
      );
      expect(again.logs.map((log) => log.id)).toEqual(
        second.logs.map((log) => log.id)
      );
      expect(again.nextPosition).toEqual(second.nextPosition);
    });
    it('returns a true empty page for profiles with only REP, and keeps proxy-only matches', async () => {
      await sqlExecutor.execute(`INSERT INTO ${PROFILES_ACTIVITY_LOGS_TABLE} (id,profile_id,proxy_id,type,additional_data_1,contents)
      VALUES ('only-rep','rep-only',NULL,'RATING_EDIT','REP','{}'),
        ('only-wave-rep','rep-only',NULL,'RATING_EDIT','WAVE_REP','{}'),
        ('proxy-only','author','proxy-viewer','HANDLE_EDIT','REP','{}')`);
      const search = {
        profileId: 'rep-only',
        direction: 'outgoing' as const,
        types: [],
        size: 10,
        after: null
      };
      expect(await db.searchNicLogs(search, [], {})).toEqual({
        logs: [],
        nextPosition: null
      });
      const proxy = await db.searchNicLogs(
        { ...search, profileId: 'proxy-viewer' },
        [],
        {}
      );
      expect(proxy.logs.map((log) => log.id)).toEqual(['proxy-only']);
    });
  }
);
