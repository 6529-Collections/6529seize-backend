import {
  MEMBERSHIP_GROUP_VERSIONS_TABLE,
  MEMBERSHIP_SOURCE_JOBS_TABLE,
  MEMBERSHIP_SOURCE_STATES_TABLE,
  USER_GROUPS_TABLE
} from '@/constants';
import { MembershipSourceStateEntity } from '@/entities/IMembershipSourceState';
import { LazyDbAccessCompatibleService } from '@/sql-executor';
import {
  MembershipPrimaryContext,
  membershipQueryOptions
} from './membership-primary';
import {
  MembershipRefreshRequest,
  MembershipRefreshTargetsDb
} from './membership-refresh-targets.db';
import {
  compareMembershipIds,
  MEMBERSHIP_DB_NOW,
  requireMembershipLabel,
  timeMembershipOperation
} from './membership-repository.utils';
import { MembershipSourceVersion } from './membership-schema.types';
import {
  MembershipSourceKey,
  normalizeCounter,
  normalizeRefreshTarget,
  orderedSourceKeys
} from './membership-validation';

export class MembershipSourceNotReadyError extends Error {
  constructor() {
    super('Membership source evidence is missing or has an active producer');
    Object.setPrototypeOf(this, MembershipSourceNotReadyError.prototype);
  }
}

export interface MembershipSourceEvidence {
  readonly key: MembershipSourceKey;
  /** Absence is unknown, never an implicit version zero. */
  readonly state: MembershipSourceStateEntity | null;
  readonly provisioned: boolean;
}

export interface MembershipSourceProvisioning {
  /** Caller has audited producer coverage; this is never automatic bootstrap. */
  readonly bootstrap_id: string;
  readonly coverage_revision: string;
}

export interface MembershipGroupChange {
  readonly group_id: string;
  readonly is_deleted: boolean;
}

export interface MembershipSourceMutation {
  readonly keys: readonly MembershipSourceKey[];
  readonly requests: readonly MembershipRefreshRequest[];
  /** Shared dataset mutexes/barriers to inspect without incrementing their versions. */
  readonly guard_keys?: readonly MembershipSourceKey[];
  readonly group_changes?: readonly MembershipGroupChange[];
}

export const MEMBERSHIP_CATALOG_KEY: MembershipSourceKey = {
  scope: 'GLOBAL',
  target_id: '*',
  dimension: 'GROUP_CATALOG'
};

export function withGlobalSourceKeys(
  keys: readonly MembershipSourceKey[]
): MembershipSourceKey[] {
  const normalized = orderedSourceKeys(keys);
  const all = new Map(
    normalized.map((key) => [membershipSourceKeyId(key), key])
  );
  for (const key of normalized) {
    const global: MembershipSourceKey = {
      scope: 'GLOBAL',
      target_id: '*',
      dimension: key.dimension
    };
    all.set(membershipSourceKeyId(global), global);
  }
  return orderedSourceKeys(Array.from(all.values()));
}

export const membershipSourceKeyId = (key: MembershipSourceKey): string =>
  `${key.scope}/${key.target_id}/${key.dimension}`;

/** All mutations participate in the caller's primary transaction. */
export class MembershipSourceStatesDb extends LazyDbAccessCompatibleService {
  async read(
    keys: readonly MembershipSourceKey[],
    lock: boolean,
    ctx: MembershipPrimaryContext
  ): Promise<MembershipSourceEvidence[]> {
    return timeMembershipOperation(
      'MembershipSourceStatesDb->read',
      ctx,
      async () => {
        const options = membershipQueryOptions(ctx);
        const result: MembershipSourceEvidence[] = [];
        for (const key of orderedSourceKeys(keys)) {
          const state = await this.db.oneOrNull<MembershipSourceStateEntity>(
            `SELECT scope, target_id, dimension, CAST(version AS CHAR) version,
             active_jobs, CAST(updated_at_millis AS CHAR) updated_at_millis
           FROM ${MEMBERSHIP_SOURCE_STATES_TABLE}
           WHERE scope = :scope AND target_id = :target_id AND dimension = :dimension
           ${lock ? 'FOR UPDATE' : ''}`,
            { ...key },
            options
          );
          if (
            state &&
            (!Number.isSafeInteger(state.active_jobs) || state.active_jobs < 0)
          ) {
            throw new Error('Invalid membership source barrier');
          }
          result.push({
            key,
            provisioned: state
              ? await this.hasProvisioningReceipt(key, lock, ctx)
              : false,
            state: state
              ? {
                  ...state,
                  version: normalizeCounter(state.version),
                  updated_at_millis: normalizeCounter(state.updated_at_millis)
                }
              : null
          });
        }
        return result;
      }
    );
  }

