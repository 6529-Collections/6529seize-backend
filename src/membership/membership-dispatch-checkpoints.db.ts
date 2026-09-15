import {
  MEMBERSHIP_REFRESH_TARGETS_TABLE,
  MEMBERSHIP_RUNTIME_CHECKPOINTS_TABLE
} from '@/constants';
import { LazyDbAccessCompatibleService } from '@/sql-executor';
import {
  MembershipPrimaryContext,
  membershipQueryOptions
} from './membership-primary';
import {
  MEMBERSHIP_DB_NOW,
  timeMembershipOperation
} from './membership-repository.utils';
import { normalizeCounter } from './membership-validation';
import { membershipAddCounter } from './membership-worker-validation';
import { MembershipWorkerDb } from './membership-worker.db';
import {
  MEMBERSHIP_DISPATCH_CHECKPOINT_ID,
  MembershipDispatchDueKey,
  MembershipDispatchIntegrityError,
  MembershipDispatchLane,
  MembershipDispatchPosition,
  MembershipDispatchProgress,
  MembershipDispatchRawKey
} from './membership-dispatch.types';
import {
  initialMembershipDispatchProgress,
  normalizeMembershipDispatchProgress
} from './membership-dispatch-validation';

interface Control {
  revision: string;
  progress: MembershipDispatchProgress;
}
interface ColumnOrder {
  name: string;
  character_set: string;
  collation: string;
}

/** Locks only the DISPATCH control row; returned keys become usable after caller COMMIT. */
export class MembershipDispatchCheckpointsDb extends LazyDbAccessCompatibleService {
  async provision(ctx: MembershipPrimaryContext): Promise<void> {
    return timeMembershipOperation(
      'MembershipDispatchCheckpointsDb->provision',
      ctx,
      async () => {
        await this.db.execute(
          `INSERT INTO ${MEMBERSHIP_RUNTIME_CHECKPOINTS_TABLE}
        (id,protocol_version,revision,progress,created_at_millis,updated_at_millis)
        VALUES (:id,1,0,:progress,${MEMBERSHIP_DB_NOW},${MEMBERSHIP_DB_NOW})
        ON DUPLICATE KEY UPDATE id=id`,
          {
            id: MEMBERSHIP_DISPATCH_CHECKPOINT_ID,
            progress: JSON.stringify(initialMembershipDispatchProgress())
          },
          membershipQueryOptions(ctx)
        );
        await this.read(ctx);
      }
    );
  }

  private async read(ctx: MembershipPrimaryContext): Promise<Control> {
    const row = await this.db.oneOrNull<{
      id: string;
      protocol_version: number;
      revision: string;
      progress: unknown;
    }>(
      `SELECT id,protocol_version,CAST(revision AS CHAR) revision,progress
      FROM ${MEMBERSHIP_RUNTIME_CHECKPOINTS_TABLE} WHERE id=:id FOR UPDATE NOWAIT`,
      { id: MEMBERSHIP_DISPATCH_CHECKPOINT_ID },
      membershipQueryOptions(ctx)
    );
    if (
      !row ||
      row.id !== MEMBERSHIP_DISPATCH_CHECKPOINT_ID ||
      row.protocol_version !== 1
    )
      throw new MembershipDispatchIntegrityError(
        'DISPATCH control requires explicit protocol 1 provisioning'
      );
    let revision: string;
    try {
      revision = normalizeCounter(row.revision);
    } catch {
      throw new MembershipDispatchIntegrityError('Invalid dispatch revision');
    }
    const progress = normalizeMembershipDispatchProgress(row.progress);
    await this.validateOrdering(progress, ctx);
    return { revision, progress };
  }

  private async sourceOrder(
    ctx: MembershipPrimaryContext
  ): Promise<Record<'scope' | 'target_id', ColumnOrder>> {
    const rows = await this.db.execute<ColumnOrder>(
      `SELECT COLUMN_NAME name,CHARACTER_SET_NAME character_set,COLLATION_NAME collation
      FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE()
      AND TABLE_NAME=:table AND COLUMN_NAME IN ('scope','target_id') LIMIT 2`,
      { table: MEMBERSHIP_REFRESH_TARGETS_TABLE },
      membershipQueryOptions(ctx)
    );
    const scope = rows.find((row) => row.name === 'scope');
    const target_id = rows.find((row) => row.name === 'target_id');
    for (const column of [scope, target_id]) {
      if (
        !column ||
        !/^utf8(mb3|mb4)?$/.test(column.character_set) ||
        !/^utf8(mb3|mb4)?_[a-z0-9_]+$/.test(column.collation)
      )
        throw new MembershipDispatchIntegrityError(
          'Unsupported dispatch source collation'
        );
    }
    return { scope: scope!, target_id: target_id! };
  }

