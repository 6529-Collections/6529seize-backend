import {
  ADDRESS_CONSOLIDATION_KEY,
  DEVICE_GRANTS_TABLE,
  DEVICE_SIGNED_EVENTS_TABLE,
  DROP_AUTHOR_SIGNATURES_TABLE,
  E2EE_DEVICES_TABLE,
  IDENTITIES_TABLE
} from '@/constants';
import { DbPoolName } from '@/db-query.options';
import { DeviceGrantEntity } from '@/entities/IDeviceGrant';
import { DeviceSignedEventEntity } from '@/entities/IDeviceSignedEvent';
import { Logger } from '@/logging';
import { RequestContext } from '@/request.context';
import { dbSupplier, LazyDbAccessCompatibleService } from '@/sql-executor';

export const DEVICE_GRANTS_LIST_LIMIT = 100;

export interface DeviceSecurityNoticeRow {
  readonly signing_grant_id: string | null;
  readonly signing_device_key: string | null;
  readonly encrypted_dm_device_key: string | null;
  readonly device_label: string;
}

export class DeviceSigningDb extends LazyDbAccessCompatibleService {
  private readonly logger = Logger.get(this.constructor.name);

  /** Idempotent on id. Returns false when the grant already existed. */
  async insertGrant(
    grant: DeviceGrantEntity,
    ctx: RequestContext
  ): Promise<boolean> {
    return this.insertIgnoringDuplicate(
      'insertGrant',
      `insert into ${DEVICE_GRANTS_TABLE} (
        id, wallet, key_type, device_key, scopes, device_label, domain,
        message, wallet_signature, chain_id, issued_at, expires_at,
        created_at, revoked_at, last_used_at, notice_pending,
        notice_encrypted_dm_device_key, registered_client_type,
        registered_binding, registered_request_origin, registered_session_id
      ) values (
        :id, :wallet, :key_type, :device_key, :scopes, :device_label, :domain,
        :message, :wallet_signature, :chain_id, :issued_at, :expires_at,
        :created_at, :revoked_at, :last_used_at, true, :noticeMlsKey,
        :registered_client_type, :registered_binding,
        :registered_request_origin, :registered_session_id
      )`,
      {
        registered_client_type: null,
        registered_binding: null,
        registered_request_origin: null,
        registered_session_id: null,
        ...grant,
        noticeMlsKey: grant.notice_encrypted_dm_device_key ?? null
      },
      ctx
    );
  }

  /**
   * Reads from the primary on purpose: a grant must be usable right after the
   * login that stored it, and a revocation must stop signed writes at once,
   * without waiting for replica lag.
   */
  async findGrantById(
    id: string,
    ctx: RequestContext
  ): Promise<DeviceGrantEntity | null> {
    const rows = await this.timedExecute<DeviceGrantEntity>(
      'findGrantById',
      `select * from ${DEVICE_GRANTS_TABLE} where id = :id`,
      { id },
      ctx,
      DbPoolName.WRITE
    );
    return rows[0] ?? null;
  }

  async findGrantsByIds(
    ids: string[],
    ctx: RequestContext
  ): Promise<DeviceGrantEntity[]> {
    if (!ids.length) {
      return [];
    }
    return this.timedExecute<DeviceGrantEntity>(
      'findGrantsByIds',
      `select * from ${DEVICE_GRANTS_TABLE} where id in (:ids)
       order by created_at asc, id asc`,
      { ids },
      ctx
    );
  }

  /** Grants of every wallet currently consolidated into the profile. */
  async findGrantsOfProfile(
    profileId: string,
    ctx: RequestContext
  ): Promise<DeviceGrantEntity[]> {
    return this.timedExecute<DeviceGrantEntity>(
      'findGrantsOfProfile',
      `select g.* from ${DEVICE_GRANTS_TABLE} g
       join ${ADDRESS_CONSOLIDATION_KEY} a on a.address = g.wallet
       join ${IDENTITIES_TABLE} i on i.consolidation_key = a.consolidation_key
       where i.profile_id = :profileId
       order by g.created_at desc, g.id desc
       limit ${DEVICE_GRANTS_LIST_LIMIT}`,
      { profileId },
      ctx
    );
  }

  async findGrantsOfWallet(
    wallet: string,
    ctx: RequestContext
  ): Promise<DeviceGrantEntity[]> {
    return this.timedExecute<DeviceGrantEntity>(
      'findGrantsOfWallet',
      `select * from ${DEVICE_GRANTS_TABLE} where wallet = :wallet
       order by created_at desc, id desc
       limit ${DEVICE_GRANTS_LIST_LIMIT}`,
      { wallet },
      ctx
    );
  }