  async capture(
    keys: readonly MembershipSourceKey[],
    lock: boolean,
    ctx: MembershipPrimaryContext
  ): Promise<MembershipSourceVersion[]> {
    return timeMembershipOperation(
      'MembershipSourceStatesDb->capture',
      ctx,
      async () => {
        const evidence = await this.read(keys, lock, ctx);
        return evidence.map(({ key, state, provisioned }) => {
          if (!state || !provisioned || state.active_jobs !== 0)
            throw new MembershipSourceNotReadyError();
          return { ...key, version: state.version };
        });
      }
    );
  }

  async provision(
    keys: readonly MembershipSourceKey[],
    evidence: MembershipSourceProvisioning,
    ctx: MembershipPrimaryContext
  ): Promise<void> {
    return this.provisionWithPrefix(keys, evidence, 'bootstrap:', ctx);
  }

  /** Only a caller that inserted these identities in this transaction may use this path. */
  async provisionBorn(
    keys: readonly MembershipSourceKey[],
    evidence: MembershipSourceProvisioning,
    ctx: MembershipPrimaryContext
  ): Promise<void> {
    if (keys.some((key) => key.scope !== 'PROFILE'))
      throw new Error('Membership birth receipt requires PROFILE keys');
    return this.provisionWithPrefix(keys, evidence, 'birth:', ctx);
  }

  private async provisionWithPrefix(
    keys: readonly MembershipSourceKey[],
    evidence: MembershipSourceProvisioning,
    prefix: 'bootstrap:' | 'birth:',
    ctx: MembershipPrimaryContext
  ): Promise<void> {
    return timeMembershipOperation(
      'MembershipSourceStatesDb->provision',
      ctx,
      async () => {
        const options = membershipQueryOptions(ctx);
        requireMembershipLabel(evidence.bootstrap_id, 'bootstrap ID', 80);
        requireMembershipLabel(evidence.coverage_revision, 'coverage revision');
        for (const key of orderedSourceKeys(keys)) {
          const [existing] = await this.read([key], true, ctx);
          if (existing.state) {
            if (!existing.provisioned)
              throw new MembershipSourceNotReadyError();
            continue;
          }
          await this.db.execute(
            `INSERT INTO ${MEMBERSHIP_SOURCE_STATES_TABLE}
           (scope, target_id, dimension, version, active_jobs, updated_at_millis)
           VALUES (:scope, :target_id, :dimension, 0, 0, ${MEMBERSHIP_DB_NOW})`,
            { ...key },
            options
          );
          // The completed bootstrap receipt records why version zero was initialized.
          await this.db.execute(
            `INSERT INTO ${MEMBERSHIP_SOURCE_JOBS_TABLE}
           (scope, target_id, dimension, job_id, status, progress, started_version,
            completed_version, created_at_millis, updated_at_millis, last_error)
           VALUES (:scope, :target_id, :dimension, :job_id, 'COMPLETED', :progress,
            0, 0, ${MEMBERSHIP_DB_NOW}, ${MEMBERSHIP_DB_NOW}, NULL)`,
            {
              ...key,
              job_id: `${prefix}${evidence.bootstrap_id}`,
              progress: JSON.stringify({
                stage: 'PROVISIONED',
                after_id: null,
                coverage_revision: evidence.coverage_revision
              })
            },
            options
          );
        }
      }
    );
  }

