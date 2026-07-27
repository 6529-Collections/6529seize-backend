import {
  ADDRESS_CONSOLIDATION_KEY,
  CONSOLIDATED_OWNERS_BALANCES_MEMES_TABLE,
  IDENTITIES_TABLE,
  MEMES_CONTRACT,
  MEMES_SEASONS_TABLE,
  NFTS_TABLE,
  PROFILES_TABLE,
  SUBSCRIPTION_COVERAGE_ALERT_STATES_TABLE,
  SUBSCRIPTION_COVERAGE_REFRESH_REQUESTS_TABLE,
  SUBSCRIPTIONS_BALANCES_TABLE,
  SUBSCRIPTIONS_MODE_TABLE,
  SUBSCRIPTIONS_NFTS_FINAL_TABLE,
  SUBSCRIPTIONS_NFTS_TABLE,
  SUBSCRIPTIONS_REDEEMED_TABLE,
  SUBSCRIPTIONS_TOP_UP_TABLE
} from '@/constants';
import { IdentityNotificationCause } from '@/entities/IIdentityNotification';
import { SubscriptionCoverageAlertStateEntity } from '@/entities/ISubscriptionCoverageAlertState';
import { SubscriptionCoverageRefreshRequestEntity } from '@/entities/ISubscriptionCoverageRefreshRequest';
import { Logger } from '@/logging';
import type { NewIdentityNotification } from '@/notifications/identity-notifications.db';
import { SubscriptionCoverageNotificationData } from '@/notifications/user-notification.types';
import { RequestContext } from '@/request.context';
import {
  ConnectionWrapper,
  dbSupplier,
  LazyDbAccessCompatibleService,
  SqlExecutor
} from '@/sql-executor';
import { Time } from '@/time';
import {
  decideSubscriptionCoverageAlert,
  StoredSubscriptionCoverageAlertState,
  SubscriptionCoverageAlertPolicy,
  SubscriptionCoverageAlertSnapshot,
  SubscriptionCoverageAlertStatus
} from './subscription-coverage-alert-policy';

const MAX_KEYS_PER_QUERY = 500;
const MAX_REASON_LENGTH = 64;

export interface SubscriptionCoverageSourceSelection {
  readonly tokenId: number;
  readonly subscribed: boolean;
  readonly subscribedCount: number;
  readonly automaticSubscription: boolean;
}

export interface SubscriptionCoverageSourceData {
  readonly consolidationKey: string;
  readonly hasDemonstratedIntent: boolean;
  readonly balanceEth: string;
  readonly mode: {
    readonly automatic: boolean;
    readonly subscribeAllEditions: boolean;
  } | null;
  readonly eligibilityCount: number | null;
  readonly selections: SubscriptionCoverageSourceSelection[];
}

export interface CanonicalSubscriptionCoverageProfile {
  readonly profileId: string;
  readonly handle: string;
}

export interface SubscriptionCoverageNotificationSnapshot extends SubscriptionCoverageAlertSnapshot {
  readonly notificationData: SubscriptionCoverageNotificationData | null;
}

export interface SubscriptionCoverageAlertWriteResult {
  readonly notificationIds: number[];
  readonly notificationStatus: SubscriptionCoverageAlertStatus | null;
  readonly decisionReason: string;
  readonly createdBaseline: boolean;
}

interface LockedAlertState {
  readonly currentState: StoredSubscriptionCoverageAlertState | null;
  readonly insertedPlaceholder: boolean;
}

interface LastNotifiedFields {
  readonly status: SubscriptionCoverageAlertStatus | null;
  readonly fingerprint: string | null;
  readonly at: number | null;
}

export interface SubscriptionCoverageNotificationWriter {
  insertManyNotifications(
    notifications: NewIdentityNotification[],
    connection?: ConnectionWrapper<unknown>
  ): Promise<number[]>;
}

interface BalanceRow {
  readonly consolidation_key: string;
  readonly balance_eth: string;
}

interface ModeRow {
  readonly consolidation_key: string;
  readonly automatic: number | boolean;
  readonly subscribe_all_editions: number | boolean;
}

interface EligibilityRow {
  readonly consolidation_key: string;
  readonly sets: number | string;
}

