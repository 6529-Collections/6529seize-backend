import {
  CONTENT_MODERATION_PROFILE_BLOCKS_TABLE,
  DEVICE_GRANTS_TABLE,
  E2EE_BLOB_CHUNKS_TABLE,
  E2EE_BLOBS_TABLE,
  E2EE_DEVICES_TABLE,
  E2EE_GROUP_EPOCHS_TABLE,
  E2EE_GROUP_ROSTER_TABLE,
  E2EE_GROUPS_TABLE,
  E2EE_KEY_PACKAGES_TABLE,
  E2EE_LOG_TABLE,
  E2EE_PUSH_THROTTLE_TABLE,
  E2EE_RATE_COUNTERS_TABLE,
  E2EE_REPORT_ACCESS_LOG_TABLE,
  E2EE_REPORTS_TABLE,
  E2EE_WELCOME_DELIVERIES_TABLE,
  E2EE_WELCOMES_TABLE,
  IDENTITY_SUBSCRIPTIONS_TABLE,
  PROFILE_PREFERENCES_TABLE,
  PROFILES_TABLE
} from '@/constants/db-tables';
import { DbPoolName, DbQueryOptions } from '@/db-query.options';
import { E2EE_PUSH_THROTTLE_MS, E2EE_RETENTION } from '@/e2ee/e2ee.constants';
import { fromMysqlBase64 } from '@/e2ee/e2ee-encoding';
import { E2eePolicyFacts } from '@/e2ee/e2ee-policy';
import { ActivityEventTargetType } from '@/entities/IActivityEvent';
import {
  E2eeBlobEntity,
  E2eeDeviceEntity,
  E2eeGroupEntity,
  E2eeGroupRosterEntity,
  E2eeLogEntity,
  E2eeReportAccessEntity,
  E2eeReportEntity,
  E2eeWelcomeEntity
} from '@/entities/IE2ee';
import { ProfileDirectMessagePolicy } from '@/entities/IProfilePreferences';
import {
  ConnectionWrapper,
  dbSupplier,
  LazyDbAccessCompatibleService
} from '@/sql-executor';

export type E2eeDeviceRow = E2eeDeviceEntity;
export type E2eeGroupRow = E2eeGroupEntity;
export type E2eeRosterRow = E2eeGroupRosterEntity;
export type E2eeBlobRow = E2eeBlobEntity;

export type E2eeLogMetaRow = Omit<E2eeLogEntity, 'data'>;
export type E2eeLogInsert = E2eeLogEntity;

export type E2eeRosterRemovalKind = 'commit' | 'leave' | 'revoke' | 'repair';

/** A stored report as trust and safety reads it (body as base64). */
export interface E2eeReviewReportRow {
  readonly id: string;
  readonly group_handle: string;
  readonly epoch: number;
  readonly body_b64: string;
  readonly signature: string;
  readonly sender_device_key: string;
  readonly sender_profile_id: string | null;
  readonly reporter_device_key: string;
  readonly reporter_profile_id: string;
  readonly reason: string;
  readonly notes: string | null;
  readonly verified: number | boolean;
  readonly on_hold: number | boolean;
  readonly created_at: number;
}

const REVIEW_REPORT_COLUMNS = `id, group_handle, epoch, to_base64(body) as body_b64,
  signature, sender_device_key, sender_profile_id, reporter_device_key,
  reporter_profile_id, reason, notes, verified, on_hold, created_at`;

export interface E2eeRosterWindow {
  readonly joined_epoch: number;
  readonly removed_epoch: number | null;
}

export type E2eeWelcomeMetaRow = Omit<
  E2eeWelcomeEntity,
  'data' | 'ratchet_tree'
> & { readonly byte_length: number };

export interface E2eeWelcomeDataRow {
  readonly id: string;
  readonly data_b64: string;
  readonly ratchet_tree_b64: string | null;
}

export interface E2eeKeyPackageStatusRow {
  readonly device_key: string;
  readonly one_time_available: number;
  readonly last_resort_expires_at: number | null;
}

export interface E2eeClaimedKeyPackageRow {
  readonly id: number;
  readonly device_key: string;
  readonly data_b64: string;
  readonly last_resort: boolean;
}

export interface E2eeKeyPackageInsert {
  readonly device_key: string;
  readonly data: Buffer;
  readonly last_resort: boolean;
  readonly expires_at_seconds: number;
  readonly created_at: number;
}

export interface E2eeDeviceGroupRow {
  readonly group_handle: string;
  readonly epoch: number;
  readonly last_seq: number;
  readonly joined_epoch: number;
  readonly updated_at: number;
}

type Conn = ConnectionWrapper<unknown>;

function inList(values: readonly string[]): string[] {
  return Array.from(new Set(values));
}

/**
 * Database access for E2EE messaging. Reads outside a transaction use the
 * primary so that ordering checks never act on replica lag.
 */
export class E2eeDb extends LazyDbAccessCompatibleService {
  private opts(connection?: Conn): DbQueryOptions {
    return connection
      ? { wrappedConnection: connection }
      : { forcePool: DbPoolName.WRITE };
  }

  private async many<T>(
    sql: string,
    params: Record<string, unknown>,
    connection?: Conn
  ): Promise<T[]> {
    return this.db.execute<T>(sql, params, this.opts(connection));
  }

  private async one<T>(
    sql: string,
    params: Record<string, unknown>,
    connection?: Conn
  ): Promise<T | null> {
    return this.many<T>(sql, params, connection).then(
      (rows) => rows[0] ?? null
    );
  }

  private async write(
    sql: string,
    params: Record<string, unknown>,
    connection?: Conn
  ): Promise<number> {
    const result = await this.db.execute(sql, params, this.opts(connection));
    return this.db.getAffectedRows(result);
  }

  // ---------------------------------------------------------------- devices

  async getDevice(
    deviceKey: string,
    connection?: Conn
  ): Promise<E2eeDeviceRow | null> {
    return this.one<E2eeDeviceRow>(
      `select * from ${E2EE_DEVICES_TABLE} where device_key = :deviceKey`,
      { deviceKey },
      connection
    );
  }

  async lockDevice(
    deviceKey: string,
    connection: Conn
  ): Promise<E2eeDeviceRow | null> {
    return this.one<E2eeDeviceRow>(
      `select * from ${E2EE_DEVICES_TABLE} where device_key = :deviceKey for update`,
      { deviceKey },
      connection
    );
  }

  async getDevices(
    deviceKeys: readonly string[],
    connection?: Conn
  ): Promise<E2eeDeviceRow[]> {
    if (!deviceKeys.length) return [];
    return this.many<E2eeDeviceRow>(
      `select * from ${E2EE_DEVICES_TABLE} where device_key in (:deviceKeys)`,
      { deviceKeys: inList(deviceKeys) },
      connection
    );
  }

