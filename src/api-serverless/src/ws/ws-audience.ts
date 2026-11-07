import {
  IDENTITY_SUBSCRIPTIONS_TABLE,
  WS_CONNECTIONS_TABLE
} from '@/constants';
import {
  ActivityEventAction,
  ActivityEventTargetType
} from '@/entities/IActivityEvent';

/**
 * Waves plan 1.3 (D3): the narrower wave audience. A wave's frames reach
 * sockets with the wave open, followers' sockets and DM members, always
 * within today's visibility rules. It only ever narrows today's audience.
 *
 * `WS_AUDIENCE_FOLLOWERS`:
 * - unset or anything else: off, today's audience;
 * - `legacy-clients`: narrow only sockets of builds that predate
 *   `client_version` (no stored build), the old tabs that refetch every
 *   wave list for each drop; newer builds keep today's audience;
 * - `all` (or `true`): narrow every socket.
 *
 * In both modes an old signed-in socket counts as viewing a wave when the
 * same identity has a socket subscribed to it (old builds keep a per-wave
 * socket for the open wave but take drops on their app socket), and old
 * anonymous sockets, which cannot be told apart, keep today's audience.
 */
export type FollowerAudienceMode = 'legacy-clients' | 'all';

export function followerAudienceMode(): FollowerAudienceMode | null {
  const value = (process.env.WS_AUDIENCE_FOLLOWERS ?? '').trim().toLowerCase();
  if (value === 'true' || value === 'all') return 'all';
  if (value === 'legacy-clients') return 'legacy-clients';
  return null;
}

export function isFollowerAudienceEnabled(): boolean {
  return followerAudienceMode() !== null;
}

/**
 * Whose sockets count as followers of `waveId`: identities following the
 * wave, its parent (for a subwave), or one of its subwaves (a followed
 * subwave lists its parent in the followed waves).
 */
export interface FollowerAudience {
  readonly waveId: string;
  readonly followTargets: readonly string[];
  readonly mode: FollowerAudienceMode;
  /** The shared identity id of anonymous sockets. */
  readonly anonymousIdentityId: string;
}

export function followerAudienceParams(audience: FollowerAudience) {
  return {
    audienceWaveId: audience.waveId,
    audienceFollowTargets: [...audience.followTargets],
    audienceTargetType: ActivityEventTargetType.WAVE,
    audienceTargetAction: ActivityEventAction.DROP_CREATED,
    audienceAnonymous: audience.anonymousIdentityId
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

/** Signed-in identities with a socket subscribed to the wave (wave_id index). */
function identitiesViewingSql(): string {
  return `select v.identity_id
          from ${WS_CONNECTIONS_TABLE} v
          where v.wave_id = :audienceWaveId
            and v.identity_id <> :audienceAnonymous`;
}

/**
 * Sockets that keep today's audience in this mode: in `legacy-clients`,
 * every socket of a build that stores `client_version`; in both modes, old
 * anonymous sockets.
 */
function unnarrowedSql(mode: FollowerAudienceMode, alias = 'ws'): string {
  const oldAnonymous = `(${alias}.client_version is null and ${alias}.identity_id = :audienceAnonymous)`;
  return mode === 'legacy-clients'
    ? `(${alias}.client_version is not null or ${oldAnonymous})`
    : oldAnonymous;
}

/**
 * Condition on a socket row inside a visibility-group query, which already
 * limits the rows to members: it keeps today's audience in this mode, has
 * the wave open (subscribed, declared, or inferred for an old build's app
 * socket, as in the public-wave query), or its identity follows the wave.
 */
export function followerAudienceConditionSql(
  mode: FollowerAudienceMode,
  alias = 'ws'
): string {
  return `(${unnarrowedSql(mode, alias)}
       or ${alias}.wave_id = :audienceWaveId
       or ${alias}.open_wave_id = :audienceWaveId
       or ${alias}.identity_id in (${followersSql({ driving: false })})
       or (${alias}.client_version is null
           and ${alias}.wave_id is null
           and ${alias}.identity_id in (${identitiesViewingSql()})))`;
}

/**
 * Ungrouped (public) waves. Today every socket that is not subscribed to
 * another wave gets the frame. Narrowed, it is the union of:
 * 1. sockets subscribed to the wave (wave_id index);
 * 2. sockets that declared it open with SET_OPEN_WAVE (open_wave_id index);
 * 3. followers' sockets not subscribed to another wave (identity_subscriptions
 *    target_id, then ws_connections by identity);
 * 4. old signed-in sockets whose identity has a socket subscribed to the
 *    wave (wave_id index, then ws_connections by identity);
 * 5. sockets that keep today's audience in this mode, not subscribed to
 *    another wave (wave_id index on null, as today).
 */
export function ungroupedFollowerAudienceSql({
  table,
  purposeFilter,
  mode
}: {
  table: string;
  purposeFilter: string;
  mode: FollowerAudienceMode;
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
        and ${purposeFilter}
      union
      select ${columns}
      from (${identitiesViewingSql()}) i
      straight_join ${table} ws force index (idx_ws_connections_identity_expiry)
        on ws.identity_id = i.identity_id
      where ws.wave_id is null
        and ws.client_version is null
        and ${purposeFilter}
      union
      select ${columns}
      from ${table} ws
      where ws.wave_id is null
        and ${unnarrowedSql(mode)}
        and ${purposeFilter}`;
}
