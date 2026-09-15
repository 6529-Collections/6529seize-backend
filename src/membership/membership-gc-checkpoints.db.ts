import { randomUUID } from 'node:crypto';
import {
  MEMBERSHIP_REFRESH_RUNS_TABLE,
  MEMBERSHIP_RUNTIME_CHECKPOINTS_TABLE
} from '@/constants';
import { LazyDbAccessCompatibleService } from '@/sql-executor';
import {
  MembershipPrimaryContext,
  membershipQueryOptions
} from './membership-primary';
import { timeMembershipOperation } from './membership-repository.utils';
import {
  MembershipGcHint,
  MembershipGcLane,
  MembershipGcOptions,
  MembershipGcPending,
  MembershipGcProgress,
  MembershipGcResult,
  MembershipGcScanKey,
  MEMBERSHIP_GC_CHECKPOINT_ID,
  MEMBERSHIP_GC_PENDING_CAPACITY,
  initialMembershipGcProgress,
  normalizeMembershipGcProgress
} from './membership-gc.types';
import { MembershipWorkerDb } from './membership-worker.db';
import { MembershipWorkerError } from './membership-worker.types';
import {
  membershipAddCounter,
  membershipUuidSchema
} from './membership-worker-validation';
import {
  MembershipRefreshTargetKey,
  normalizeCounter,
  normalizeRefreshTarget
} from './membership-validation';

interface Control {
  revision: string;
  progress: MembershipGcProgress;
}
interface Discovery extends MembershipGcScanKey, MembershipRefreshTargetKey {}

/** Control-only transactions: no target, run, publication, or member locks. */
export class MembershipGcCheckpointsDb extends LazyDbAccessCompatibleService {
  async provision(ctx: MembershipPrimaryContext): Promise<void> {
    return timeMembershipOperation(
      'MembershipGcCheckpointsDb->provision',
      ctx,
      async () => {
        const now = await new MembershipWorkerDb(() => this.db).now(ctx);
        await this.db.execute(
          `INSERT IGNORE INTO ${MEMBERSHIP_RUNTIME_CHECKPOINTS_TABLE}
        (id,protocol_version,revision,progress,created_at_millis,updated_at_millis) VALUES (:id,1,0,:progress,:now,:now)`,
          {
            id: MEMBERSHIP_GC_CHECKPOINT_ID,
            progress: JSON.stringify(initialMembershipGcProgress()),
            now
          },
          membershipQueryOptions(ctx)
        );
        await this.read(ctx);
      }
    );
  }

  private async read(ctx: MembershipPrimaryContext): Promise<Control> {
    const row = await this.db.oneOrNull<{
      protocol_version: number;
      revision: string;
      progress: unknown;
    }>(
      `SELECT protocol_version,CAST(revision AS CHAR) revision,progress
      FROM ${MEMBERSHIP_RUNTIME_CHECKPOINTS_TABLE} WHERE id=:id FOR UPDATE NOWAIT`,
      { id: MEMBERSHIP_GC_CHECKPOINT_ID },
      membershipQueryOptions(ctx)
    );
    if (row?.protocol_version !== 1)
      throw new MembershipWorkerError(
        'INTEGRITY',
        'Membership GC checkpoint is not provisioned with protocol 1'
      );
    return {
      revision: normalizeCounter(row.revision),
      progress: normalizeMembershipGcProgress(row.progress)
    };
  }

  private async save(
    control: Control,
    now: string,
    ctx: MembershipPrimaryContext
  ): Promise<void> {
    const progress = normalizeMembershipGcProgress(control.progress);
    const result = await this.db.execute(
      `UPDATE ${MEMBERSHIP_RUNTIME_CHECKPOINTS_TABLE} SET progress=:progress,revision=:next,updated_at_millis=:now WHERE id=:id AND revision=:revision`,
      {
        id: MEMBERSHIP_GC_CHECKPOINT_ID,
        progress: JSON.stringify(progress),
        next: membershipAddCounter(control.revision, 1),
        revision: control.revision,
        now
      },
      membershipQueryOptions(ctx)
    );
    if (this.db.getAffectedRows(result) !== 1)
      throw new MembershipWorkerError(
        'FENCED',
        'Membership GC checkpoint changed'
      );
  }