interface SelectionRow {
  readonly consolidation_key: string;
  readonly token_id: number | string;
  readonly subscribed: number | boolean;
  readonly subscribed_count: number | string;
  readonly automatic_subscription: number | boolean;
}

interface CanonicalProfileRow {
  readonly consolidation_key: string;
  readonly profile_id: string;
  readonly handle: string;
}

function uniqueNormalizedKeys(consolidationKeys: readonly string[]): string[] {
  return Array.from(
    new Set(
      consolidationKeys
        .map((key) => key.trim().toLowerCase())
        .filter((key) => key.length > 0)
    )
  ).sort((left, right) => left.localeCompare(right));
}

function queryOptions(ctx: RequestContext) {
  return ctx.connection ? { wrappedConnection: ctx.connection } : undefined;
}

function toBoolean(value: number | boolean): boolean {
  return value === true || value === 1;
}

function toSafeNonNegativeInteger(value: number | string): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function storedStateFromEntity(
  entity: SubscriptionCoverageAlertStateEntity
): StoredSubscriptionCoverageAlertState {
  return {
    current_status: entity.current_status as SubscriptionCoverageAlertStatus,
    current_fingerprint: entity.current_fingerprint,
    current_at_risk_token_id:
      entity.current_at_risk_token_id === null
        ? null
        : Number(entity.current_at_risk_token_id),
    current_fully_funded_drops: entity.current_fully_funded_drops,
    current_requested_mints: entity.current_requested_mints,
    current_missing_mints: entity.current_missing_mints,
    recipient_profile_id: entity.recipient_profile_id,
    last_notified_status:
      entity.last_notified_status as SubscriptionCoverageAlertStatus | null,
    last_notified_fingerprint: entity.last_notified_fingerprint,
    last_notified_at:
      entity.last_notified_at === null ? null : Number(entity.last_notified_at)
  };
}

function createIdentityNotification(
  data: SubscriptionCoverageNotificationData
): NewIdentityNotification {
  return {
    identity_id: data.recipient_profile_id,
    additional_identity_id: null,
    related_drop_id: null,
    related_drop_part_no: null,
    related_drop_2_id: null,
    related_drop_2_part_no: null,
    cause: IdentityNotificationCause.SUBSCRIPTION_COVERAGE,
    additional_data: data,
    visibility_group_id: null,
    wave_id: null
  };
}

function deriveLastNotifiedFields(
  resetNotificationState: boolean,
  notificationInserted: boolean,
  snapshot: SubscriptionCoverageNotificationSnapshot,
  currentState: StoredSubscriptionCoverageAlertState | null,
  now: number
): LastNotifiedFields {
  if (resetNotificationState) {
    return { status: null, fingerprint: null, at: null };
  }
  if (notificationInserted) {
    return {
      status: snapshot.status,
      fingerprint: snapshot.fingerprint,
      at: now
    };
  }
  return {
    status: currentState?.last_notified_status ?? null,
    fingerprint: currentState?.last_notified_fingerprint ?? null,
    at: currentState?.last_notified_at ?? null
  };
}

export class SubscriptionCoverageRepository extends LazyDbAccessCompatibleService {
  private readonly logger = Logger.get(SubscriptionCoverageRepository.name);

  constructor(
    dbSupplierFn: () => SqlExecutor,
    private readonly notificationsDb?: SubscriptionCoverageNotificationWriter
  ) {
    super(dbSupplierFn);
  }