  async getActiveDevicesOfProfiles(
    profileIds: readonly string[],
    nowSeconds: number,
    connection?: Conn
  ): Promise<E2eeDeviceRow[]> {
    if (!profileIds.length) return [];
    return this.many<E2eeDeviceRow>(
      `select * from ${E2EE_DEVICES_TABLE}
       where profile_id in (:profileIds)
         and revoked_at is null
         and expires_at_seconds > :nowSeconds
       order by profile_id, created_at, device_key`,
      { profileIds: inList(profileIds), nowSeconds },
      connection
    );
  }

  /** Active devices, plus devices revoked or expired within the window. */
  async getListableDevicesOfProfile(
    profileId: string,
    nowMs: number,
    windowMs: number
  ): Promise<E2eeDeviceRow[]> {
    const cutoffMs = nowMs - windowMs;
    return this.many<E2eeDeviceRow>(
      `select * from ${E2EE_DEVICES_TABLE}
       where profile_id = :profileId
         and ((revoked_at is null and expires_at_seconds * 1000 > :cutoffMs)
           or revoked_at > :cutoffMs)
       order by created_at, device_key`,
      { profileId, cutoffMs }
    );
  }

  async getListableDevicesOfProfiles(
    profileIds: readonly string[],
    nowMs: number,
    windowMs: number
  ): Promise<E2eeDeviceRow[]> {
    if (!profileIds.length) return [];
    const cutoffMs = nowMs - windowMs;
    return this.many<E2eeDeviceRow>(
      `select * from ${E2EE_DEVICES_TABLE}
       where profile_id in (:profileIds)
         and ((revoked_at is null and expires_at_seconds * 1000 > :cutoffMs)
           or revoked_at > :cutoffMs)
       order by profile_id, created_at, device_key`,
      { profileIds: inList(profileIds), cutoffMs }
    );
  }

  async countActiveDevices(
    profileId: string,
    nowSeconds: number,
    connection: Conn
  ): Promise<number> {
    const row = await this.one<{ cnt: number }>(
      `select count(*) as cnt from ${E2EE_DEVICES_TABLE}
       where profile_id = :profileId
         and revoked_at is null
         and expires_at_seconds > :nowSeconds`,
      { profileId, nowSeconds },
      connection
    );
    return Number(row?.cnt ?? 0);
  }

  /** Serializes device registration per profile (profiles row lock). */
  async lockProfile(profileId: string, connection: Conn): Promise<void> {
    await this.many(
      `select external_id from ${PROFILES_TABLE} where external_id = :profileId for update`,
      { profileId },
      connection
    );
  }

  async insertDevice(device: E2eeDeviceRow, connection: Conn): Promise<void> {
    await this.write(
      `insert into ${E2EE_DEVICES_TABLE} (
        device_key, profile_id, wallet, ciphersuite, issued_at_seconds,
        expires_at_seconds, origin, grant_id, wallet_signature, verified_via,
        label, platform, created_at, updated_at, last_seen_at, revoked_at,
        revoker_device_key, revocation_signed_at_seconds, revocation_signature,
        grant_message
      ) values (
        :device_key, :profile_id, :wallet, :ciphersuite, :issued_at_seconds,
        :expires_at_seconds, :origin, :grant_id, :wallet_signature,
        :verified_via, :label, :platform, :created_at, :updated_at,
        :last_seen_at, null, null, null, null, :grant_message
      )`,
      { ...device },
      connection
    );
  }

  async renewDevice(
    device: Pick<
      E2eeDeviceRow,
      | 'device_key'
      | 'wallet'
      | 'ciphersuite'
      | 'issued_at_seconds'
      | 'expires_at_seconds'
      | 'origin'
      | 'grant_id'
      | 'wallet_signature'
      | 'verified_via'
      | 'label'
      | 'platform'
      | 'updated_at'
      | 'grant_message'
    >,
    connection: Conn
  ): Promise<void> {
    await this.write(
      `update ${E2EE_DEVICES_TABLE} set
        wallet = :wallet, ciphersuite = :ciphersuite,
        issued_at_seconds = :issued_at_seconds,
        expires_at_seconds = :expires_at_seconds, origin = :origin,
        grant_id = :grant_id, wallet_signature = :wallet_signature,
        grant_message = :grant_message,
        verified_via = :verified_via, label = :label, platform = :platform,
        updated_at = :updated_at, last_seen_at = :updated_at
       where device_key = :device_key and revoked_at is null`,
      { ...device },
      connection
    );
  }

  async touchDevice(deviceKey: string, nowMs: number, intervalMs: number) {
    await this.write(
      `update ${E2EE_DEVICES_TABLE} set last_seen_at = :nowMs
       where device_key = :deviceKey
         and (last_seen_at is null or last_seen_at < :threshold)`,
      { deviceKey, nowMs, threshold: nowMs - intervalMs }
    );
  }

  /**
   * Locks a stored sign-in grant row for the rest of the transaction and
   * says whether it is still unrevoked (false when it is gone). Registration
   * through a combined grant checks it here, so a revocation either lands
   * first and blocks the device, or lands after and finds the device.
   */
  async lockUnrevokedLoginGrant(
    grantId: string,
    connection: Conn
  ): Promise<boolean> {
    const row = await this.one<{ revoked_at: number | string | null }>(
      `select revoked_at from ${DEVICE_GRANTS_TABLE} where id = :grantId for update`,
      { grantId },
      connection
    );
    return row !== null && row.revoked_at === null;
  }

  /**
   * The active device a combined sign-in grant registered, if any (for
   * revoking it together with that grant).
   */
  async getUnrevokedDeviceOfLoginGrant(
    grantId: string,
    connection?: Conn
  ): Promise<E2eeDeviceRow | null> {
    return this.one<E2eeDeviceRow>(
      `select * from ${E2EE_DEVICES_TABLE}
       where grant_id = :grantId and grant_message is not null
         and revoked_at is null
       limit 1`,
      { grantId },
      connection
    );
  }

  /**
   * Revocation by 6529.io when the wallet's session revoked the combined
   * sign-in grant behind this device. It carries no device signature, so
   * other members treat it as unverified (D109 2.4); delivery stops at once.
   */
  async markDeviceRevokedByGrant(
    input: { readonly deviceKey: string; readonly revokedAtMs: number },
    connection: Conn
  ): Promise<void> {
    await this.write(
      `update ${E2EE_DEVICES_TABLE} set
        revoked_at = :revokedAtMs, updated_at = :revokedAtMs
       where device_key = :deviceKey and revoked_at is null`,
      { ...input },
      connection
    );
  }