  async mutate<T>(
    mutation: MembershipSourceMutation,
    write: (ctx: MembershipPrimaryContext) => Promise<T>,
    ctx: MembershipPrimaryContext
  ): Promise<T> {
    return timeMembershipOperation(
      'MembershipSourceStatesDb->mutate',
      ctx,
      async () => {
        const keys = orderedSourceKeys(mutation.keys);
        if (!keys.length || !mutation.requests.length) {
          throw new Error(
            'Membership mutation requires sources and refresh requests'
          );
        }
        const guards = orderedSourceKeys(mutation.guard_keys ?? []);
        const all = new Map(
          [...keys, ...guards].map((key) => [membershipSourceKeyId(key), key])
        );
        await this.capture(
          withGlobalSourceKeys(Array.from(all.values())),
          true,
          ctx
        );
        this.validateGroupChanges(mutation.group_changes ?? [], keys);
        const result = await write(ctx);
        await this.increment(keys, 0, ctx);
        await this.recordGroupChanges(mutation.group_changes ?? [], ctx);
        await new MembershipRefreshTargetsDb(() => this.db).request(
          mutation.requests,
          ctx
        );
        return result;
      }
    );
  }

  /**
   * Profile consolidation may rewrite more than 128 group REP/CIC references.
   * The indexed INSERT SELECT versions every affected group in one transaction
   * without dropping IDs from a bounded JavaScript list.
   */
  async mutateProfileRuleReferences<T>(
    sourceProfileId: string,
    write: (ctx: MembershipPrimaryContext) => Promise<T>,
    ctx: MembershipPrimaryContext
  ): Promise<T> {
    return timeMembershipOperation(
      'MembershipSourceStatesDb->mutateProfileRuleReferences',
      ctx,
      async () => {
        const [catalog] = await this.capture(
          [MEMBERSHIP_CATALOG_KEY],
          true,
          ctx
        );
        const options = membershipQueryOptions(ctx);
        const affected = await this.db.oneOrNull<{ count: number }>(
          `SELECT COUNT(*) count FROM ${USER_GROUPS_TABLE}
           WHERE rep_user = :sourceProfileId OR cic_user = :sourceProfileId`,
          { sourceProfileId },
          options
        );
        if (!Number(affected?.count ?? 0)) return write(ctx);
        const nextVersion = (BigInt(catalog.version) + BigInt(1)).toString();
        await this.db.execute(
          `INSERT INTO ${MEMBERSHIP_GROUP_VERSIONS_TABLE}
           (group_id, catalog_version, is_deleted, updated_at_millis)
           SELECT id, :nextVersion, false, ${MEMBERSHIP_DB_NOW}
           FROM ${USER_GROUPS_TABLE}
           WHERE rep_user = :sourceProfileId OR cic_user = :sourceProfileId
           ON DUPLICATE KEY UPDATE catalog_version = VALUES(catalog_version),
             is_deleted = VALUES(is_deleted), updated_at_millis = ${MEMBERSHIP_DB_NOW}`,
          { sourceProfileId, nextVersion },
          options
        );
        const result = await write(ctx);
        await this.increment([MEMBERSHIP_CATALOG_KEY], 0, ctx);
        await new MembershipRefreshTargetsDb(() => this.db).request(
          [
            {
              scope: 'FULL',
              target_id: '*',
              reason: 'profile-rule-reference-move'
            }
          ],
          ctx
        );
        return result;
      }
    );
  }