  public async markDirty(
    consolidationKeys: readonly string[],
    reason: string,
    ctx: RequestContext = {}
  ): Promise<number> {
    const timerName = `${this.constructor.name}->markDirty`;
    ctx.timer?.start(timerName);
    try {
      const keys = uniqueNormalizedKeys(consolidationKeys);
      if (!keys.length) {
        return 0;
      }
      const normalizedReason =
        reason.trim().slice(0, MAX_REASON_LENGTH) || 'UNSPECIFIED';
      const now = Time.currentMillis();
      let affected = 0;
      for (let offset = 0; offset < keys.length; offset += MAX_KEYS_PER_QUERY) {
        const chunk = keys.slice(offset, offset + MAX_KEYS_PER_QUERY);
        const params: Record<string, string | number> = {
          reason: normalizedReason,
          now
        };
        const values = chunk.map((key, index) => {
          params[`key${index}`] = key;
          return `(:key${index}, :reason, :now, 0, NULL, :now, :now)`;
        });
        const result = await this.db.execute(
          `
            INSERT INTO ${SUBSCRIPTION_COVERAGE_REFRESH_REQUESTS_TABLE} (
              consolidation_key,
              reason,
              dirty_at,
              attempts,
              last_error,
              created_at,
              updated_at
            )
            VALUES ${values.join(', ')}
            AS new
            ON DUPLICATE KEY UPDATE
              reason = new.reason,
              dirty_at = GREATEST(
                ${SUBSCRIPTION_COVERAGE_REFRESH_REQUESTS_TABLE}.dirty_at,
                new.dirty_at
              ),
              attempts = 0,
              last_error = NULL,
              updated_at = new.updated_at
          `,
          params,
          queryOptions(ctx)
        );
        affected += this.db.getAffectedRows(result);
      }
      return affected;
    } finally {
      ctx.timer?.stop(timerName);
    }
  }

  public async listDirty(
    limit: number,
    ctx: RequestContext = {}
  ): Promise<SubscriptionCoverageRefreshRequestEntity[]> {
    const timerName = `${this.constructor.name}->listDirty`;
    ctx.timer?.start(timerName);
    try {
      return await this.db.execute<SubscriptionCoverageRefreshRequestEntity>(
        `
          SELECT *
          FROM ${SUBSCRIPTION_COVERAGE_REFRESH_REQUESTS_TABLE}
          ORDER BY attempts ASC, dirty_at ASC, consolidation_key ASC
          LIMIT :limit
        `,
        { limit },
        queryOptions(ctx)
      );
    } finally {
      ctx.timer?.stop(timerName);
    }
  }

  public async deleteDirty(
    consolidationKey: string,
    dirtyAt: number,
    ctx: RequestContext = {}
  ): Promise<void> {
    const timerName = `${this.constructor.name}->deleteDirty`;
    ctx.timer?.start(timerName);
    try {
      await this.db.execute(
        `
          DELETE FROM ${SUBSCRIPTION_COVERAGE_REFRESH_REQUESTS_TABLE}
          WHERE consolidation_key = :consolidationKey
            AND dirty_at = :dirtyAt
        `,
        { consolidationKey, dirtyAt },
        queryOptions(ctx)
      );
    } finally {
      ctx.timer?.stop(timerName);
    }
  }

  public async recordDirtyFailure(
    consolidationKey: string,
    dirtyAt: number,
    error: unknown,
    ctx: RequestContext = {}
  ): Promise<void> {
    const timerName = `${this.constructor.name}->recordDirtyFailure`;
    ctx.timer?.start(timerName);
    try {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown reconciliation error';
      await this.db.execute(
        `
          UPDATE ${SUBSCRIPTION_COVERAGE_REFRESH_REQUESTS_TABLE}
          SET attempts = attempts + 1,
              last_error = :lastError,
              updated_at = :updatedAt
          WHERE consolidation_key = :consolidationKey
            AND dirty_at = :dirtyAt
        `,
        {
          consolidationKey,
          dirtyAt,
          lastError: errorMessage.slice(0, 1000),
          updatedAt: Time.currentMillis()
        },
        queryOptions(ctx)
      );
    } finally {
      ctx.timer?.stop(timerName);
    }
  }