  private async validateOrdering(
    progress: MembershipDispatchProgress,
    ctx: MembershipPrimaryContext
  ): Promise<void> {
    const pairs: [MembershipDispatchRawKey, MembershipDispatchRawKey][] = [];
    if (progress.target_pk.after)
      pairs.push([progress.target_pk.after, progress.target_pk.through!]);
    if (progress.due.after) {
      const after = BigInt(progress.due.after.available_at_millis);
      const through = BigInt(progress.due.through!.available_at_millis);
      if (after > through)
        throw new MembershipDispatchIntegrityError(
          'Dispatch due frontier exceeds high bound'
        );
      if (after === through)
        pairs.push([progress.due.after, progress.due.through!]);
    }
    if (!pairs.length) return;
    const order = await this.sourceOrder(ctx);
    const operand = (parameter: string, column: ColumnOrder) =>
      `(CONVERT(:${parameter} USING ${column.character_set}) COLLATE ${column.collation})`;
    const aScope = operand('aScope', order.scope);
    const bScope = operand('bScope', order.scope);
    const aId = operand('aId', order.target_id);
    const bId = operand('bId', order.target_id);
    for (const [after, through] of pairs) {
      const row = await this.db.oneOrNull<{ ordered: number }>(
        `SELECT (${aScope}<${bScope} OR (${aScope}=${bScope} AND ${aId}<=${bId})) ordered`,
        {
          aScope: after.scope,
          aId: after.target_id,
          bScope: through.scope,
          bId: through.target_id
        },
        membershipQueryOptions(ctx)
      );
      if (Number(row?.ordered) !== 1)
        throw new MembershipDispatchIntegrityError(
          'Dispatch frontier exceeds source high bound'
        );
    }
  }

  async reserve(
    closedLanes: readonly MembershipDispatchLane[],
    ctx: MembershipPrimaryContext
  ): Promise<MembershipDispatchPosition> {
    return timeMembershipOperation(
      'MembershipDispatchCheckpointsDb->reserve',
      ctx,
      async () => {
        const control = await this.read(ctx);
        const now = await new MembershipWorkerDb(() => this.db).now(ctx);
        const lane = control.progress.next_lane;
        // Empty/wrapped lanes remain closed for this invocation. Persist alternation
        // without reopening one while the other still has a bounded turn available.
        const position = closedLanes.includes(lane)
          ? { lane, key: null, exhausted: true }
          : await this.advance(control.progress, lane, now, ctx);
        control.progress.next_lane = lane === 'DUE' ? 'TARGET_PK' : 'DUE';
        const result = await this.db.execute(
          `UPDATE ${MEMBERSHIP_RUNTIME_CHECKPOINTS_TABLE} SET progress=:progress,revision=:next,updated_at_millis=:now
        WHERE id=:id AND revision=:revision`,
          {
            id: MEMBERSHIP_DISPATCH_CHECKPOINT_ID,
            progress: JSON.stringify(
              normalizeMembershipDispatchProgress(control.progress)
            ),
            next: membershipAddCounter(control.revision, 1),
            revision: control.revision,
            now
          },
          membershipQueryOptions(ctx)
        );
        if (this.db.getAffectedRows(result) !== 1)
          throw new MembershipDispatchIntegrityError(
            'Dispatch checkpoint revision changed'
          );
        return position;
      }
    );
  }

  private async advance(
    progress: MembershipDispatchProgress,
    lane: MembershipDispatchLane,
    now: string,
    ctx: MembershipPrimaryContext
  ): Promise<MembershipDispatchPosition> {
    const key =
      lane === 'DUE'
        ? await this.due(progress.due, now, ctx)
        : await this.primary(progress.target_pk, ctx);
    return { lane, key, exhausted: key === null };
  }