  async markDeviceRevoked(
    input: {
      readonly deviceKey: string;
      readonly revokedAtMs: number;
      readonly revokerDeviceKey: string;
      readonly signedAtSeconds: number;
      readonly signature: string;
    },
    connection: Conn
  ): Promise<void> {
    await this.write(
      `update ${E2EE_DEVICES_TABLE} set
        revoked_at = :revokedAtMs, revoker_device_key = :revokerDeviceKey,
        revocation_signed_at_seconds = :signedAtSeconds,
        revocation_signature = :signature, updated_at = :revokedAtMs
       where device_key = :deviceKey and revoked_at is null`,
      { ...input },
      connection
    );
  }

  // ----------------------------------------------------------- key packages

  async countOneTimeKeyPackages(
    deviceKey: string,
    nowSeconds: number,
    connection?: Conn
  ): Promise<number> {
    const row = await this.one<{ cnt: number }>(
      `select count(*) as cnt from ${E2EE_KEY_PACKAGES_TABLE}
       where device_key = :deviceKey and last_resort = false
         and expires_at_seconds > :nowSeconds`,
      { deviceKey, nowSeconds },
      connection
    );
    return Number(row?.cnt ?? 0);
  }

  async getKeyPackageStatuses(
    deviceKeys: readonly string[],
    nowSeconds: number,
    connection?: Conn
  ): Promise<E2eeKeyPackageStatusRow[]> {
    if (!deviceKeys.length) return [];
    return this.many<E2eeKeyPackageStatusRow>(
      `select device_key,
         sum(case when last_resort = false then 1 else 0 end) as one_time_available,
         max(case when last_resort = true then expires_at_seconds else null end)
           as last_resort_expires_at
       from ${E2EE_KEY_PACKAGES_TABLE}
       where device_key in (:deviceKeys) and expires_at_seconds > :nowSeconds
       group by device_key`,
      { deviceKeys: inList(deviceKeys), nowSeconds },
      connection
    );
  }

  async deleteExpiredKeyPackagesOfDevice(
    deviceKey: string,
    nowSeconds: number,
    connection: Conn
  ): Promise<void> {
    await this.write(
      `delete from ${E2EE_KEY_PACKAGES_TABLE}
       where device_key = :deviceKey and expires_at_seconds <= :nowSeconds`,
      { deviceKey, nowSeconds },
      connection
    );
  }

  async deleteLastResortKeyPackages(
    deviceKey: string,
    connection: Conn
  ): Promise<void> {
    await this.write(
      `delete from ${E2EE_KEY_PACKAGES_TABLE}
       where device_key = :deviceKey and last_resort = true`,
      { deviceKey },
      connection
    );
  }

  async deleteKeyPackagesOfDevice(
    deviceKey: string,
    connection: Conn
  ): Promise<void> {
    await this.write(
      `delete from ${E2EE_KEY_PACKAGES_TABLE} where device_key = :deviceKey`,
      { deviceKey },
      connection
    );
  }

  async insertKeyPackages(
    rows: readonly E2eeKeyPackageInsert[],
    connection: Conn
  ): Promise<void> {
    if (!rows.length) return;
    const params: Record<string, unknown> = {};
    const values = rows.map((row, index) => {
      params[`d${index}`] = row.device_key;
      params[`b${index}`] = row.data;
      params[`l${index}`] = row.last_resort;
      params[`e${index}`] = row.expires_at_seconds;
      params[`c${index}`] = row.created_at;
      return `(:d${index}, :b${index}, :l${index}, :e${index}, :c${index})`;
    });
    await this.write(
      `insert into ${E2EE_KEY_PACKAGES_TABLE}
        (device_key, data, last_resort, expires_at_seconds, created_at)
       values ${values.join(', ')}`,
      params,
      connection
    );
  }

  private async lockOneTimeKeyPackagesByIds(
    ids: readonly number[],
    connection: Conn
  ): Promise<E2eeClaimedKeyPackageRow[]> {
    if (!ids.length) return [];
    return this.many<E2eeClaimedKeyPackageRow>(
      `select id, device_key, to_base64(data) as data_b64, last_resort
       from ${E2EE_KEY_PACKAGES_TABLE}
       where id in (:ids)
       for update skip locked`,
      { ids: [...ids] },
      connection
    );
  }

  private async lockOldestOneTimeKeyPackage(
    deviceKey: string,
    nowSeconds: number,
    connection: Conn
  ): Promise<E2eeClaimedKeyPackageRow | null> {
    return this.one<E2eeClaimedKeyPackageRow>(
      `select id, device_key, to_base64(data) as data_b64, last_resort
       from ${E2EE_KEY_PACKAGES_TABLE}
       where device_key = :deviceKey and last_resort = false
         and expires_at_seconds > :nowSeconds
       order by id
       limit 1
       for update skip locked`,
      { deviceKey, nowSeconds },
      connection
    );
  }

  /**
   * Pops the oldest unexpired one-time KeyPackage of each device (FIFO).
   * Runs in a READ COMMITTED transaction; rows locked by a concurrent
   * claimer are skipped and that device falls back to a per-device pop.
   */
  async claimOneTimeKeyPackages(
    deviceKeys: readonly string[],
    nowSeconds: number,
    connection: Conn
  ): Promise<Map<string, E2eeClaimedKeyPackageRow>> {
    const claimed = new Map<string, E2eeClaimedKeyPackageRow>();
    if (!deviceKeys.length) return claimed;
    const oldest = await this.many<{ id: number }>(
      `select min(id) as id from ${E2EE_KEY_PACKAGES_TABLE}
       where device_key in (:deviceKeys) and last_resort = false
         and expires_at_seconds > :nowSeconds
       group by device_key`,
      { deviceKeys: inList(deviceKeys), nowSeconds },
      connection
    );
    const locked = await this.lockOneTimeKeyPackagesByIds(
      oldest.map((row) => Number(row.id)),
      connection
    );
    for (const row of locked) claimed.set(row.device_key, row);
    // Fallback pops share the transaction's connection, which runs them in
    // order; they are issued together rather than awaited one by one.
    const fallbacks = await Promise.all(
      inList(deviceKeys)
        .filter((deviceKey) => !claimed.has(deviceKey))
        .map((deviceKey) =>
          this.lockOldestOneTimeKeyPackage(deviceKey, nowSeconds, connection)
        )
    );
    for (const row of fallbacks) {
      if (row) claimed.set(row.device_key, row);
    }
    const ids = Array.from(claimed.values()).map((row) => Number(row.id));
    if (ids.length) {
      await this.write(
        `delete from ${E2EE_KEY_PACKAGES_TABLE} where id in (:ids)`,
        { ids },
        connection
      );
    }
    return claimed;
  }

  async getLastResortKeyPackages(
    deviceKeys: readonly string[],
    nowSeconds: number,
    connection?: Conn
  ): Promise<Map<string, E2eeClaimedKeyPackageRow>> {
    if (!deviceKeys.length) return new Map();
    const rows = await this.many<E2eeClaimedKeyPackageRow>(
      `select id, device_key, to_base64(data) as data_b64, last_resort
       from ${E2EE_KEY_PACKAGES_TABLE}
       where device_key in (:deviceKeys) and last_resort = true
         and expires_at_seconds > :nowSeconds
       order by id desc`,
      { deviceKeys: inList(deviceKeys), nowSeconds },
      connection
    );
    const result = new Map<string, E2eeClaimedKeyPackageRow>();
    for (const row of rows) {
      if (!result.has(row.device_key)) result.set(row.device_key, row);
    }
    return result;
  }