  public async listDemonstratedIntentKeys(
    startAfter: string | undefined,
    limit: number,
    ctx: RequestContext = {}
  ): Promise<string[]> {
    const timerName = `${this.constructor.name}->listDemonstratedIntentKeys`;
    ctx.timer?.start(timerName);
    try {
      const rows = await this.db.execute<{ consolidation_key: string }>(
        `
          SELECT evidence.consolidation_key
          FROM (
            SELECT LOWER(consolidation_key) AS consolidation_key
            FROM ${SUBSCRIPTIONS_BALANCES_TABLE}
            UNION
            SELECT LOWER(consolidation_key)
            FROM ${SUBSCRIPTIONS_MODE_TABLE}
            UNION
            SELECT LOWER(consolidation_key)
            FROM ${SUBSCRIPTIONS_NFTS_TABLE}
            UNION
            SELECT LOWER(consolidation_key)
            FROM ${SUBSCRIPTIONS_NFTS_FINAL_TABLE}
            UNION
            SELECT LOWER(consolidation_key)
            FROM ${SUBSCRIPTIONS_REDEEMED_TABLE}
            UNION
            SELECT LOWER(
              COALESCE(keys.consolidation_key, topups.from_wallet)
            )
            FROM ${SUBSCRIPTIONS_TOP_UP_TABLE} topups
            LEFT JOIN ${ADDRESS_CONSOLIDATION_KEY} keys
              ON keys.address = LOWER(topups.from_wallet)
          ) evidence
          WHERE (:startAfter IS NULL OR evidence.consolidation_key > :startAfter)
          ORDER BY evidence.consolidation_key ASC
          LIMIT :limit
        `,
        { startAfter: startAfter ?? null, limit },
        queryOptions(ctx)
      );
      return rows.map((row) => row.consolidation_key.toLowerCase());
    } finally {
      ctx.timer?.stop(timerName);
    }
  }

  public async findDemonstratedIntentKeys(
    consolidationKeys: readonly string[],
    ctx: RequestContext = {}
  ): Promise<string[]> {
    const timerName = `${this.constructor.name}->findDemonstratedIntentKeys`;
    ctx.timer?.start(timerName);
    try {
      const keys = uniqueNormalizedKeys(consolidationKeys);
      if (!keys.length) {
        return [];
      }
      const evidenceKeys = new Set<string>();
      for (let offset = 0; offset < keys.length; offset += MAX_KEYS_PER_QUERY) {
        const chunk = keys.slice(offset, offset + MAX_KEYS_PER_QUERY);
        const chunkEvidence = await this.fetchEvidenceKeys(chunk, ctx);
        chunkEvidence.forEach((key) => evidenceKeys.add(key));
      }
      return Array.from(evidenceKeys).sort((left, right) =>
        left.localeCompare(right)
      );
    } finally {
      ctx.timer?.stop(timerName);
    }
  }

  public async loadSourceData(
    consolidationKeys: readonly string[],
    futureTokenIds: readonly number[],
    ctx: RequestContext = {}
  ): Promise<Map<string, SubscriptionCoverageSourceData>> {
    const timerName = `${this.constructor.name}->loadSourceData`;
    ctx.timer?.start(timerName);
    try {
      const keys = uniqueNormalizedKeys(consolidationKeys);
      const tokenIds = Array.from(new Set(futureTokenIds)).sort(
        (left, right) => left - right
      );
      if (!keys.length) {
        return new Map();
      }

      const [balances, modes, evidenceKeys, selections, eligibility] =
        await Promise.all([
          this.fetchBalances(keys, ctx),
          this.fetchModes(keys, ctx),
          this.fetchEvidenceKeys(keys, ctx),
          this.fetchSelections(keys, tokenIds, ctx),
          this.fetchCoverageEligibility(keys, ctx)
        ]);
      const result = new Map<string, SubscriptionCoverageSourceData>();
      for (const key of keys) {
        result.set(key, {
          consolidationKey: key,
          hasDemonstratedIntent: evidenceKeys.has(key),
          balanceEth: balances.get(key) ?? '0',
          mode: modes.get(key) ?? null,
          eligibilityCount: eligibility.get(key) ?? null,
          selections: selections.get(key) ?? []
        });
      }
      return result;
    } finally {
      ctx.timer?.stop(timerName);
    }
  }

