import { MEMBERSHIP_REFRESH_TARGETS_TABLE } from '@/constants';
import { MembershipRefreshTargetEntity } from '@/entities/IMembershipRefreshTarget';
import { LazyDbAccessCompatibleService } from '@/sql-executor';
import {
  MembershipPrimaryContext,
  membershipQueryOptions
} from './membership-primary';
import { MembershipRefreshScope } from './membership-schema.types';
import {
  compareMembershipIds,
  MEMBERSHIP_DB_NOW,
  requireMembershipLabel,
  timeMembershipOperation
} from './membership-repository.utils';
import {
  normalizeCounter,
  normalizeRefreshTarget
} from './membership-validation';

export interface MembershipRefreshRequest {
  readonly scope: MembershipRefreshScope;
  readonly target_id: string;
  readonly reason: string;
}

/**
 * Durable invalidations; optional wakeups follow caller commit. Acquire source
 * and catalogue locks before requesting targets, never afterward in the same
 * transaction. Request-only callers touch only these final target locks.
 */
export class MembershipRefreshTargetsDb extends LazyDbAccessCompatibleService {
  async request(
    requests: readonly MembershipRefreshRequest[],
    ctx: MembershipPrimaryContext
  ): Promise<void> {
    return timeMembershipOperation(
      'MembershipRefreshTargetsDb->request',
      ctx,
      async () => {
        const options = membershipQueryOptions(ctx);
        if (requests.length > 128)
          throw new Error('Membership request batch exceeds 128');
        const unique = new Map<string, MembershipRefreshRequest>();
        for (const request of requests) {
          const target = normalizeRefreshTarget(request);
          requireMembershipLabel(request.reason, 'refresh reason');
          unique.set(`${target.scope}/${target.target_id}`, {
            ...target,
            reason: request.reason
          });
        }
        const ordered = Array.from(unique.entries()).sort(([a], [b]) =>
          compareMembershipIds(a, b)
        );
        if (!ordered.length) return;
        const params: Record<string, string> = {};
        const values = ordered.map(([, request], i) => {
          params[`scope${i}`] = request.scope;
          params[`target${i}`] = request.target_id;
          params[`reason${i}`] = request.reason;
          return `(:scope${i}, :target${i}, 1, 0, NULL, ${MEMBERSHIP_DB_NOW}, :reason${i}, 0, NULL, ${MEMBERSHIP_DB_NOW}, ${MEMBERSHIP_DB_NOW})`;
        });
        await this.db.execute(
          `INSERT INTO ${MEMBERSHIP_REFRESH_TARGETS_TABLE}
          (scope, target_id, requested_version, completed_version, active_run_id,
           available_at_millis, reason, attempts, last_error, created_at_millis, updated_at_millis)
         VALUES ${values.join(',')}
         ON DUPLICATE KEY UPDATE requested_version = requested_version + 1,
           available_at_millis = ${MEMBERSHIP_DB_NOW}, reason = VALUES(reason),
           attempts = 0, last_error = NULL, updated_at_millis = ${MEMBERSHIP_DB_NOW}`,
          params,
          options
        );
      }
    );
  }

  async find(
    target: Pick<MembershipRefreshRequest, 'scope' | 'target_id'>,
    ctx: MembershipPrimaryContext
  ): Promise<MembershipRefreshTargetEntity | null> {
    return timeMembershipOperation(
      'MembershipRefreshTargetsDb->find',
      ctx,
      async () => {
        const key = normalizeRefreshTarget(target);
        const row = await this.db.oneOrNull<MembershipRefreshTargetEntity>(
          `SELECT scope, target_id, CAST(requested_version AS CHAR) requested_version,
          CAST(completed_version AS CHAR) completed_version, active_run_id,
          CAST(available_at_millis AS CHAR) available_at_millis, reason, attempts, last_error,
          CAST(created_at_millis AS CHAR) created_at_millis, CAST(updated_at_millis AS CHAR) updated_at_millis
         FROM ${MEMBERSHIP_REFRESH_TARGETS_TABLE} WHERE scope = :scope AND target_id = :target_id`,
          key,
          membershipQueryOptions(ctx)
        );
        if (!row) return null;
        return {
          ...row,
          requested_version: normalizeCounter(row.requested_version),
          completed_version: normalizeCounter(row.completed_version)
        };
      }
    );
  }
}
