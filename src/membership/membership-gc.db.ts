import {
  MEMBERSHIP_GENERATION_MEMBERS_TABLE,
  MEMBERSHIP_PUBLICATIONS_TABLE,
  MEMBERSHIP_REFRESH_RUNS_TABLE
} from '@/constants';
import { LazyDbAccessCompatibleService } from '@/sql-executor';
import {
  MembershipPrimaryContext,
  membershipQueryOptions
} from './membership-primary';
import { timeMembershipOperation } from './membership-repository.utils';
import {
  MembershipGcHint,
  MembershipGcOptions,
  MembershipGcResult,
  MEMBERSHIP_GC_TERMINAL_STATUSES
} from './membership-gc.types';
import {
  MEMBERSHIP_RUN_SELECT,
  MembershipWorkerDb
} from './membership-worker.db';
import { MembershipWorkerRun } from './membership-worker.types';
import {
  membershipAddCounter,
  normalizeMembershipWorkerCursor,
  normalizeMembershipWorkerRun
} from './membership-worker-validation';
import {
  assertMembershipBoundedInteger,
  assertMembershipId
} from './membership-validation';

/** One independently guarded quantum. Never holds a runtime checkpoint lock. */
export class MembershipGcDb extends LazyDbAccessCompatibleService {
  async collect(
    hint: MembershipGcHint,
    options: MembershipGcOptions,
    ctx: MembershipPrimaryContext
  ): Promise<MembershipGcResult> {
    return timeMembershipOperation('MembershipGcDb->collect', ctx, async () => {
      assertMembershipBoundedInteger(
        options.member_batch,
        'GC member batch',
        1,
        128
      );
      assertMembershipBoundedInteger(
        options.reader_grace_millis,
        'reader grace',
        1,
        86400000
      );
      const result = (
        outcome: MembershipGcResult['outcome'],
        retry: string | null = null
      ): MembershipGcResult => ({
        run_id: hint.run_id,
        outcome,
        read_count: 0,
        deleted_count: 0,
        retry_at_millis: retry
      });
      const repository = new MembershipWorkerDb(() => this.db);
      const target = await repository.target(hint.target, true, ctx);
      if (!target) return result('QUARANTINED');
      // These guards precede the first consistent read, so member existence is
      // observed in a fresh snapshot while correct writers cannot change it.
      const raw = await this.db.oneOrNull<MembershipWorkerRun>(
        `SELECT ${MEMBERSHIP_RUN_SELECT} FROM ${MEMBERSHIP_REFRESH_RUNS_TABLE} WHERE id=:id FOR UPDATE NOWAIT`,
        { id: hint.run_id },
        membershipQueryOptions(ctx)
      );
      if (!raw) return result('MISSING');
      let run: MembershipWorkerRun;
      try {
        run = normalizeMembershipWorkerRun(raw);
      } catch {
        return result('QUARANTINED');
      }
      if (
        run.scope !== hint.target.scope ||
        run.target_id !== hint.target.target_id
      )
        return result('QUARANTINED');
      if (
        target.active_run_id === run.id ||
        !(MEMBERSHIP_GC_TERMINAL_STATUSES as readonly string[]).includes(
          run.status
        )
      )
        return result('PROTECTED');
      if (
        run.lease_token !== null ||
        run.lease_expires_at_millis !== null ||
        run.completed_at_millis === null
      )
        return result('QUARANTINED');
      if (await this.isPublished(run, ctx)) return result('PROTECTED');
      const now = await repository.now(ctx);
      const retirement = run.progress_cursor.gc;
      if (!retirement) {
        await this.saveCursor(
          run,
          { retired_at_millis: now, after_group_id: null },
          now,
          ctx
        );
        return result(
          'RETIRED',
          membershipAddCounter(now, options.reader_grace_millis)
        );
      }
      const eligible = membershipAddCounter(
        retirement.retired_at_millis,
        options.reader_grace_millis
      );
      if (BigInt(now) < BigInt(eligible)) return result('TOO_YOUNG', eligible);
      // A pending slot is required before deletion, keeping partial work on the
      // prompt bounded path instead of waiting for an entire global sweep.
      if (!hint.pending) return result('ELIGIBLE', now);
      return this.deleteWindow(run, options.member_batch, now, ctx);
    });
  }