  public async resolveCanonicalProfiles(
    consolidationKeys: readonly string[],
    ctx: RequestContext = {}
  ): Promise<Map<string, CanonicalSubscriptionCoverageProfile>> {
    const timerName = `${this.constructor.name}->resolveCanonicalProfiles`;
    ctx.timer?.start(timerName);
    try {
      const keys = uniqueNormalizedKeys(consolidationKeys);
      if (!keys.length) {
        return new Map();
      }
      const rows = await this.db.execute<CanonicalProfileRow>(
        `
          SELECT
            LOWER(identities.consolidation_key) AS consolidation_key,
            profiles.external_id AS profile_id,
            profiles.handle
          FROM ${IDENTITIES_TABLE} identities
          INNER JOIN ${PROFILES_TABLE} profiles
            ON profiles.external_id = identities.profile_id
          WHERE identities.consolidation_key IN (:keys)
          ORDER BY identities.consolidation_key ASC, profiles.normalised_handle ASC
        `,
        { keys },
        queryOptions(ctx)
      );
      const rowsByKey = new Map<string, Map<string, CanonicalProfileRow>>();
      for (const row of rows) {
        const key = row.consolidation_key.toLowerCase();
        const profilesById =
          rowsByKey.get(key) ?? new Map<string, CanonicalProfileRow>();
        profilesById.set(row.profile_id, row);
        rowsByKey.set(key, profilesById);
      }
      const result = new Map<string, CanonicalSubscriptionCoverageProfile>();
      for (const [key, profilesById] of Array.from(rowsByKey.entries())) {
        if (profilesById.size === 1) {
          const [profile] = Array.from(profilesById.values());
          result.set(key, {
            profileId: profile.profile_id,
            handle: profile.handle
          });
        }
      }
      return result;
    } finally {
      ctx.timer?.stop(timerName);
    }
  }

  public async readAlertState(
    consolidationKey: string,
    ctx: RequestContext = {}
  ): Promise<StoredSubscriptionCoverageAlertState | null> {
    const timerName = `${this.constructor.name}->readAlertState`;
    ctx.timer?.start(timerName);
    try {
      const entity =
        await this.db.oneOrNull<SubscriptionCoverageAlertStateEntity>(
          `
            SELECT *
            FROM ${SUBSCRIPTION_COVERAGE_ALERT_STATES_TABLE}
            WHERE consolidation_key = :consolidationKey
          `,
          { consolidationKey: consolidationKey.toLowerCase() },
          queryOptions(ctx)
        );
      return entity ? storedStateFromEntity(entity) : null;
    } finally {
      ctx.timer?.stop(timerName);
    }
  }

  public async readAlertStates(
    consolidationKeys: readonly string[],
    ctx: RequestContext = {}
  ): Promise<Map<string, StoredSubscriptionCoverageAlertState>> {
    const timerName = `${this.constructor.name}->readAlertStates`;
    ctx.timer?.start(timerName);
    try {
      const keys = uniqueNormalizedKeys(consolidationKeys);
      if (!keys.length) {
        return new Map();
      }
      const rows = await this.db.execute<SubscriptionCoverageAlertStateEntity>(
        `
          SELECT *
          FROM ${SUBSCRIPTION_COVERAGE_ALERT_STATES_TABLE}
          WHERE consolidation_key IN (:keys)
        `,
        { keys },
        queryOptions(ctx)
      );
      return new Map(
        rows.map((row) => [
          row.consolidation_key.toLowerCase(),
          storedStateFromEntity(row)
        ])
      );
    } finally {
      ctx.timer?.stop(timerName);
    }
  }

  public async applyAlertSnapshot(
    snapshot: SubscriptionCoverageNotificationSnapshot,
    policy: SubscriptionCoverageAlertPolicy
  ): Promise<SubscriptionCoverageAlertWriteResult> {
    return this.executeNativeQueriesInTransaction(async (connection) =>
      this.applyAlertSnapshotInTransaction(snapshot, policy, connection)
    );
  }

