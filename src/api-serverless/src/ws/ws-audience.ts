import { IDENTITY_SUBSCRIPTIONS_TABLE } from '@/constants';
import {
  ActivityEventAction,
  ActivityEventTargetType
} from '@/entities/IActivityEvent';

/**
 * Waves plan 1.3 (D3): with `WS_AUDIENCE_FOLLOWERS=true`, a wave's frames
 * reach only sockets with the wave open, sockets of its followers, and DM
 * members, always within today's visibility rules. Off unless set; it only
 * ever narrows today's audience.
 */
export function isFollowerAudienceEnabled(): boolean {
  return process.env.WS_AUDIENCE_FOLLOWERS === 'true';
}

/**
 * Whose sockets count as followers of `waveId`: identities following the
 * wave, its parent (for a subwave), or one of its subwaves (a followed
 * subwave lists its parent in the followed waves).
 */
export interface FollowerAudience {
  readonly waveId: string;
  readonly followTargets: readonly string[];
}

export function followerAudienceParams(audience: FollowerAudience) {
  return {
    audienceWaveId: audience.waveId,
    audienceFollowTargets: [...audience.followTargets],
    audienceTargetType: ActivityEventTargetType.WAVE,
    audienceTargetAction: ActivityEventAction.DROP_CREATED
  };
}

/**
 * Followers of the audience's waves. As a driving table it is pinned to the
 * target_id index: the type and action columns have only a few values each,
 * and the planner must not pick them on a small or skewed table. As a
 * per-socket membership probe it is left to the unique
 * (subscriber_id, target_id, ...) index.
 */
function followersSql({ driving }: { driving: boolean }): string {
  return `select s.subscriber_id
          from ${IDENTITY_SUBSCRIPTIONS_TABLE} s${
            driving ? ' force index (identity_subscription_target_id_idx)' : ''
          }
          where s.target_id in (:audienceFollowTargets)
            and s.target_type = :audienceTargetType
            and s.target_action = :audienceTargetAction`;
}

/**
 * Condition on a socket row: it has the wave open, or its identity follows
 * the wave. Used inside a visibility-group query, which already limits the
 * rows to members.
 */
export function followerAudienceConditionSql(alias = 'ws'): string {
  return `(${alias}.wave_id = :audienceWaveId
       or ${alias}.open_wave_id = :audienceWaveId
       or ${alias}.identity_id in (${followersSql({ driving: false })}))`;
}

/**
 * Ungrouped (public) waves: today every socket that is not viewing another
 * wave gets the frame. Narrowed, it is the sockets with the wave open
 * (subscribed to it, or an app socket that declared it with SET_OPEN_WAVE),
 * plus the followers' sockets that are not subscribed to another wave. Every
 * branch starts from an index (ws_connections.wave_id; .open_wave_id;
 * identity_subscriptions.target_id, then ws_connections by identity).
 */
export function ungroupedFollowerAudienceSql({
  table,
  purposeFilter
}: {
  table: string;
  purposeFilter: string;
}): string {
  const columns = `ws.connection_id as connection_id,
        ws.identity_id as profile_id,
        ws.wave_id as wave_id,
        ws.jwt_expiry as jwt_expiry`;
  return `select ${columns}
      from ${table} ws
      where ws.wave_id = :audienceWaveId
        and ${purposeFilter}
      union
      select ${columns}
      from ${table} ws
      where ws.open_wave_id = :audienceWaveId
        and ${purposeFilter}
      union
      select ${columns}
      from (${followersSql({ driving: true })}) f
      straight_join ${table} ws force index (idx_ws_connections_identity_expiry)
        on ws.identity_id = f.subscriber_id
      where ws.wave_id is null
        and ${purposeFilter}`;
}