  private async isPublished(
    run: MembershipWorkerRun,
    ctx: MembershipPrimaryContext
  ): Promise<boolean> {
    if (run.scope === 'PROFILE') {
      const current = await this.db.oneOrNull<{ run_id: string }>(
        `SELECT run_id FROM ${MEMBERSHIP_PUBLICATIONS_TABLE} WHERE profile_id=:profile FOR UPDATE NOWAIT`,
        { profile: run.target_id },
        membershipQueryOptions(ctx)
      );
      if (current?.run_id === run.id) return true;
    }
    // Protect unexpected references as well; LIMIT is bounded by an exact index.
    const references = await this.db.execute<{ profile_id: string }>(
      `SELECT profile_id FROM ${MEMBERSHIP_PUBLICATIONS_TABLE} FORCE INDEX(idx_mp_run) WHERE run_id=:run LIMIT 2 FOR UPDATE NOWAIT`,
      { run: run.id },
      membershipQueryOptions(ctx)
    );
    return references.length > 0;
  }

  private async rawWindow(
    run: string,
    after: string | null,
    limit: number,
    ctx: MembershipPrimaryContext
  ): Promise<string[]> {
    const rows = await this.db.execute<{ group_id: string }>(
      `SELECT m.group_id FROM ${MEMBERSHIP_GENERATION_MEMBERS_TABLE} m FORCE INDEX(PRIMARY)
      WHERE m.run_id=:run ${after === null ? '' : 'AND m.group_id>:after'} ORDER BY m.group_id LIMIT :limit`,
      { run, after, limit },
      membershipQueryOptions(ctx)
    );
    return rows.map((row) => {
      assertMembershipId(row.group_id, 'GC member group', 200);
      return row.group_id;
    });
  }

  private async deleteWindow(
    run: MembershipWorkerRun,
    limit: number,
    now: string,
    ctx: MembershipPrimaryContext
  ): Promise<MembershipGcResult> {
    const retirement = run.progress_cursor.gc!;
    let raw = await this.rawWindow(
      run.id,
      retirement.after_group_id,
      limit,
      ctx
    );
    // One wrap only. Locked earlier members remain visible to the existence
    // check, and do not pin later windows behind a broad SKIP LOCKED scan.
    if (!raw.length && retirement.after_group_id !== null)
      raw = await this.rawWindow(run.id, null, limit, ctx);
    let deleted = 0;
    if (raw.length) {
      const locked = await this.db.execute<{ group_id: string }>(
        `SELECT group_id FROM ${MEMBERSHIP_GENERATION_MEMBERS_TABLE} FORCE INDEX(PRIMARY)
        WHERE run_id=:run AND group_id IN (:ids) ORDER BY group_id FOR UPDATE SKIP LOCKED`,
        { run: run.id, ids: raw },
        membershipQueryOptions(ctx)
      );
      if (locked.length) {
        await this.db.execute(
          `DELETE FROM ${MEMBERSHIP_GENERATION_MEMBERS_TABLE} WHERE run_id=:run AND group_id IN (:ids)`,
          { run: run.id, ids: locked.map((row) => row.group_id) },
          membershipQueryOptions(ctx)
        );
        deleted = locked.length;
      }
    }
    const remains = await this.db.execute<{ group_id: string }>(
      `SELECT group_id FROM ${MEMBERSHIP_GENERATION_MEMBERS_TABLE} FORCE INDEX(PRIMARY) WHERE run_id=:run LIMIT 1`,
      { run: run.id },
      membershipQueryOptions(ctx)
    );
    if (!remains.length) {
      await this.db.execute(
        `DELETE FROM ${MEMBERSHIP_REFRESH_RUNS_TABLE} WHERE id=:id`,
        { id: run.id },
        membershipQueryOptions(ctx)
      );
      return {
        run_id: run.id,
        outcome: 'DELETED',
        read_count: raw.length,
        deleted_count: deleted,
        retry_at_millis: null
      };
    }
    await this.saveCursor(
      run,
      {
        ...retirement,
        after_group_id: raw[raw.length - 1] ?? retirement.after_group_id
      },
      now,
      ctx
    );
    return {
      run_id: run.id,
      outcome: 'PARTIAL',
      read_count: raw.length,
      deleted_count: deleted,
      retry_at_millis: now
    };
  }

  private async saveCursor(
    run: MembershipWorkerRun,
    retirement: NonNullable<MembershipWorkerRun['progress_cursor']['gc']>,
    now: string,
    ctx: MembershipPrimaryContext
  ): Promise<void> {
    const cursor = normalizeMembershipWorkerCursor({
      ...run.progress_cursor,
      gc: retirement
    });
    await this.db.execute(
      `UPDATE ${MEMBERSHIP_REFRESH_RUNS_TABLE} SET progress_cursor=:cursor,updated_at_millis=:now WHERE id=:id`,
      { id: run.id, cursor: JSON.stringify(cursor), now },
      membershipQueryOptions(ctx)
    );
  }
}