  private async lockOrInitializeAlertState(
    consolidationKey: string,
    snapshot: SubscriptionCoverageNotificationSnapshot,
    now: number,
    connection: ConnectionWrapper<unknown>
  ): Promise<LockedAlertState> {
    const existing =
      await this.db.oneOrNull<SubscriptionCoverageAlertStateEntity>(
        `
          SELECT *
          FROM ${SUBSCRIPTION_COVERAGE_ALERT_STATES_TABLE}
          WHERE consolidation_key = :consolidationKey
          FOR UPDATE
        `,
        { consolidationKey },
        { wrappedConnection: connection }
      );
    if (existing) {
      return {
        currentState: storedStateFromEntity(existing),
        insertedPlaceholder: false
      };
    }

    const insertResult = await this.db.execute(
      `
        INSERT IGNORE INTO ${SUBSCRIPTION_COVERAGE_ALERT_STATES_TABLE} (
          consolidation_key,
          current_status,
          current_fingerprint,
          current_at_risk_token_id,
          current_fully_funded_drops,
          current_requested_mints,
          current_missing_mints,
          recipient_profile_id,
          created_at,
          updated_at
        )
        VALUES (
          :consolidationKey,
          :currentStatus,
          :currentFingerprint,
          :currentAtRiskTokenId,
          :currentFullyFundedDrops,
          :currentRequestedMints,
          :currentMissingMints,
          :recipientProfileId,
          :now,
          :now
        )
      `,
      {
        consolidationKey,
        currentStatus: snapshot.status,
        currentFingerprint: snapshot.fingerprint,
        currentAtRiskTokenId: snapshot.atRiskTokenId,
        currentFullyFundedDrops: snapshot.fullyFundedDrops,
        currentRequestedMints: snapshot.requestedMints,
        currentMissingMints: snapshot.missingMints,
        recipientProfileId: snapshot.recipientProfileId,
        now
      },
      { wrappedConnection: connection }
    );
    const insertedPlaceholder = this.db.getAffectedRows(insertResult) === 1;
    const locked =
      await this.db.oneOrNull<SubscriptionCoverageAlertStateEntity>(
        `
          SELECT *
          FROM ${SUBSCRIPTION_COVERAGE_ALERT_STATES_TABLE}
          WHERE consolidation_key = :consolidationKey
          FOR UPDATE
        `,
        { consolidationKey },
        { wrappedConnection: connection }
      );
    let currentState: StoredSubscriptionCoverageAlertState | null = null;
    if (!insertedPlaceholder && locked) {
      currentState = storedStateFromEntity(locked);
    }
    return { currentState, insertedPlaceholder };
  }

  private async discardInsertedPlaceholder(
    consolidationKey: string,
    insertedPlaceholder: boolean,
    connection: ConnectionWrapper<unknown>
  ): Promise<void> {
    if (!insertedPlaceholder) {
      return;
    }
    await this.db.execute(
      `
        DELETE FROM ${SUBSCRIPTION_COVERAGE_ALERT_STATES_TABLE}
        WHERE consolidation_key = :consolidationKey
      `,
      { consolidationKey },
      { wrappedConnection: connection }
    );
  }