  // ----------------------------------------------------------------- policy

  /** Facts for section 7.1 in four set-based queries (no per-target query). */
  async getPolicyFacts(
    callerProfileId: string,
    targetProfileIds: readonly string[],
    nowSeconds: number,
    connection?: Conn
  ): Promise<Map<string, E2eePolicyFacts>> {
    const targets = inList(targetProfileIds);
    if (!targets.length) return new Map();
    const [preferences, follows, blocks, devices] = await Promise.all([
      this.many<{
        profile_id: string;
        direct_message_policy: ProfileDirectMessagePolicy;
      }>(
        `select profile_id, direct_message_policy from ${PROFILE_PREFERENCES_TABLE}
         where profile_id in (:targets)`,
        { targets },
        connection
      ),
      this.many<{ subscriber_id: string }>(
        `select distinct subscriber_id from ${IDENTITY_SUBSCRIPTIONS_TABLE}
         where subscriber_id in (:targets) and target_id = :callerProfileId
           and target_type = :targetType`,
        {
          targets,
          callerProfileId,
          targetType: ActivityEventTargetType.IDENTITY
        },
        connection
      ),
      this.many<{ blocker_profile_id: string; blocked_profile_id: string }>(
        `select blocker_profile_id, blocked_profile_id
         from ${CONTENT_MODERATION_PROFILE_BLOCKS_TABLE}
         where (blocker_profile_id = :callerProfileId and blocked_profile_id in (:targets))
            or (blocked_profile_id = :callerProfileId and blocker_profile_id in (:targets))`,
        { targets, callerProfileId },
        connection
      ),
      this.many<{ profile_id: string; cnt: number }>(
        `select profile_id, count(*) as cnt from ${E2EE_DEVICES_TABLE}
         where profile_id in (:targets) and revoked_at is null
           and expires_at_seconds > :nowSeconds
         group by profile_id`,
        { targets, nowSeconds },
        connection
      )
    ]);
    const policyByProfile = new Map(
      preferences.map((row) => [row.profile_id, row.direct_message_policy])
    );
    const followers = new Set(follows.map((row) => row.subscriber_id));
    const blocked = new Set(
      blocks.map((row) =>
        row.blocker_profile_id === callerProfileId
          ? row.blocked_profile_id
          : row.blocker_profile_id
      )
    );
    const deviceCounts = new Map(
      devices.map((row) => [row.profile_id, Number(row.cnt)])
    );
    return new Map(
      targets.map((profileId) => [
        profileId,
        {
          profileId,
          directMessagePolicy:
            policyByProfile.get(profileId) ??
            ProfileDirectMessagePolicy.EVERYONE,
          followsCaller: followers.has(profileId),
          blocked: blocked.has(profileId),
          activeDevices: deviceCounts.get(profileId) ?? 0
        }
      ])
    );
  }

  // ----------------------------------------------------------------- groups

  async getGroup(
    group: string,
    connection?: Conn
  ): Promise<E2eeGroupRow | null> {
    return this.one<E2eeGroupRow>(
      `select * from ${E2EE_GROUPS_TABLE} where group_handle = :group`,
      { group },
      connection
    );
  }

  /** Must be the first statement of a transaction (see docs). */
  async lockGroup(
    group: string,
    connection: Conn
  ): Promise<E2eeGroupRow | null> {
    return this.one<E2eeGroupRow>(
      `select * from ${E2EE_GROUPS_TABLE} where group_handle = :group for update`,
      { group },
      connection
    );
  }

  async insertGroup(row: E2eeGroupRow, connection: Conn): Promise<void> {
    await this.write(
      `insert into ${E2EE_GROUPS_TABLE}
        (group_handle, epoch, commit_key, last_seq, created_by_profile_id, created_at, updated_at)
       values (:group_handle, :epoch, :commit_key, :last_seq, :created_by_profile_id, :created_at, :updated_at)`,
      { ...row },
      connection
    );
  }

  async insertGroupEpoch(
    input: {
      readonly group: string;
      readonly epoch: number;
      readonly commitKey: string;
      readonly createdAt: number;
    },
    connection: Conn
  ): Promise<void> {
    await this.write(
      `insert into ${E2EE_GROUP_EPOCHS_TABLE} (group_handle, epoch, commit_key, created_at)
       values (:group, :epoch, :commitKey, :createdAt)`,
      { ...input },
      connection
    );
  }

  async getEpochCommitKey(
    group: string,
    epoch: number,
    connection?: Conn
  ): Promise<string | null> {
    const row = await this.one<{ commit_key: string }>(
      `select commit_key from ${E2EE_GROUP_EPOCHS_TABLE}
       where group_handle = :group and epoch = :epoch`,
      { group, epoch },
      connection
    );
    return row?.commit_key ?? null;
  }

  async updateGroupHead(
    input: {
      readonly group: string;
      readonly epoch: number;
      readonly commitKey: string;
      readonly lastSeq: number;
      readonly updatedAt: number;
    },
    connection: Conn
  ): Promise<void> {
    await this.write(
      `update ${E2EE_GROUPS_TABLE}
       set epoch = :epoch, commit_key = :commitKey, last_seq = :lastSeq,
           updated_at = :updatedAt
       where group_handle = :group`,
      { ...input },
      connection
    );
  }

  // ----------------------------------------------------------------- roster

  async getCurrentRoster(
    group: string,
    connection?: Conn
  ): Promise<E2eeRosterRow[]> {
    return this.many<E2eeRosterRow>(
      `select * from ${E2EE_GROUP_ROSTER_TABLE}
       where group_handle = :group and removed_epoch is null
       order by id`,
      { group },
      connection
    );
  }

  async getDeviceWindows(
    group: string,
    deviceKey: string,
    connection?: Conn
  ): Promise<E2eeRosterRow[]> {
    return this.many<E2eeRosterRow>(
      `select * from ${E2EE_GROUP_ROSTER_TABLE}
       where group_handle = :group and device_key = :deviceKey
       order by id`,
      { group, deviceKey },
      connection
    );
  }