  /** Reads both permissions together so one linked grant has one notice. */
  async findPendingSecurityNotices(
    profileId: string | null,
    wallet: string,
    now: number,
    ctx: RequestContext,
    encryptedDmsEnabled = true
  ): Promise<DeviceSecurityNoticeRow[]> {
    // Encrypted DM permissions belong to profiles, even when signing falls back to the wallet.
    const showStandalone = encryptedDmsEnabled && profileId !== null;
    const signingOwner = profileId
      ? `g.wallet in (
           select a.address from ${ADDRESS_CONSOLIDATION_KEY} a
           join ${IDENTITIES_TABLE} i on i.consolidation_key = a.consolidation_key
           where i.profile_id = :profileId
         )`
      : 'g.wallet = :wallet';
    return this.timedExecute<DeviceSecurityNoticeRow>(
      'findPendingSecurityNotices',
      `select g.id as signing_grant_id, g.device_key as signing_device_key,
              case when :profileId is not null then g.notice_encrypted_dm_device_key end
                as encrypted_dm_device_key,
              coalesce(e.label, g.device_label) as device_label,
              g.created_at as created_at
       from ${DEVICE_GRANTS_TABLE} g
       left join ${E2EE_DEVICES_TABLE} e
         on e.grant_id = g.id and e.profile_id = :profileId
         and e.device_key = g.notice_encrypted_dm_device_key
         and e.grant_message is not null and e.revoked_at is null
         and e.expires_at_seconds > :nowSeconds
       where ${signingOwner} and g.notice_pending = true
         and g.notice_acknowledged = false
         and g.revoked_at is null and g.expires_at > :now
       union all
       select null, null, e.device_key, e.label, e.created_at
       from ${E2EE_DEVICES_TABLE} e
       where :showStandalone and e.profile_id = :profileId and e.notice_pending = true
         and e.grant_message is null and e.revoked_at is null
         and e.expires_at_seconds > :nowSeconds
       order by created_at desc, signing_grant_id desc, encrypted_dm_device_key desc
       limit ${DEVICE_GRANTS_LIST_LIMIT}`,
      {
        profileId,
        wallet,
        now,
        nowSeconds: Math.floor(now / 1000),
        showStandalone
      },
      ctx,
      DbPoolName.WRITE
    );
  }

  async lockGrant(
    id: string,
    ctx: RequestContext
  ): Promise<DeviceGrantEntity | null> {
    const rows = await this.timedExecute<DeviceGrantEntity>(
      'lockGrant',
      `select * from ${DEVICE_GRANTS_TABLE} where id = :id for update`,
      { id },
      ctx,
      DbPoolName.WRITE
    );
    return rows[0] ?? null;
  }

  async renameGrant(
    id: string,
    wallet: string,
    label: string,
    ctx: RequestContext
  ) {
    await this.timedExecute(
      'renameGrant',
      `update ${DEVICE_GRANTS_TABLE} set device_label = :label
       where id = :id and wallet = :wallet and revoked_at is null`,
      { id, wallet, label },
      ctx,
      DbPoolName.WRITE
    );
  }

  /** The caller holds the grant row lock and has checked ownership. */
  async acknowledgeGrant(id: string, ctx: RequestContext): Promise<void> {
    const result = await this.timedExecute(
      'acknowledgeGrant',
      `update ${DEVICE_GRANTS_TABLE}
       set notice_acknowledged = true, notice_pending = false where id = :id`,
      { id },
      ctx,
      DbPoolName.WRITE
    );
    if (this.db.getAffectedRows(result) !== 1) {
      throw new Error('Could not persist device grant acknowledgment');
    }
  }

  /** Sets revoked_at once; later calls keep the first revocation time. */
  async revokeGrant(
    id: string,
    revokedAt: number,
    ctx: RequestContext
  ): Promise<void> {
    await this.timedExecute(
      'revokeGrant',
      `update ${DEVICE_GRANTS_TABLE} set revoked_at = :revokedAt
       where id = :id and revoked_at is null`,
      { id, revokedAt },
      ctx
    );
  }

  /**
   * Reserves an event id and (device_key, seq) before the write it authorizes.
   * Returns false when either is already taken (replay or fork).
   */
  async reserveEvent(
    event: DeviceSignedEventEntity,
    ctx: RequestContext
  ): Promise<boolean> {
    return this.insertIgnoringDuplicate(
      'reserveEvent',
      `insert into ${DEVICE_SIGNED_EVENTS_TABLE} (
        id, kind, kind_version, wave_id, drop_id, author, profile_id,
        key_type, device_key, grant_id, seq, anchor, claimed_time, refs,
        body, body_hash, body_size, signature, created_at
      ) values (
        :id, :kind, :kind_version, :wave_id, :drop_id, :author, :profile_id,
        :key_type, :device_key, :grant_id, :seq, :anchor, :claimed_time, :refs,
        :body, :body_hash, :body_size, :signature, :created_at
      )`,
      { ...event },
      ctx
    );
  }

  async deleteReservedEvent(id: string, ctx: RequestContext): Promise<void> {
    await this.timedExecute(
      'deleteReservedEvent',
      `delete from ${DEVICE_SIGNED_EVENTS_TABLE} where id = :id and drop_id is null`,
      { id },
      ctx
    );
  }