  private async applyAlertSnapshotInTransaction(
    snapshot: SubscriptionCoverageNotificationSnapshot,
    policy: SubscriptionCoverageAlertPolicy,
    connection: ConnectionWrapper<unknown>
  ): Promise<SubscriptionCoverageAlertWriteResult> {
    const consolidationKey = snapshot.consolidationKey.toLowerCase();
    const now = Time.currentMillis();
    const { currentState, insertedPlaceholder } =
      await this.lockOrInitializeAlertState(
        consolidationKey,
        snapshot,
        now,
        connection
      );
    const decision = decideSubscriptionCoverageAlert(
      currentState,
      snapshot,
      policy
    );
    if (decision.shouldNotify && !snapshot.notificationData) {
      await this.discardInsertedPlaceholder(
        consolidationKey,
        insertedPlaceholder,
        connection
      );
      return {
        notificationIds: [],
        notificationStatus: null,
        decisionReason: decision.reason,
        createdBaseline: false
      };
    }
    let notificationIds: number[] = [];
    if (decision.shouldNotify && snapshot.notificationData) {
      if (!this.notificationsDb) {
        throw new Error(
          'Subscription coverage notification writer is not configured'
        );
      }
      notificationIds = await this.notificationsDb.insertManyNotifications(
        [createIdentityNotification(snapshot.notificationData)],
        connection
      );
    }
    const notificationInserted = notificationIds.length === 1;
    const lastNotified = deriveLastNotifiedFields(
      decision.resetNotificationState,
      notificationInserted,
      snapshot,
      currentState,
      now
    );

    await this.db.execute(
      `
        INSERT INTO ${SUBSCRIPTION_COVERAGE_ALERT_STATES_TABLE} (
          consolidation_key,
          current_status,
          current_fingerprint,
          current_at_risk_token_id,
          current_fully_funded_drops,
          current_requested_mints,
          current_missing_mints,
          recipient_profile_id,
          last_notified_status,
          last_notified_fingerprint,
          last_notified_at,
          created_at,
          updated_at
        )
        VALUES (
          :consolidationKey,
          :currentStatus,
          :currentFingerprint,
          :currentAtRiskTokenId,
          :currentFullyFundedDrops,
          :currentRequestedMints,
          :currentMissingMints,
          :recipientProfileId,
          :lastNotifiedStatus,
          :lastNotifiedFingerprint,
          :lastNotifiedAt,
          :now,
          :now
        )
        AS new
        ON DUPLICATE KEY UPDATE
          current_status = new.current_status,
          current_fingerprint = new.current_fingerprint,
          current_at_risk_token_id = new.current_at_risk_token_id,
          current_fully_funded_drops = new.current_fully_funded_drops,
          current_requested_mints = new.current_requested_mints,
          current_missing_mints = new.current_missing_mints,
          recipient_profile_id = new.recipient_profile_id,
          last_notified_status = new.last_notified_status,
          last_notified_fingerprint = new.last_notified_fingerprint,
          last_notified_at = new.last_notified_at,
          updated_at = new.updated_at
      `,
      {
        consolidationKey,
        currentStatus: snapshot.status,
        currentFingerprint: snapshot.fingerprint,
        currentAtRiskTokenId: snapshot.atRiskTokenId,
        currentFullyFundedDrops: snapshot.fullyFundedDrops,
        currentRequestedMints: snapshot.requestedMints,
        currentMissingMints: snapshot.missingMints,
        recipientProfileId: snapshot.recipientProfileId,
        lastNotifiedStatus: lastNotified.status,
        lastNotifiedFingerprint: lastNotified.fingerprint,
        lastNotifiedAt: lastNotified.at,
        now
      },
      { wrappedConnection: connection }
    );
    return {
      notificationIds,
      notificationStatus: notificationInserted ? snapshot.status : null,
      decisionReason: decision.reason,
      createdBaseline: insertedPlaceholder && !notificationInserted
    };
  }

  private async fetchBalances(
    keys: string[],
    ctx: RequestContext
  ): Promise<Map<string, string>> {
    const rows = await this.db.execute<BalanceRow>(
      `
        SELECT
          LOWER(consolidation_key) AS consolidation_key,
          CAST(balance AS CHAR) AS balance_eth
        FROM ${SUBSCRIPTIONS_BALANCES_TABLE}
        WHERE consolidation_key IN (:keys)
      `,
      { keys },
      queryOptions(ctx)
    );
    return new Map(
      rows.map((row) => [row.consolidation_key.toLowerCase(), row.balance_eth])
    );
  }

  private async fetchModes(
    keys: string[],
    ctx: RequestContext
  ): Promise<
    Map<
      string,
      { readonly automatic: boolean; readonly subscribeAllEditions: boolean }
    >
  > {
    const rows = await this.db.execute<ModeRow>(
      `
        SELECT
          LOWER(consolidation_key) AS consolidation_key,
          automatic,
          subscribe_all_editions
        FROM ${SUBSCRIPTIONS_MODE_TABLE}
        WHERE consolidation_key IN (:keys)
      `,
      { keys },
      queryOptions(ctx)
    );
    return new Map(
      rows.map((row) => [
        row.consolidation_key.toLowerCase(),
        {
          automatic: toBoolean(row.automatic),
          subscribeAllEditions: toBoolean(row.subscribe_all_editions)
        }
      ])
    );
  }