  private async due(
    lane: MembershipDispatchProgress['due'],
    now: string,
    ctx: MembershipPrimaryContext
  ): Promise<MembershipDispatchDueKey | null> {
    if (lane.through === null) {
      lane.through = await this.db.oneOrNull<MembershipDispatchDueKey>(
        `SELECT CAST(t.available_at_millis AS CHAR) available_at_millis,t.scope,t.target_id
        FROM ${MEMBERSHIP_REFRESH_TARGETS_TABLE} t FORCE INDEX(idx_mrt_available_scope_target)
        WHERE t.available_at_millis IS NOT NULL AND t.available_at_millis<=:cutoff
        ORDER BY t.available_at_millis DESC,t.scope DESC,t.target_id DESC LIMIT 1`,
        { cutoff: now },
        membershipQueryOptions(ctx)
      );
      lane.cutoff_millis = lane.through === null ? null : now;
    }
    const key =
      lane.through === null
        ? null
        : await this.db.oneOrNull<MembershipDispatchDueKey>(
            `SELECT CAST(t.available_at_millis AS CHAR) available_at_millis,t.scope,t.target_id
      FROM ${MEMBERSHIP_REFRESH_TARGETS_TABLE} t FORCE INDEX(idx_mrt_available_scope_target)
      WHERE t.available_at_millis IS NOT NULL AND t.available_at_millis<=:cutoff
      ${
        lane.after === null
          ? ''
          : `AND (t.available_at_millis>:afterTime
        OR (t.available_at_millis=:afterTime AND t.scope>:afterScope)
        OR (t.available_at_millis=:afterTime AND t.scope=:afterScope AND t.target_id>:afterId))`
      }
      AND (t.available_at_millis<:throughTime
        OR (t.available_at_millis=:throughTime AND t.scope<:throughScope)
        OR (t.available_at_millis=:throughTime AND t.scope=:throughScope AND t.target_id<=:throughId))
      ORDER BY t.available_at_millis,t.scope,t.target_id LIMIT 1`,
            {
              cutoff: lane.cutoff_millis,
              afterTime: lane.after?.available_at_millis,
              afterScope: lane.after?.scope,
              afterId: lane.after?.target_id,
              throughTime: lane.through.available_at_millis,
              throughScope: lane.through.scope,
              throughId: lane.through.target_id
            },
            membershipQueryOptions(ctx)
          );
    if (key) lane.after = key;
    else {
      lane.after = null;
      lane.through = null;
      lane.cutoff_millis = null;
      lane.sweep = membershipAddCounter(lane.sweep, 1);
    }
    return key;
  }

  private async primary(
    lane: MembershipDispatchProgress['target_pk'],
    ctx: MembershipPrimaryContext
  ): Promise<MembershipDispatchRawKey | null> {
    if (lane.through === null)
      lane.through = await this.db.oneOrNull<MembershipDispatchRawKey>(
        `SELECT t.scope,t.target_id FROM ${MEMBERSHIP_REFRESH_TARGETS_TABLE} t FORCE INDEX(PRIMARY)
        ORDER BY t.scope DESC,t.target_id DESC LIMIT 1`,
        {},
        membershipQueryOptions(ctx)
      );
    const key =
      lane.through === null
        ? null
        : await this.db.oneOrNull<MembershipDispatchRawKey>(
            `SELECT t.scope,t.target_id FROM ${MEMBERSHIP_REFRESH_TARGETS_TABLE} t FORCE INDEX(PRIMARY)
      WHERE (t.scope<:throughScope OR (t.scope=:throughScope AND t.target_id<=:throughId))
      ${lane.after === null ? '' : 'AND (t.scope>:afterScope OR (t.scope=:afterScope AND t.target_id>:afterId))'}
      ORDER BY t.scope,t.target_id LIMIT 1`,
            {
              afterScope: lane.after?.scope,
              afterId: lane.after?.target_id,
              throughScope: lane.through.scope,
              throughId: lane.through.target_id
            },
            membershipQueryOptions(ctx)
          );
    if (key) lane.after = key;
    else {
      lane.after = null;
      lane.through = null;
      lane.sweep = membershipAddCounter(lane.sweep, 1);
    }
    return key;
  }
}
