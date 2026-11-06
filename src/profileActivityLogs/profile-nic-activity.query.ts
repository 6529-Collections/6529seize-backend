import { PROFILES_ACTIVITY_LOGS_TABLE } from '@/constants';
import { ProfileActivityLogType } from '@/entities/IProfileActivityLog';

export interface ProfileNicActivityPosition {
  readonly id: string;
  // Database DATETIME text avoids timezone conversion at cursor boundaries.
  readonly createdAt: string | null;
}

export interface ProfileNicActivitySearch {
  readonly profileId: string;
  readonly direction: 'all' | 'incoming' | 'outgoing';
  readonly types: ProfileActivityLogType[];
  readonly size: number;
  readonly after: ProfileNicActivityPosition | null;
}

export function buildProfileNicActivityQuery(
  search: ProfileNicActivitySearch,
  access: { conditions: string[]; params: Record<string, unknown> }
) {
  const params: Record<string, unknown> = {
    ...access.params,
    nicProfile: search.profileId,
    nicLimit: search.size + 1
  };
  const boundary = cursorCondition(search.after, params);
  const columns = matchColumns(search.direction);
  const types = search.types.length
    ? Array.from(new Set(search.types))
    : [null, ProfileActivityLogType.RATING_EDIT];
  const branches: string[] = [];
  for (const column of columns) {
    types.forEach((type, index) => {
      const typeParam = `nicType${index}`;
      params[typeParam] = type;
      const conditions = [
        `pa_logs.${column} = :nicProfile`,
        ...access.conditions,
        ...boundary,
        type === null
          ? "pa_logs.type <> 'RATING_EDIT'"
          : `pa_logs.type = :${typeParam}`
      ];
      for (const matter of matterConditions(type)) {
        const predicates = matter ? [...conditions, matter] : conditions;
        // Existing composite indexes support these equality branches. Let the
        // optimizer select their deployed names; no schema/index change needed.
        branches.push(`(SELECT pa_logs.id, pa_logs.created_at
          FROM ${PROFILES_ACTIVITY_LOGS_TABLE} pa_logs
          WHERE ${predicates.join(' AND ')}
          ORDER BY pa_logs.created_at DESC, pa_logs.id DESC LIMIT :nicLimit)`);
      }
    });
  }
  // Each branch needs K rows, even when every match comes from just one branch.
  // Deduplication precedes the final limit because actor/proxy/target overlap.
  return {
    sql: `WITH ids AS (${branches.join('\nUNION DISTINCT\n')}), page_ids AS (
      SELECT id, created_at FROM ids
      ORDER BY created_at DESC, id DESC LIMIT :nicLimit
    ) SELECT pa_logs.*, DATE_FORMAT(pa_logs.created_at, '%Y-%m-%d %H:%i:%s') AS nic_cursor_created_at
      FROM ${PROFILES_ACTIVITY_LOGS_TABLE} pa_logs JOIN page_ids USING(id)
      ORDER BY pa_logs.created_at DESC, pa_logs.id DESC`,
    params
  };
}

function matchColumns(direction: ProfileNicActivitySearch['direction']) {
  if (direction === 'incoming') return ['target_id'];
  if (direction === 'outgoing') return ['profile_id', 'proxy_id'];
  return ['profile_id', 'proxy_id', 'target_id'];
}

function matterConditions(type: ProfileActivityLogType | null) {
  if (type !== ProfileActivityLogType.RATING_EDIT) return [null];
  // Exclude only REP/WAVE_REP; keep historical NULL and future matter values.
  // A single NOT IN range sorts all CIC history before it can apply the limit.
  return [
    "pa_logs.additional_data_1 = 'CIC'",
    'pa_logs.additional_data_1 IS NULL',
    "pa_logs.additional_data_1 NOT IN ('CIC','REP','WAVE_REP')"
  ];
}

function cursorCondition(
  after: ProfileNicActivityPosition | null,
  params: Record<string, unknown>
): string[] {
  if (!after) return [];
  params.nicAfterId = after.id;
  if (after.createdAt === null) {
    return ['(pa_logs.created_at IS NULL AND pa_logs.id < :nicAfterId)'];
  }
  params.nicAfterTime = after.createdAt;
  return [
    `(pa_logs.created_at < :nicAfterTime
    OR (pa_logs.created_at = :nicAfterTime AND pa_logs.id < :nicAfterId)
    OR pa_logs.created_at IS NULL)`
  ];
}