  private async fetchEvidenceKeys(
    keys: string[],
    ctx: RequestContext
  ): Promise<Set<string>> {
    const rows = await this.db.execute<{ consolidation_key: string }>(
      `
        SELECT DISTINCT evidence.consolidation_key
        FROM (
          SELECT LOWER(consolidation_key) AS consolidation_key
          FROM ${SUBSCRIPTIONS_BALANCES_TABLE}
          WHERE consolidation_key IN (:keys)
          UNION
          SELECT LOWER(consolidation_key)
          FROM ${SUBSCRIPTIONS_MODE_TABLE}
          WHERE consolidation_key IN (:keys)
          UNION
          SELECT LOWER(consolidation_key)
          FROM ${SUBSCRIPTIONS_NFTS_TABLE}
          WHERE consolidation_key IN (:keys)
          UNION
          SELECT LOWER(consolidation_key)
          FROM ${SUBSCRIPTIONS_NFTS_FINAL_TABLE}
          WHERE consolidation_key IN (:keys)
          UNION
          SELECT LOWER(consolidation_key)
          FROM ${SUBSCRIPTIONS_REDEEMED_TABLE}
          WHERE consolidation_key IN (:keys)
          UNION
          SELECT LOWER(
            COALESCE(consolidations.consolidation_key, topups.from_wallet)
          )
          FROM ${SUBSCRIPTIONS_TOP_UP_TABLE} topups
          LEFT JOIN ${ADDRESS_CONSOLIDATION_KEY} consolidations
            ON consolidations.address = LOWER(topups.from_wallet)
          WHERE LOWER(
            COALESCE(consolidations.consolidation_key, topups.from_wallet)
          ) IN (:keys)
        ) evidence
      `,
      { keys },
      queryOptions(ctx)
    );
    return new Set(rows.map((row) => row.consolidation_key.toLowerCase()));
  }

  private async fetchSelections(
    keys: string[],
    tokenIds: number[],
    ctx: RequestContext
  ): Promise<Map<string, SubscriptionCoverageSourceSelection[]>> {
    const firstFutureTokenId = tokenIds[0] ?? null;
    const rows = await this.db.execute<SelectionRow>(
      `
        SELECT
          LOWER(consolidation_key) AS consolidation_key,
          token_id,
          subscribed,
          subscribed_count,
          automatic_subscription
        FROM ${SUBSCRIPTIONS_NFTS_TABLE}
        WHERE consolidation_key IN (:keys)
          AND contract = :contract
          AND token_id ${
            firstFutureTokenId === null
              ? `> (
                  SELECT COALESCE(MAX(id), 0)
                  FROM ${NFTS_TABLE}
                  WHERE contract = :contract
                )`
              : '>= :firstFutureTokenId'
          }
        ORDER BY consolidation_key ASC, token_id ASC
      `,
      {
        keys,
        contract: MEMES_CONTRACT.toLowerCase(),
        firstFutureTokenId
      },
      queryOptions(ctx)
    );
    const selections = new Map<string, SubscriptionCoverageSourceSelection[]>();
    for (const row of rows) {
      const key = row.consolidation_key.toLowerCase();
      selections.set(key, [
        ...(selections.get(key) ?? []),
        {
          tokenId: toSafeNonNegativeInteger(row.token_id),
          subscribed: toBoolean(row.subscribed),
          subscribedCount: toSafeNonNegativeInteger(row.subscribed_count),
          automaticSubscription: toBoolean(row.automatic_subscription)
        }
      ]);
    }
    return selections;
  }

  private async fetchCoverageEligibility(
    keys: string[],
    ctx: RequestContext
  ): Promise<Map<string, number | null>> {
    const eligibility = new Map<string, number | null>(
      keys.map((key) => [key, 0])
    );
    const season = await this.db.oneOrNull<{ max_id: number | string | null }>(
      `SELECT MAX(id) AS max_id FROM ${MEMES_SEASONS_TABLE}`,
      undefined,
      queryOptions(ctx)
    );
    if (season?.max_id === null || season?.max_id === undefined) {
      for (const key of keys) {
        eligibility.set(key, null);
      }
      return eligibility;
    }
    const rows = await this.db.execute<EligibilityRow>(
      `
        SELECT LOWER(consolidation_key) AS consolidation_key, sets
        FROM ${CONSOLIDATED_OWNERS_BALANCES_MEMES_TABLE}
        WHERE consolidation_key IN (:keys)
          AND season = :seasonId
      `,
      { keys, seasonId: Number(season.max_id) },
      queryOptions(ctx)
    );
    for (const row of rows) {
      eligibility.set(
        row.consolidation_key.toLowerCase(),
        toSafeNonNegativeInteger(row.sets)
      );
    }
    return eligibility;
  }
}

export const subscriptionCoverageRepository =
  new SubscriptionCoverageRepository(dbSupplier);