  async insertRosterRows(
    rows: readonly Omit<
      E2eeRosterRow,
      'id' | 'removed_epoch' | 'removed_at' | 'removal_kind'
    >[],
    connection: Conn
  ): Promise<void> {
    if (!rows.length) return;
    const params: Record<string, unknown> = {};
    const values = rows.map((row, index) => {
      params[`g${index}`] = row.group_handle;
      params[`d${index}`] = row.device_key;
      params[`p${index}`] = row.profile_id;
      params[`j${index}`] = row.joined_epoch;
      params[`a${index}`] = row.added_at;
      return `(:g${index}, :d${index}, :p${index}, :j${index}, null, :a${index}, null, null)`;
    });
    await this.write(
      `insert into ${E2EE_GROUP_ROSTER_TABLE}
        (group_handle, device_key, profile_id, joined_epoch, removed_epoch, added_at, removed_at, removal_kind)
       values ${values.join(', ')}`,
      params,
      connection
    );
  }

  async removeFromRoster(
    input: {
      readonly group: string;
      readonly deviceKeys: readonly string[];
      readonly removedEpoch: number;
      readonly removedAt: number;
      readonly kind: E2eeRosterRemovalKind;
    },
    connection: Conn
  ): Promise<void> {
    if (!input.deviceKeys.length) return;
    await this.write(
      `update ${E2EE_GROUP_ROSTER_TABLE}
       set removed_epoch = :removedEpoch, removed_at = :removedAt,
           removal_kind = :kind
       where group_handle = :group and device_key in (:deviceKeys)
         and removed_epoch is null`,
      { ...input, deviceKeys: inList(input.deviceKeys) },
      connection
    );
  }

  /** Revocation: leave every roster at the group's current epoch. */
  async removeDeviceFromAllRosters(
    deviceKey: string,
    removedAt: number,
    connection: Conn
  ): Promise<void> {
    await this.write(
      `update ${E2EE_GROUP_ROSTER_TABLE} r
       join ${E2EE_GROUPS_TABLE} g on g.group_handle = r.group_handle
       set r.removed_epoch = g.epoch, r.removed_at = :removedAt,
           r.removal_kind = 'revoke'
       where r.device_key = :deviceKey and r.removed_epoch is null`,
      { deviceKey, removedAt },
      connection
    );
  }

  /** Every roster row of these devices or profiles in the group, oldest first. */
  async getRosterHistory(
    group: string,
    deviceKeys: readonly string[],
    profileIds: readonly string[],
    connection: Conn
  ): Promise<E2eeRosterRow[]> {
    if (!deviceKeys.length && !profileIds.length) return [];
    return this.many<E2eeRosterRow>(
      `select * from ${E2EE_GROUP_ROSTER_TABLE}
       where group_handle = :group
         and (device_key in (:deviceKeys) or profile_id in (:profileIds))
       order by id`,
      {
        group,
        deviceKeys: deviceKeys.length ? inList(deviceKeys) : [''],
        profileIds: profileIds.length ? inList(profileIds) : ['']
      },
      connection
    );
  }

  async getDeviceCurrentGroups(
    deviceKey: string,
    limit: number
  ): Promise<E2eeDeviceGroupRow[]> {
    return this.many<E2eeDeviceGroupRow>(
      `select g.group_handle, g.epoch, g.last_seq, r.joined_epoch, g.updated_at
       from ${E2EE_GROUP_ROSTER_TABLE} r
       join ${E2EE_GROUPS_TABLE} g on g.group_handle = r.group_handle
       where r.device_key = :deviceKey and r.removed_epoch is null
       order by g.updated_at desc, g.group_handle
       limit :limit`,
      { deviceKey, limit }
    );
  }

  async hasRosterHistory(
    group: string,
    deviceKey: string,
    connection?: Conn
  ): Promise<boolean> {
    const row = await this.one<{ id: number }>(
      `select id from ${E2EE_GROUP_ROSTER_TABLE}
       where group_handle = :group and device_key = :deviceKey limit 1`,
      { group, deviceKey },
      connection
    );
    return row !== null;
  }

  /** Profiles in a current roster together with any current device of these. */
  async getProfilesSharingRosters(
    filter: { readonly profileId: string } | { readonly deviceKey: string },
    limit: number,
    connection?: Conn
  ): Promise<string[]> {
    const column = 'profileId' in filter ? 'profile_id' : 'device_key';
    const value = 'profileId' in filter ? filter.profileId : filter.deviceKey;
    const rows = await this.many<{ profile_id: string }>(
      `select distinct other.profile_id
       from ${E2EE_GROUP_ROSTER_TABLE} mine
       join ${E2EE_GROUP_ROSTER_TABLE} other
         on other.group_handle = mine.group_handle and other.removed_epoch is null
       where mine.${column} = :value and mine.removed_epoch is null
       limit :limit`,
      { value, limit },
      connection
    );
    return rows.map((row) => row.profile_id);
  }

  // -------------------------------------------------------------------- log

  async countProposals(
    group: string,
    epoch: number,
    connection: Conn
  ): Promise<number> {
    const row = await this.one<{ cnt: number }>(
      `select count(*) as cnt from ${E2EE_LOG_TABLE}
       where group_handle = :group and item_type = 'entry' and epoch = :epoch
         and kind = 2`,
      { group, epoch },
      connection
    );
    return Number(row?.cnt ?? 0);
  }

  async insertLogItem(row: E2eeLogInsert, connection: Conn): Promise<void> {
    await this.write(
      `insert into ${E2EE_LOG_TABLE} (
        group_handle, seq, item_type, epoch, kind, commit_epoch, data,
        padded_len, entry_hash, epoch_commitment, next_commit_key, signature,
        roster_add, roster_remove, epoch_fp, sender_device_key,
        sender_profile_id, created_at
      ) values (
        :group_handle, :seq, :item_type, :epoch, :kind, :commit_epoch, :data,
        :padded_len, :entry_hash, :epoch_commitment, :next_commit_key,
        :signature, :roster_add, :roster_remove, :epoch_fp,
        :sender_device_key, :sender_profile_id, :created_at
      )`,
      { ...row },
      connection
    );
  }

  /** Item metadata visible to a device with the given roster windows. */
  async getLogPageMeta(input: {
    readonly group: string;
    readonly afterSeq: number;
    readonly windows: readonly E2eeRosterWindow[];
    readonly limit: number;
  }): Promise<E2eeLogMetaRow[]> {
    if (!input.windows.length) return [];
    const params: Record<string, unknown> = {
      group: input.group,
      afterSeq: input.afterSeq,
      limit: input.limit
    };
    const conditions = input.windows.map((window, index) => {
      params[`joined${index}`] = window.joined_epoch;
      if (window.removed_epoch === null) return `(epoch >= :joined${index})`;
      params[`removed${index}`] = window.removed_epoch;
      return `(epoch >= :joined${index} and epoch < :removed${index})`;
    });
    return this.many<E2eeLogMetaRow>(
      `select group_handle, seq, item_type, epoch, kind, commit_epoch,
         padded_len, entry_hash, epoch_commitment, next_commit_key, signature,
         roster_add, roster_remove, epoch_fp, sender_device_key,
         sender_profile_id, created_at
       from ${E2EE_LOG_TABLE}
       where group_handle = :group and seq > :afterSeq
         and (${conditions.join(' or ')})
       order by seq
       limit :limit`,
      params
    );
  }