  async reserve(
    options: MembershipGcOptions,
    ctx: MembershipPrimaryContext
  ): Promise<MembershipGcHint | null> {
    return timeMembershipOperation(
      'MembershipGcCheckpointsDb->reserve',
      ctx,
      async () => {
        const control = await this.read(ctx);
        const now = await new MembershipWorkerDb(() => this.db).now(ctx);
        control.progress.pending = control.progress.pending.filter(
          (item) =>
            item.claim_expires_at_millis === null ||
            BigInt(item.claim_expires_at_millis) > BigInt(now)
        );
        const hint =
          control.progress.next_kind === 'DISCOVERY'
            ? await this.discovery(control.progress, now, options, ctx)
            : await this.pending(control.progress, now, options, ctx);
        control.progress.next_kind =
          control.progress.next_kind === 'DISCOVERY' ? 'PENDING' : 'DISCOVERY';
        await this.save(control, now, ctx);
        return hint;
      }
    );
  }

  private async discovery(
    progress: MembershipGcProgress,
    now: string,
    options: MembershipGcOptions,
    ctx: MembershipPrimaryContext
  ): Promise<MembershipGcHint | null> {
    const lane = progress.lanes[progress.next_terminal_lane];
    progress.next_terminal_lane = (progress.next_terminal_lane + 1) % 3;
    if (lane.through === null) {
      const cutoff =
        BigInt(now) > BigInt(options.scan_age_millis)
          ? String(BigInt(now) - BigInt(options.scan_age_millis))
          : '0';
      const tail = await this.db.oneOrNull<MembershipGcScanKey>(
        `SELECT CAST(r.updated_at_millis AS CHAR) updated_at_millis,r.id
        FROM ${MEMBERSHIP_REFRESH_RUNS_TABLE} r FORCE INDEX(idx_mrun_status_updated_id)
        WHERE r.status=:status AND r.updated_at_millis>=0 AND r.updated_at_millis<=:cutoff ORDER BY r.updated_at_millis DESC,r.id DESC LIMIT 1`,
        { status: lane.status, cutoff },
        membershipQueryOptions(ctx)
      );
      if (!tail) {
        this.exhaust(lane);
        return null;
      }
      lane.through = {
        id: tail.id,
        updated_at_millis: normalizeCounter(tail.updated_at_millis)
      };
      lane.cutoff_millis = cutoff;
    }
    const row = await this.next(lane, ctx);
    if (!row) {
      this.exhaust(lane);
      return null;
    }
    lane.after = {
      id: row.id,
      updated_at_millis: normalizeCounter(row.updated_at_millis)
    };
    let target: MembershipRefreshTargetKey;
    try {
      membershipUuidSchema.parse(row.id);
      target = normalizeRefreshTarget(row);
    } catch {
      return null;
    }
    const existing = progress.pending.some((item) => item.run_id === row.id);
    if (existing) return null;
    const entry = this.admit(progress, row.id, now, options);
    return {
      run_id: row.id,
      target,
      pending: entry
        ? { slot: entry.slot, claim_token: entry.claim_token }
        : null
    };
  }

  private exhaust(lane: MembershipGcLane): void {
    lane.after = null;
    lane.through = null;
    lane.cutoff_millis = null;
    lane.sweep = membershipAddCounter(lane.sweep, 1);
  }

  private async next(
    lane: MembershipGcLane,
    ctx: MembershipPrimaryContext
  ): Promise<Discovery | null> {
    return this.db.oneOrNull<Discovery>(
      `SELECT r.id,r.scope,r.target_id,CAST(r.updated_at_millis AS CHAR) updated_at_millis
      FROM ${MEMBERSHIP_REFRESH_RUNS_TABLE} r FORCE INDEX(idx_mrun_status_updated_id)
      WHERE r.status=:status AND r.updated_at_millis>=0 ${lane.after === null ? '' : 'AND (r.updated_at_millis>:afterTime OR (r.updated_at_millis=:afterTime AND r.id>:afterId))'}
      AND (r.updated_at_millis<:throughTime OR (r.updated_at_millis=:throughTime AND r.id<=:throughId))
      ORDER BY r.updated_at_millis,r.id LIMIT 1`,
      {
        status: lane.status,
        afterTime: lane.after?.updated_at_millis,
        afterId: lane.after?.id,
        throughTime: lane.through!.updated_at_millis,
        throughId: lane.through!.id
      },
      membershipQueryOptions(ctx)
    );
  }