  /** Caller already holds every source row lock; jobs use this in the same transaction. */
  async increment(
    keys: readonly MembershipSourceKey[],
    activeJobsDelta: -1 | 0 | 1,
    ctx: MembershipPrimaryContext
  ): Promise<void> {
    return timeMembershipOperation(
      'MembershipSourceStatesDb->increment',
      ctx,
      async () => {
        const options = membershipQueryOptions(ctx);
        for (const { key, state, provisioned } of await this.read(
          keys,
          true,
          ctx
        )) {
          const expectedJobs = activeJobsDelta === -1 ? 1 : 0;
          if (!state || !provisioned || state.active_jobs !== expectedJobs)
            throw new MembershipSourceNotReadyError();
          await this.db.execute(
            `UPDATE ${MEMBERSHIP_SOURCE_STATES_TABLE}
           SET version = version + 1, active_jobs = active_jobs + :delta,
             updated_at_millis = ${MEMBERSHIP_DB_NOW}
           WHERE scope = :scope AND target_id = :target_id AND dimension = :dimension`,
            { ...key, delta: activeJobsDelta },
            options
          );
        }
      }
    );
  }

  private async hasProvisioningReceipt(
    key: MembershipSourceKey,
    lock: boolean,
    ctx: MembershipPrimaryContext
  ): Promise<boolean> {
    const receipts = await this.db.execute<{ progress: unknown }>(
      `SELECT progress FROM ${MEMBERSHIP_SOURCE_JOBS_TABLE}
       WHERE scope = :scope AND target_id = :target_id AND dimension = :dimension
         AND (job_id LIKE 'bootstrap:%' OR job_id LIKE 'birth:%')
         AND status = 'COMPLETED'
         AND started_version = 0 AND completed_version = 0
       LIMIT 2 ${lock ? 'FOR UPDATE' : ''}`,
      { ...key },
      membershipQueryOptions(ctx)
    );
    if (receipts.length !== 1) return false;
    try {
      const progress: unknown =
        typeof receipts[0].progress === 'string'
          ? JSON.parse(receipts[0].progress)
          : receipts[0].progress;
      if (
        !progress ||
        typeof progress !== 'object' ||
        !('stage' in progress) ||
        progress.stage !== 'PROVISIONED' ||
        !('coverage_revision' in progress) ||
        typeof progress.coverage_revision !== 'string'
      )
        return false;
      requireMembershipLabel(progress.coverage_revision, 'coverage revision');
      return true;
    } catch {
      return false;
    }
  }

  private validateGroupChanges(
    changes: readonly MembershipGroupChange[],
    keys: readonly MembershipSourceKey[]
  ): void {
    if (changes.length > 128)
      throw new Error('Membership catalogue batch exceeds 128');
    const hasCatalog = keys.some(
      (key) =>
        membershipSourceKeyId(key) ===
        membershipSourceKeyId(MEMBERSHIP_CATALOG_KEY)
    );
    if (hasCatalog !== changes.length > 0) {
      throw new Error('Catalogue mutation requires group-version evidence');
    }
    const ids = new Set<string>();
    for (const change of changes) {
      normalizeRefreshTarget({ scope: 'GROUP', target_id: change.group_id });
      if (typeof change.is_deleted !== 'boolean' || ids.has(change.group_id)) {
        throw new Error('Invalid membership group change');
      }
      ids.add(change.group_id);
    }
  }

  private async recordGroupChanges(
    changes: readonly MembershipGroupChange[],
    ctx: MembershipPrimaryContext
  ): Promise<void> {
    if (!changes.length) return;
    const [catalog] = await this.capture([MEMBERSHIP_CATALOG_KEY], true, ctx);
    for (const change of [...changes].sort((a, b) =>
      compareMembershipIds(a.group_id, b.group_id)
    )) {
      await this.db.execute(
        `INSERT INTO ${MEMBERSHIP_GROUP_VERSIONS_TABLE}
         (group_id, catalog_version, is_deleted, updated_at_millis)
         VALUES (:group_id, :version, :is_deleted, ${MEMBERSHIP_DB_NOW})
         ON DUPLICATE KEY UPDATE catalog_version = VALUES(catalog_version),
           is_deleted = VALUES(is_deleted), updated_at_millis = ${MEMBERSHIP_DB_NOW}`,
        { ...change, version: catalog.version },
        membershipQueryOptions(ctx)
      );
    }
  }
}