  async getLogData(
    group: string,
    seqs: readonly number[]
  ): Promise<Map<number, string>> {
    if (!seqs.length) return new Map();
    const rows = await this.many<{ seq: number; data_b64: string }>(
      `select seq, to_base64(data) as data_b64 from ${E2EE_LOG_TABLE}
       where group_handle = :group and seq in (:seqs)`,
      { group, seqs: [...seqs] }
    );
    return new Map(
      rows.map((row) => [Number(row.seq), fromMysqlBase64(row.data_b64)!])
    );
  }

  // --------------------------------------------------------------- welcomes

  async insertWelcome(
    row: E2eeWelcomeEntity,
    targets: readonly { device_key: string; profile_id: string }[],
    connection: Conn
  ): Promise<void> {
    await this.write(
      `insert into ${E2EE_WELCOMES_TABLE} (
        id, group_handle, epoch, data, ratchet_tree, added_by_profile_id,
        added_by_device_key, created_at
      ) values (
        :id, :group_handle, :epoch, :data, :ratchet_tree, :added_by_profile_id,
        :added_by_device_key, :created_at
      )`,
      { ...row },
      connection
    );
    if (!targets.length) return;
    const params: Record<string, unknown> = {
      welcomeId: row.id,
      createdAt: row.created_at
    };
    const values = targets.map((target, index) => {
      params[`d${index}`] = target.device_key;
      params[`p${index}`] = target.profile_id;
      return `(:welcomeId, :d${index}, :p${index}, :createdAt)`;
    });
    await this.write(
      `insert into ${E2EE_WELCOME_DELIVERIES_TABLE} (welcome_id, device_key, profile_id, created_at)
       values ${values.join(', ')}`,
      params,
      connection
    );
  }

  async getPendingWelcomeMeta(
    deviceKey: string,
    limit: number
  ): Promise<E2eeWelcomeMetaRow[]> {
    return this.many<E2eeWelcomeMetaRow>(
      `select w.id, w.group_handle, w.epoch, w.added_by_profile_id,
         w.added_by_device_key, w.created_at,
         length(w.data) + coalesce(length(w.ratchet_tree), 0) as byte_length
       from ${E2EE_WELCOME_DELIVERIES_TABLE} d
       join ${E2EE_WELCOMES_TABLE} w on w.id = d.welcome_id
       where d.device_key = :deviceKey
       order by d.created_at, d.welcome_id
       limit :limit`,
      { deviceKey, limit }
    );
  }

  async getWelcomeData(
    ids: readonly string[]
  ): Promise<Map<string, E2eeWelcomeDataRow>> {
    if (!ids.length) return new Map();
    const rows = await this.many<E2eeWelcomeDataRow>(
      `select id, to_base64(data) as data_b64,
         to_base64(ratchet_tree) as ratchet_tree_b64
       from ${E2EE_WELCOMES_TABLE} where id in (:ids)`,
      { ids: inList(ids) }
    );
    return new Map(
      rows.map((row) => [
        row.id,
        {
          id: row.id,
          data_b64: fromMysqlBase64(row.data_b64)!,
          ratchet_tree_b64: fromMysqlBase64(row.ratchet_tree_b64)
        }
      ])
    );
  }

  private async deleteOrphanWelcomes(
    ids: readonly string[],
    connection: Conn
  ): Promise<void> {
    if (!ids.length) return;
    await this.write(
      `delete from ${E2EE_WELCOMES_TABLE}
       where id in (:ids)
         and not exists (
           select 1 from ${E2EE_WELCOME_DELIVERIES_TABLE} d
           where d.welcome_id = ${E2EE_WELCOMES_TABLE}.id
         )`,
      { ids: inList(ids) },
      connection
    );
  }

  async deleteWelcomeDelivery(
    welcomeId: string,
    deviceKey: string,
    connection: Conn
  ): Promise<void> {
    await this.write(
      `delete from ${E2EE_WELCOME_DELIVERIES_TABLE}
       where welcome_id = :welcomeId and device_key = :deviceKey`,
      { welcomeId, deviceKey },
      connection
    );
    await this.deleteOrphanWelcomes([welcomeId], connection);
  }

  async deleteWelcomeDeliveriesOfDevice(
    deviceKey: string,
    connection: Conn
  ): Promise<void> {
    const rows = await this.many<{ welcome_id: string }>(
      `select welcome_id from ${E2EE_WELCOME_DELIVERIES_TABLE}
       where device_key = :deviceKey`,
      { deviceKey },
      connection
    );
    await this.write(
      `delete from ${E2EE_WELCOME_DELIVERIES_TABLE} where device_key = :deviceKey`,
      { deviceKey },
      connection
    );
    await this.deleteOrphanWelcomes(
      rows.map((row) => row.welcome_id),
      connection
    );
  }

  // ------------------------------------------------------------------ blobs

  async insertBlob(row: E2eeBlobRow, connection?: Conn): Promise<void> {
    await this.write(
      `insert into ${E2EE_BLOBS_TABLE} (
        blob_id, group_handle, uploader_device_key, uploader_profile_id, size,
        chunk_count, complete, created_at, completed_at
      ) values (
        :blob_id, :group_handle, :uploader_device_key, :uploader_profile_id,
        :size, :chunk_count, :complete, :created_at, :completed_at
      )`,
      { ...row },
      connection
    );
  }

  async getBlob(
    blobId: string,
    connection?: Conn
  ): Promise<E2eeBlobRow | null> {
    return this.one<E2eeBlobRow>(
      `select * from ${E2EE_BLOBS_TABLE} where blob_id = :blobId`,
      { blobId },
      connection
    );
  }

  async lockBlob(
    blobId: string,
    connection: Conn
  ): Promise<E2eeBlobRow | null> {
    return this.one<E2eeBlobRow>(
      `select * from ${E2EE_BLOBS_TABLE} where blob_id = :blobId for update`,
      { blobId },
      connection
    );
  }

  async upsertBlobChunk(
    input: {
      readonly blobId: string;
      readonly index: number;
      readonly data: Buffer;
      readonly createdAt: number;
    },
    connection: Conn
  ): Promise<void> {
    await this.write(
      `insert into ${E2EE_BLOB_CHUNKS_TABLE} (blob_id, chunk_index, data, size, created_at)
       values (:blobId, :index, :data, :size, :createdAt)
       as new_chunk
       on duplicate key update data = new_chunk.data, size = new_chunk.size,
         created_at = new_chunk.created_at`,
      { ...input, size: input.data.length },
      connection
    );
  }