  private admit(
    progress: MembershipGcProgress,
    id: string,
    now: string,
    options: MembershipGcOptions
  ): MembershipGcPending | null {
    const slots = new Set(progress.pending.map((item) => item.slot));
    for (let slot = 0; slot < MEMBERSHIP_GC_PENDING_CAPACITY; slot++) {
      if (slots.has(slot)) continue;
      const entry: MembershipGcPending = {
        slot,
        run_id: id,
        kind: 'PROBE',
        eligible_at_millis: now,
        claim_token: randomUUID(),
        claim_expires_at_millis: membershipAddCounter(
          now,
          options.pending_claim_millis
        )
      };
      progress.pending.push(entry);
      return entry;
    }
    return null;
  }

  private async pending(
    progress: MembershipGcProgress,
    now: string,
    options: MembershipGcOptions,
    ctx: MembershipPrimaryContext
  ): Promise<MembershipGcHint | null> {
    for (let offset = 0; offset < MEMBERSHIP_GC_PENDING_CAPACITY; offset++) {
      const slot =
        (progress.next_pending_slot + offset) % MEMBERSHIP_GC_PENDING_CAPACITY;
      const entry = progress.pending.find((item) => item.slot === slot);
      if (
        entry?.claim_token !== null ||
        BigInt(entry.eligible_at_millis) > BigInt(now)
      )
        continue;
      progress.next_pending_slot = (slot + 1) % MEMBERSHIP_GC_PENDING_CAPACITY;
      const target = await this.db.oneOrNull<MembershipRefreshTargetKey>(
        `SELECT scope,target_id FROM ${MEMBERSHIP_REFRESH_RUNS_TABLE} WHERE id=:id`,
        { id: entry.run_id },
        membershipQueryOptions(ctx)
      );
      if (!target) {
        progress.pending = progress.pending.filter(
          (item) => item.slot !== slot
        );
        return null;
      }
      let key: MembershipRefreshTargetKey;
      try {
        key = normalizeRefreshTarget(target);
      } catch {
        progress.pending = progress.pending.filter(
          (item) => item.slot !== slot
        );
        return null;
      }
      entry.claim_token = randomUUID();
      entry.claim_expires_at_millis = membershipAddCounter(
        now,
        options.pending_claim_millis
      );
      return {
        run_id: entry.run_id,
        target: key,
        pending: { slot, claim_token: entry.claim_token }
      };
    }
    progress.next_pending_slot =
      (progress.next_pending_slot + 1) % MEMBERSHIP_GC_PENDING_CAPACITY;
    return null;
  }

  async record(
    hint: MembershipGcHint,
    result: MembershipGcResult,
    ctx: MembershipPrimaryContext
  ): Promise<void> {
    return timeMembershipOperation(
      'MembershipGcCheckpointsDb->record',
      ctx,
      async () => {
        if (!hint.pending) return;
        const control = await this.read(ctx);
        const entry = control.progress.pending.find(
          (item) =>
            item.slot === hint.pending!.slot &&
            item.run_id === hint.run_id &&
            item.claim_token === hint.pending!.claim_token
        );
        if (!entry) return;
        const now = await new MembershipWorkerDb(() => this.db).now(ctx);
        if (result.run_id !== hint.run_id)
          throw new MembershipWorkerError(
            'INTEGRITY',
            'Membership GC result identity mismatch'
          );
        if (result.outcome === 'PARTIAL' || result.outcome === 'ELIGIBLE') {
          entry.kind = 'DELETE';
          entry.eligible_at_millis = result.retry_at_millis ?? now;
          entry.claim_token = null;
          entry.claim_expires_at_millis = null;
        } else
          control.progress.pending = control.progress.pending.filter(
            (item) => item !== entry
          );
        await this.save(control, now, ctx);
      }
    );
  }
}
