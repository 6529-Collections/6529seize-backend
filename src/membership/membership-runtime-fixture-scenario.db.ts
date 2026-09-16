import {
  MEMBERSHIP_GENERATION_MEMBERS_TABLE,
  MEMBERSHIP_PUBLICATIONS_TABLE
} from '@/constants';
import { SqlExecutor } from '@/sql-executor';
import {
  MembershipPrimaryContext,
  membershipQueryOptions
} from './membership-primary';
import { MembershipRefreshTargetsDb } from './membership-refresh-targets.db';
import { MEMBERSHIP_FIXTURE_GROUPS } from './membership-runtime-policy';
import { MembershipWorkerDb } from './membership-worker.db';
import { MembershipWorkerRun } from './membership-worker.types';
import { MembershipRefreshTargetKey } from './membership-validation';
import { MEMBERSHIP_DB_NOW } from './membership-repository.utils';
import { isMembershipFixturePublicationSettled } from './membership-runtime-fixture-settled';

export class MembershipFixtureScenarioDb {
  readonly runs: MembershipWorkerDb;
  readonly targets: MembershipRefreshTargetsDb;
  constructor(private readonly db: SqlExecutor) {
    this.runs = new MembershipWorkerDb(() => db);
    this.targets = new MembershipRefreshTargetsDb(() => db);
  }
  async target(key: MembershipRefreshTargetKey, ctx: MembershipPrimaryContext) {
    const target = await this.runs.target(key, false, ctx);
    if (!target) throw new Error('Fixture target is missing');
    return target;
  }
  async request(
    key: MembershipRefreshTargetKey,
    ctx: MembershipPrimaryContext
  ) {
    await this.targets.request(
      [{ ...key, reason: 'staging-fixture-scenario-v2' }],
      ctx
    );
    return this.target(key, ctx);
  }
  async publicationId(
    profile: string,
    ctx: MembershipPrimaryContext
  ): Promise<string> {
    const row = await this.db.oneOrNull<{ run_id: string }>(
      `SELECT run_id FROM ${MEMBERSHIP_PUBLICATIONS_TABLE} WHERE profile_id=:profile`,
      { profile },
      membershipQueryOptions(ctx)
    );
    if (!row) throw new Error('Fixture profile has no publication');
    return row.run_id;
  }
  async published(
    profile: string,
    ctx: MembershipPrimaryContext
  ): Promise<MembershipWorkerRun> {
    const target = await this.runs.target(
      { scope: 'PROFILE', target_id: profile },
      false,
      ctx
    );
    const publication = await this.db.oneOrNull<{ run_id: string }>(
      `SELECT run_id FROM ${MEMBERSHIP_PUBLICATIONS_TABLE} WHERE profile_id=:profile`,
      { profile },
      membershipQueryOptions(ctx)
    );
    if (!publication)
      throw new Error('Fixture profile has no settled current publication');
    const run = await this.runs.run(publication.run_id, false, ctx);
    const clock = await this.db.oneOrNull<{ now: string }>(
      `SELECT CAST(${MEMBERSHIP_DB_NOW} AS CHAR) now`,
      {},
      membershipQueryOptions(ctx)
    );
    if (
      !target ||
      !run ||
      !clock ||
      !isMembershipFixturePublicationSettled(target, run, clock.now)
    )
      throw new Error('Fixture profile has no settled current publication');
    return run;
  }
  async partial(
    profile: string,
    ctx: MembershipPrimaryContext
  ): Promise<MembershipWorkerRun> {
    const target = await this.target(
      { scope: 'PROFILE', target_id: profile },
      ctx
    );
    const run = target.active_run_id
      ? await this.runs.run(target.active_run_id, false, ctx)
      : null;
    if (
      !run ||
      !['PENDING', 'RUNNING'].includes(run.status) ||
      run.scope !== 'PROFILE' ||
      run.target_id !== profile ||
      run.checkpoint_version === '0' ||
      run.progress_cursor.phase !== 'SCAN' ||
      BigInt(run.processed_count) >= BigInt(36)
    )
      throw new Error('Fixture source change requires an active partial run');
    return run;
  }
  async superseded(id: string, ctx: MembershipPrimaryContext): Promise<string> {
    const run = await this.runs.run(id, false, ctx);
    if (run?.status !== 'SUPERSEDED')
      throw new Error('Fixture superseded run has not been observed');
    return this.runs.now(ctx);
  }
  async membership(
    run: MembershipWorkerRun,
    index: number,
    expected: boolean,
    ctx: MembershipPrimaryContext
  ) {
    const rows = await this.db.execute(
      `SELECT 1 FROM ${MEMBERSHIP_GENERATION_MEMBERS_TABLE} WHERE run_id=:run AND group_id=:group LIMIT 1`,
      { run: run.id, group: MEMBERSHIP_FIXTURE_GROUPS[index] },
      membershipQueryOptions(ctx)
    );
    if ((rows.length === 1) !== expected)
      throw new Error(
        'Fixture grant publication has not reached the required outcome'
      );
  }
}