  async getBlobChunkSizes(
    blobId: string,
    connection: Conn
  ): Promise<{ chunk_index: number; size: number }[]> {
    return this.many<{ chunk_index: number; size: number }>(
      `select chunk_index, size from ${E2EE_BLOB_CHUNKS_TABLE}
       where blob_id = :blobId order by chunk_index`,
      { blobId },
      connection
    );
  }

  async markBlobComplete(
    blobId: string,
    completedAt: number,
    connection: Conn
  ): Promise<void> {
    await this.write(
      `update ${E2EE_BLOBS_TABLE} set complete = true, completed_at = :completedAt
       where blob_id = :blobId`,
      { blobId, completedAt },
      connection
    );
  }

  async getBlobChunkData(
    blobId: string,
    index: number
  ): Promise<string | null> {
    const row = await this.one<{ data_b64: string }>(
      `select to_base64(data) as data_b64 from ${E2EE_BLOB_CHUNKS_TABLE}
       where blob_id = :blobId and chunk_index = :index`,
      { blobId, index }
    );
    return row ? fromMysqlBase64(row.data_b64) : null;
  }

  // ---------------------------------------------------------------- reports

  async insertReport(row: E2eeReportEntity): Promise<void> {
    await this.write(
      `insert into ${E2EE_REPORTS_TABLE} (
        id, group_handle, epoch, body, signature, sender_device_key,
        sender_profile_id, reporter_device_key, reporter_profile_id, reason,
        notes, verified, created_at, on_hold
      ) values (
        :id, :group_handle, :epoch, :body, :signature, :sender_device_key,
        :sender_profile_id, :reporter_device_key, :reporter_profile_id,
        :reason, :notes, :verified, :created_at, :on_hold
      )`,
      { ...row }
    );
  }

  /** Newest first, for trust and safety review; bodies as base64. */
  /**
   * Newest first by (created_at, id). The cursor is the last row of the
   * previous page; with only `beforeMs`, rows created before that time.
   */
  async listReportsForReview(
    cursor: { beforeMs: number; beforeId: string | null } | null,
    limit: number
  ): Promise<E2eeReviewReportRow[]> {
    let where = '';
    if (cursor?.beforeId) {
      where =
        'where created_at < :beforeMs or (created_at = :beforeMs and id < :beforeId)';
    } else if (cursor) {
      where = 'where created_at < :beforeMs';
    }
    return this.many<E2eeReviewReportRow>(
      `select ${REVIEW_REPORT_COLUMNS} from ${E2EE_REPORTS_TABLE}
       ${where}
       order by created_at desc, id desc limit :limit`,
      {
        beforeMs: cursor?.beforeMs ?? null,
        beforeId: cursor?.beforeId ?? null,
        limit
      }
    );
  }

  async getReportForReview(
    id: string,
    connection?: Conn
  ): Promise<E2eeReviewReportRow | null> {
    return this.one<E2eeReviewReportRow>(
      `select ${REVIEW_REPORT_COLUMNS} from ${E2EE_REPORTS_TABLE}
       where id = :id`,
      { id },
      connection
    );
  }

  /** Returns false when the report does not exist. */
  async setReportHold(
    id: string,
    onHold: boolean,
    connection?: Conn
  ): Promise<boolean> {
    const rows = await this.many<{ id: string }>(
      `select id from ${E2EE_REPORTS_TABLE} where id = :id for update`,
      { id },
      connection
    );
    if (!rows.length) return false;
    await this.write(
      `update ${E2EE_REPORTS_TABLE} set on_hold = :onHold where id = :id`,
      { id, onHold },
      connection
    );
    return true;
  }

  async insertReportAccess(
    row: Omit<E2eeReportAccessEntity, 'id'>,
    connection?: Conn
  ) {
    await this.write(
      `insert into ${E2EE_REPORT_ACCESS_LOG_TABLE}
         (viewer_profile_id, action, report_ids, created_at)
       values (:viewer_profile_id, :action, :report_ids, :created_at)`,
      { ...row },
      connection
    );
  }

  async listReportAccess(): Promise<E2eeReportAccessEntity[]> {
    return this.many<E2eeReportAccessEntity>(
      `select id, viewer_profile_id, action, report_ids, created_at
       from ${E2EE_REPORT_ACCESS_LOG_TABLE} order by id`,
      {}
    );
  }

  // ------------------------------------------------------- throttle, limits

  /**
   * Claims a content-free wake per (profile, group) at most once per 60 s.
   * Returns the profiles whose wake may be sent now.
   */
  /** Undoes a claim whose wake was never queued (only rows still at it). */
  async releasePushWakes(
    group: string,
    profileIds: readonly string[],
    claimedAtMs: number
  ): Promise<void> {
    const ids = inList(profileIds);
    if (!ids.length) return;
    await this.write(
      `update ${E2EE_PUSH_THROTTLE_TABLE} set last_sent_at = 0
       where group_handle = :group and profile_id in (:ids)
         and last_sent_at = :claimedAtMs`,
      { group, ids, claimedAtMs }
    );
  }

  async claimPushWakes(
    group: string,
    profileIds: readonly string[],
    nowMs: number
  ): Promise<string[]> {
    // A stable order keeps concurrent claimers from deadlocking.
    const ids = inList(profileIds).sort((a, b) => a.localeCompare(b));
    if (!ids.length) return [];
    const params: Record<string, unknown> = { group };
    const values = ids.map((profileId, index) => {
      params[`p${index}`] = profileId;
      return `(:p${index}, :group, 0)`;
    });
    await this.write(
      `insert ignore into ${E2EE_PUSH_THROTTLE_TABLE} (profile_id, group_handle, last_sent_at)
       values ${values.join(', ')}`,
      params
    );
    return this.executeNativeQueriesInTransaction(async (connection) => {
      const rows = await this.many<{
        profile_id: string;
        last_sent_at: number;
      }>(
        `select profile_id, last_sent_at from ${E2EE_PUSH_THROTTLE_TABLE}
         where group_handle = :group and profile_id in (:ids)
         for update`,
        { group, ids },
        connection
      );
      const eligible = rows
        .filter(
          (row) => Number(row.last_sent_at) <= nowMs - E2EE_PUSH_THROTTLE_MS
        )
        .map((row) => row.profile_id);
      if (eligible.length) {
        await this.write(
          `update ${E2EE_PUSH_THROTTLE_TABLE} set last_sent_at = :nowMs
           where group_handle = :group and profile_id in (:eligible)`,
          { group, eligible, nowMs },
          connection
        );
      }
      return eligible;
    });
  }