  async attachEventToDrop(
    {
      eventId,
      dropId
    }: {
      readonly eventId: string;
      readonly dropId: string;
    },
    ctx: RequestContext
  ): Promise<void> {
    await this.timedExecute(
      'attachEventToDrop',
      `update ${DEVICE_SIGNED_EVENTS_TABLE} set drop_id = :dropId where id = :eventId`,
      { eventId, dropId },
      ctx
    );
  }

  async touchGrantLastUsed(
    grantId: string,
    usedAt: number,
    ctx: RequestContext
  ): Promise<void> {
    await this.timedExecute(
      'touchGrantLastUsed',
      `update ${DEVICE_GRANTS_TABLE} set last_used_at = :usedAt where id = :grantId`,
      { grantId, usedAt },
      ctx
    );
  }

  async upsertDropAuthorSignature(
    {
      dropId,
      eventId,
      signedAt
    }: {
      readonly dropId: string;
      readonly eventId: string;
      readonly signedAt: number;
    },
    ctx: RequestContext
  ): Promise<void> {
    await this.timedExecute(
      'upsertDropAuthorSignature',
      `insert into ${DROP_AUTHOR_SIGNATURES_TABLE} (drop_id, event_id, signed_at)
       values (:dropId, :eventId, :signedAt)
       on duplicate key update
         event_id = if(values(signed_at) >= signed_at, values(event_id), event_id),
         signed_at = greatest(signed_at, values(signed_at))`,
      { dropId, eventId, signedAt },
      ctx
    );
  }

  async deleteDropAuthorSignature(
    dropId: string,
    ctx: RequestContext
  ): Promise<void> {
    await this.timedExecute(
      'deleteDropAuthorSignature',
      `delete from ${DROP_AUTHOR_SIGNATURES_TABLE} where drop_id = :dropId`,
      { dropId },
      ctx
    );
  }

  async findDropAuthorSignatureEventId(
    dropId: string,
    ctx: RequestContext
  ): Promise<string | null> {
    const rows = await this.timedExecute<{ event_id: string }>(
      'findDropAuthorSignatureEventId',
      `select event_id from ${DROP_AUTHOR_SIGNATURES_TABLE} where drop_id = :dropId`,
      { dropId },
      ctx
    );
    return rows[0]?.event_id ?? null;
  }

  /**
   * Which of the given drops show author signed content right now. Same rule
   * as current_event_id (a drop_author_signatures row exists), answered for a
   * whole page with one primary key lookup. The answer is display metadata on
   * every drop read, so a failed lookup reads as unsigned instead of failing
   * the read.
   */
  async findAuthorSignedDropIds(
    dropIds: readonly string[],
    ctx: RequestContext,
    forcePool?: DbPoolName
  ): Promise<Set<string>> {
    const distinctDropIds = Array.from(new Set(dropIds));
    if (!distinctDropIds.length) {
      return new Set();
    }
    try {
      const rows = await this.timedExecute<{ drop_id: string }>(
        'findAuthorSignedDropIds',
        `select drop_id from ${DROP_AUTHOR_SIGNATURES_TABLE} where drop_id in (:dropIds)`,
        { dropIds: distinctDropIds },
        ctx,
        forcePool
      );
      return new Set(rows.map((row) => row.drop_id));
    } catch (error) {
      this.logger.error(
        `Failed to read the author signature status of ${distinctDropIds.length} drops`,
        error
      );
      return new Set();
    }
  }

  async findEventsByDropId(
    dropId: string,
    ctx: RequestContext
  ): Promise<DeviceSignedEventEntity[]> {
    return this.timedExecute<DeviceSignedEventEntity>(
      'findEventsByDropId',
      `select * from ${DEVICE_SIGNED_EVENTS_TABLE} where drop_id = :dropId
       order by created_at asc, seq asc, id asc`,
      { dropId },
      ctx
    );
  }

  private async insertIgnoringDuplicate(
    timerName: string,
    sql: string,
    params: Record<string, unknown>,
    ctx: RequestContext
  ): Promise<boolean> {
    try {
      await this.timedExecute(timerName, sql, params, ctx);
      return true;
    } catch (error) {
      if (isDuplicateKeyError(error)) {
        return false;
      }
      throw error;
    }
  }

  private async timedExecute<T = unknown>(
    timerName: string,
    sql: string,
    params: Record<string, unknown>,
    ctx: RequestContext,
    forcePool?: DbPoolName
  ): Promise<T[]> {
    const name = `${this.constructor.name}->${timerName}`;
    ctx.timer?.start(name);
    try {
      return await this.db.execute<T>(sql, params, {
        ...(ctx.connection ? { wrappedConnection: ctx.connection } : {}),
        ...(forcePool ? { forcePool } : {})
      });
    } finally {
      ctx.timer?.stop(name);
    }
  }
}

function isDuplicateKeyError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { readonly code?: unknown }).code === 'ER_DUP_ENTRY'
  );
}

export const deviceSigningDb = new DeviceSigningDb(dbSupplier);