  /** Increments fixed-window counters and returns the new hit counts. */
  async hitRateCounters(
    keys: readonly {
      readonly key: string;
      readonly windowStart: number;
      /** Units to add; 1 for request counts, bytes for byte budgets. */
      readonly amount?: number;
    }[]
  ): Promise<Map<string, number>> {
    if (!keys.length) return new Map();
    // A stable lock order keeps concurrent multi-key hits from deadlocking.
    const sorted = [...keys].sort((a, b) => a.key.localeCompare(b.key));
    const params: Record<string, unknown> = {};
    const values = sorted.map((entry, index) => {
      params[`k${index}`] = entry.key;
      params[`w${index}`] = entry.windowStart;
      params[`n${index}`] = Math.max(0, Math.floor(entry.amount ?? 1));
      return `(:k${index}, :w${index}, :n${index})`;
    });
    return this.executeNativeQueriesInTransaction(async (connection) => {
      await this.write(
        `insert into ${E2EE_RATE_COUNTERS_TABLE} (counter_key, window_start, hits)
         values ${values.join(', ')}
         as new_hit
         on duplicate key update
           hits = if(${E2EE_RATE_COUNTERS_TABLE}.window_start = new_hit.window_start,
                     ${E2EE_RATE_COUNTERS_TABLE}.hits + new_hit.hits, new_hit.hits),
           window_start = new_hit.window_start`,
        params,
        connection
      );
      const rows = await this.many<{ counter_key: string; hits: number }>(
        `select counter_key, hits from ${E2EE_RATE_COUNTERS_TABLE}
         where counter_key in (:keys)`,
        { keys: sorted.map((entry) => entry.key) },
        connection
      );
      return new Map(rows.map((row) => [row.counter_key, Number(row.hits)]));
    });
  }

  // -------------------------------------------------------------- retention

  /** Chunks and blob rows go together, a few blobs per transaction. */
  private async deleteBlobsByIds(ids: readonly string[]): Promise<void> {
    if (!ids.length) return;
    await this.executeNativeQueriesInTransaction(async (connection) => {
      await this.write(
        `delete from ${E2EE_BLOB_CHUNKS_TABLE} where blob_id in (:ids)`,
        { ids: [...ids] },
        connection
      );
      await this.write(
        `delete from ${E2EE_BLOBS_TABLE} where blob_id in (:ids)`,
        { ids: [...ids] },
        connection
      );
    });
  }

  /**
   * Deletes blobs past retention (complete: 365 days) and abandoned uploads
   * (incomplete after 24 h), oldest first, `limit` blobs at a time.
   */
  async pruneExpiredBlobs(nowMs: number, limit: number): Promise<number> {
    const rows = await this.many<{ blob_id: string }>(
      `select blob_id from (
         (select blob_id, created_at from ${E2EE_BLOBS_TABLE}
          where complete = true and created_at < :completeCutoff
          order by created_at limit :limit)
         union all
         (select blob_id, created_at from ${E2EE_BLOBS_TABLE}
          where complete = false and created_at < :incompleteCutoff
          order by created_at limit :limit)
       ) expired
       order by created_at
       limit :limit`,
      {
        completeCutoff: nowMs - E2EE_RETENTION.blobsMs,
        incompleteCutoff: nowMs - E2EE_RETENTION.incompleteBlobsMs,
        limit
      }
    );
    await this.deleteBlobsByIds(rows.map((row) => row.blob_id));
    return rows.length;
  }

  /** Declared bytes of a profile's live blobs, total and created since. */
  async getBlobUsage(
    profileId: string,
    sinceMs: number,
    connection: Conn
  ): Promise<{ liveBytes: number; recentBytes: number }> {
    const row = await this.one<{ live_bytes: number; recent_bytes: number }>(
      `select coalesce(sum(size), 0) as live_bytes,
         coalesce(sum(case when created_at > :sinceMs then size else 0 end), 0)
           as recent_bytes
       from ${E2EE_BLOBS_TABLE}
       where uploader_profile_id = :profileId`,
      { profileId, sinceMs },
      connection
    );
    return {
      liveBytes: Number(row?.live_bytes ?? 0),
      recentBytes: Number(row?.recent_bytes ?? 0)
    };
  }

  private async pruneWelcomes(nowMs: number, limit: number): Promise<void> {
    await this.write(
      `delete from ${E2EE_WELCOME_DELIVERIES_TABLE}
       where created_at < :cutoff limit :limit`,
      { cutoff: nowMs - E2EE_RETENTION.welcomeDeliveriesMs, limit }
    );
    const orphans = await this.many<{ id: string }>(
      `select w.id from ${E2EE_WELCOMES_TABLE} w
       where not exists (
         select 1 from ${E2EE_WELCOME_DELIVERIES_TABLE} d where d.welcome_id = w.id
       )
       limit :limit`,
      { limit }
    );
    if (orphans.length) {
      await this.executeNativeQueriesInTransaction((connection) =>
        this.deleteOrphanWelcomes(
          orphans.map((row) => row.id),
          connection
        )
      );
    }
  }

  /** Small bounded deletes for section 7.2 retention. */
  async pruneExpired(nowMs: number): Promise<void> {
    const limit = E2EE_RETENTION.batchSize;
    const nowSeconds = Math.floor(nowMs / 1000);
    await this.write(
      `delete from ${E2EE_LOG_TABLE}
       where item_type = 'message' and created_at < :cutoff limit :limit`,
      { cutoff: nowMs - E2EE_RETENTION.messagesMs, limit }
    );
    await this.write(
      `delete from ${E2EE_LOG_TABLE}
       where item_type = 'entry' and created_at < :cutoff limit :limit`,
      { cutoff: nowMs - E2EE_RETENTION.entriesMs, limit }
    );
    await this.pruneWelcomes(nowMs, limit);
    await this.pruneExpiredBlobs(nowMs, E2EE_RETENTION.blobBatchSize);
    await this.write(
      `delete from ${E2EE_KEY_PACKAGES_TABLE}
       where expires_at_seconds <= :nowSeconds limit :limit`,
      { nowSeconds, limit }
    );
    await this.write(
      `delete from ${E2EE_DEVICES_TABLE}
       where revoked_at is not null and revoked_at < :cutoff limit :limit`,
      { cutoff: nowMs - E2EE_RETENTION.revokedDevicesMs, limit }
    );
    await this.write(
      `delete from ${E2EE_RATE_COUNTERS_TABLE}
       where window_start < :cutoff limit :limit`,
      { cutoff: nowMs - E2EE_RETENTION.rateCountersMs, limit }
    );
    await this.write(
      `delete from ${E2EE_PUSH_THROTTLE_TABLE}
       where last_sent_at < :cutoff limit :limit`,
      { cutoff: nowMs - E2EE_RETENTION.pushThrottleMs, limit }
    );
    await this.pruneExpiredReports(nowMs, limit);
  }

  /** Reports older than the retention window and not on hold. */
  async pruneExpiredReports(nowMs: number, limit: number): Promise<number> {
    return this.write(
      `delete from ${E2EE_REPORTS_TABLE}
       where on_hold = false and created_at < :cutoff limit :limit`,
      { cutoff: nowMs - E2EE_RETENTION.reportsMs, limit }
    );
  }
}

export const e2eeDb = new E2eeDb(dbSupplier);
