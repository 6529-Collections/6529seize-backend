import {
  IDENTITIES_TABLE,
  MEMBERSHIP_GROUP_VERSIONS_TABLE,
  MEMBERSHIP_RUNTIME_CHECKPOINTS_TABLE,
  MEMBERSHIP_SOURCE_JOBS_TABLE,
  MEMBERSHIP_SOURCE_STATES_TABLE,
  USER_GROUPS_TABLE
} from '@/constants';
import { DbPoolName } from '@/db-query.options';
import { dbSupplier, LazyDbAccessCompatibleService } from '@/sql-executor';
import {
  MembershipPrimaryContext,
  membershipQueryOptions
} from './membership-primary';
import {
  MEMBERSHIP_DB_NOW,
  timeMembershipOperation
} from './membership-repository.utils';
import {
  MEMBERSHIP_CATALOG_KEY,
  MembershipSourceStatesDb
} from './membership-source-states.db';
import { MembershipSourceDimension } from './membership-schema.types';
import {
  assertMembershipBoundedInteger,
  assertMembershipId,
  normalizeCounter,
  orderedSourceKeys
} from './membership-validation';
import { MembershipRefreshTargetsDb } from './membership-refresh-targets.db';

export const MEMBERSHIP_BOOTSTRAP_CHECKPOINT_ID = 'membership-bootstrap-v1';
export const MEMBERSHIP_BOOTSTRAP_ID = 'membership-m8-v1';
export const MEMBERSHIP_BOOTSTRAP_COVERAGE_REVISION =
  'membership-producers-m8-v1';
export const MEMBERSHIP_BOOTSTRAP_PRETRACK_WAIT_MILLIS = 960000;

export const MEMBERSHIP_BOOTSTRAP_WRITERS = [
  'api',
  'helpBotReplyLoop',
  'helpBotDailyActivityCreditLoop',
  'xTdhLoop',
  'tdhLoop',
  'delegationsLoop',
  'overRatesRevocationLoop',
  'xTdhGrantsReviewerLoop',
  'nftOwnersLoop',
  'externalCollectionSnapshottingLoop',
  'externalCollectionLiveTailingLoop'
] as const;

const GLOBAL_DIMENSIONS = [
  'TDH_XTDH',
  'RATINGS',
  'OWNERSHIP',
  'DELEGATIONS',
  'GRANTS',
  'IDENTITY',
  'GROUP_CATALOG'
] as const satisfies readonly MembershipSourceDimension[];
const PROFILE_DIMENSIONS = GLOBAL_DIMENSIONS.filter(
  (dimension) => dimension !== 'GROUP_CATALOG'
);
const GLOBAL_KEYS = orderedSourceKeys(
  GLOBAL_DIMENSIONS.map((dimension) => ({
    scope: 'GLOBAL' as const,
    target_id: '*',
    dimension
  }))
);

export interface MembershipTrackedWriterEvidence {
  readonly source_sha: string;
  readonly function_version: string;
  readonly code_sha256: string;
  readonly last_modified_millis: string;
  readonly timeout_seconds: number;
  readonly deploy_run_id: string;
  readonly mode: 'tracking-v1';
  readonly stage: 'staging';
}

export interface MembershipTrackedWriterReceipt {
  readonly expected_staging_sha: string;
  readonly verified_at_millis: string;
  readonly old_invocations_drained_at_millis: string;
  readonly units: Record<
    (typeof MEMBERSHIP_BOOTSTRAP_WRITERS)[number],
    MembershipTrackedWriterEvidence
  >;
}

export type MembershipBootstrapStage =
  | 'GLOBAL_READY'
  | 'PRETRACK_PROFILE_SCAN'
  | 'WAITING_FOR_WRITERS'
  | 'GROUP_SCAN'
  | 'GROUP_SCAN_VERIFY'
  | 'POSTTRACK_PROFILE_SCAN'
  | 'VERIFY'
  | 'COMPLETE';

interface MembershipBootstrapScan {
  readonly after_id: string | null;
  readonly through_id: string | null;
  readonly source_version: string;
  readonly scanned: string;
  readonly inserted: string;
  readonly sweeps: string;
}

export interface MembershipBootstrapProgress {
  readonly bootstrap_id: string;
  readonly coverage_revision: string;
  readonly stage: MembershipBootstrapStage;
  readonly tracked_writer_receipt: MembershipTrackedWriterReceipt | null;
  readonly prepared_at_millis: string;
  readonly pretrack_not_before_millis: string;
  readonly profile: MembershipBootstrapScan;
  readonly group: MembershipBootstrapScan;
  readonly baseline_source_versions: Record<
    MembershipSourceDimension,
    string
  > | null;
  readonly completed_at_millis: string | null;
}

interface CheckpointRow {
  readonly protocol_version: number;
  readonly revision: string;
  readonly progress: unknown;
}

interface IdRow {
  readonly id: string;
  readonly occurrences?: number | string;
}
interface ProfileSourceRow {
  readonly target_id: string;
  readonly dimension: MembershipSourceDimension;
}
interface ProfileReceiptRow extends ProfileSourceRow {
  readonly job_id: string;
  readonly progress: unknown;
  readonly started_version: string;
  readonly completed_version: string | null;
  readonly status: string;
}

function add(value: string, amount: number): string {
  return (BigInt(value) + BigInt(amount)).toString();
}

function parseJson(value: unknown): unknown {
  return typeof value === 'string' ? JSON.parse(value) : value;
}

function validateReceipt(receipt: MembershipTrackedWriterReceipt): void {
  if (!/^[0-9a-f]{40}$/.test(receipt.expected_staging_sha))
    throw new Error('Invalid membership bootstrap staging source SHA');
  const seen = Object.keys(receipt.units ?? {}).sort((a, b) =>
    a.localeCompare(b)
  );
  const required = [...MEMBERSHIP_BOOTSTRAP_WRITERS].sort((a, b) =>
    a.localeCompare(b)
  );
  if (JSON.stringify(seen) !== JSON.stringify(required))
    throw new Error('Membership bootstrap writer inventory is incomplete');
  const verified = normalizeCounter(receipt.verified_at_millis);
  const drained = normalizeCounter(receipt.old_invocations_drained_at_millis);
  if (BigInt(drained) < BigInt(verified))
    throw new Error('Membership bootstrap writer drain predates verification');
  let latestSafeDrain = BigInt(0);
  for (const unit of MEMBERSHIP_BOOTSTRAP_WRITERS) {
    const evidence = receipt.units[unit];
    if (
      !evidence ||
      evidence.source_sha !== receipt.expected_staging_sha ||
      !/^[A-Za-z0-9+/]{43}=$/.test(evidence.code_sha256) ||
      !/^(?:\$LATEST|[1-9][0-9]*)$/.test(evidence.function_version) ||
      !Number.isSafeInteger(evidence.timeout_seconds) ||
      evidence.timeout_seconds < 1 ||
      evidence.timeout_seconds > 900 ||
      !/^[1-9][0-9]*$/.test(evidence.deploy_run_id) ||
      evidence.mode !== 'tracking-v1' ||
      evidence.stage !== 'staging'
    )
      throw new Error(`Invalid membership bootstrap writer evidence: ${unit}`);
    const modified = BigInt(normalizeCounter(evidence.last_modified_millis));
    const safeDrain =
      modified + BigInt(evidence.timeout_seconds * 1000 + 60000);
    if (safeDrain > latestSafeDrain) latestSafeDrain = safeDrain;
  }
  if (BigInt(drained) < latestSafeDrain)
    throw new Error(
      'Membership bootstrap old writer invocations may still run'
    );
}

function validateScan(value: MembershipBootstrapScan): void {
  if (!value || typeof value !== 'object')
    throw new Error('Invalid membership bootstrap scan');
  for (const id of [value.after_id, value.through_id])
    if (id !== null) assertMembershipId(id, 'bootstrap cursor', 200);
  for (const counter of [
    value.source_version,
    value.scanned,
    value.inserted,
    value.sweeps
  ])
    normalizeCounter(counter);
}

function validateProgress(raw: unknown): MembershipBootstrapProgress {
  const value = parseJson(raw) as MembershipBootstrapProgress;
  if (
    !value ||
    value.bootstrap_id !== MEMBERSHIP_BOOTSTRAP_ID ||
    value.coverage_revision !== MEMBERSHIP_BOOTSTRAP_COVERAGE_REVISION ||
    ![
      'GLOBAL_READY',
      'PRETRACK_PROFILE_SCAN',
      'WAITING_FOR_WRITERS',
      'GROUP_SCAN',
      'GROUP_SCAN_VERIFY',
      'POSTTRACK_PROFILE_SCAN',
      'VERIFY',
      'COMPLETE'
    ].includes(value.stage)
  )
    throw new Error('Invalid membership bootstrap checkpoint');
  validateScan(value.profile);
  validateScan(value.group);
  if (value.tracked_writer_receipt !== null)
    validateReceipt(value.tracked_writer_receipt);
  normalizeCounter(value.prepared_at_millis);
  normalizeCounter(value.pretrack_not_before_millis);
  if (
    BigInt(value.pretrack_not_before_millis) <
    BigInt(value.prepared_at_millis) +
      BigInt(MEMBERSHIP_BOOTSTRAP_PRETRACK_WAIT_MILLIS)
  )
    throw new Error('Membership bootstrap pretracking fence is too short');
  if (value.baseline_source_versions !== null) {
    for (const dimension of GLOBAL_DIMENSIONS)
      normalizeCounter(value.baseline_source_versions[dimension]);
  }
  if (value.completed_at_millis !== null)
    normalizeCounter(value.completed_at_millis);
  return value;
}

function emptyScan(): MembershipBootstrapScan {
  return {
    after_id: null,
    through_id: null,
    source_version: '0',
    scanned: '0',
    inserted: '0',
    sweeps: '0'
  };
}

function initialProgress(now: string): MembershipBootstrapProgress {
  return {
    bootstrap_id: MEMBERSHIP_BOOTSTRAP_ID,
    coverage_revision: MEMBERSHIP_BOOTSTRAP_COVERAGE_REVISION,
    stage: 'GLOBAL_READY',
    tracked_writer_receipt: null,
    prepared_at_millis: now,
    pretrack_not_before_millis: add(
      now,
      MEMBERSHIP_BOOTSTRAP_PRETRACK_WAIT_MILLIS
    ),
    profile: emptyScan(),
    group: emptyScan(),
    baseline_source_versions: null,
    completed_at_millis: null
  };
}

/** The checkpoint is progress only; source and group receipts are the evidence. */
export class MembershipBootstrapDb extends LazyDbAccessCompatibleService {
  async prepare(
    ctx: MembershipPrimaryContext
  ): Promise<MembershipBootstrapProgress> {
    return timeMembershipOperation(
      'MembershipBootstrapDb->prepare',
      ctx,
      async () => {
        await new MembershipSourceStatesDb(() => this.db).provision(
          GLOBAL_KEYS,
          {
            bootstrap_id: MEMBERSHIP_BOOTSTRAP_ID,
            coverage_revision: MEMBERSHIP_BOOTSTRAP_COVERAGE_REVISION
          },
          ctx
        );
        await this.verifyGlobalReceipts(ctx);
        const now = await this.now(ctx);
        await this.db.execute(
          `INSERT INTO ${MEMBERSHIP_RUNTIME_CHECKPOINTS_TABLE}
         (id,protocol_version,revision,progress,created_at_millis,updated_at_millis)
         VALUES (:id,1,0,:progress,${MEMBERSHIP_DB_NOW},${MEMBERSHIP_DB_NOW})
         ON DUPLICATE KEY UPDATE id=id`,
          {
            id: MEMBERSHIP_BOOTSTRAP_CHECKPOINT_ID,
            progress: JSON.stringify(initialProgress(now))
          },
          membershipQueryOptions(ctx)
        );
        return (await this.read(true, ctx))!.progress;
      }
    );
  }

  async status(
    ctx: MembershipPrimaryContext
  ): Promise<MembershipBootstrapProgress | null> {
    return (await this.read(false, ctx))?.progress ?? null;
  }

  /** Independent primary read bypasses an older caller-owned RR snapshot. */
  async isPreparedCommitted(): Promise<boolean> {
    const row = await this.db.oneOrNull<CheckpointRow>(
      `SELECT protocol_version,CAST(revision AS CHAR) revision,progress
       FROM ${MEMBERSHIP_RUNTIME_CHECKPOINTS_TABLE} WHERE id=:id`,
      { id: MEMBERSHIP_BOOTSTRAP_CHECKPOINT_ID },
      { forcePool: DbPoolName.WRITE }
    );
    if (!row) return false;
    if (row.protocol_version !== 1)
      throw new Error('Invalid membership bootstrap protocol');
    normalizeCounter(row.revision);
    validateProgress(row.progress);
    return true;
  }

  async recordTrackedWriters(
    receipt: MembershipTrackedWriterReceipt,
    ctx: MembershipPrimaryContext
  ): Promise<MembershipBootstrapProgress> {
    return timeMembershipOperation(
      'MembershipBootstrapDb->recordTrackedWriters',
      ctx,
      async () => {
        validateReceipt(receipt);
        const current = await this.requireControl(ctx);
        if (current.progress.tracked_writer_receipt) {
          if (
            JSON.stringify(current.progress.tracked_writer_receipt) !==
            JSON.stringify(receipt)
          )
            throw new Error('Membership bootstrap writer receipt is immutable');
          return current.progress;
        }
        if (current.progress.stage !== 'WAITING_FOR_WRITERS')
          throw new Error(
            'Membership bootstrap pretracking scan is incomplete'
          );
        const next: MembershipBootstrapProgress = {
          ...current.progress,
          tracked_writer_receipt: receipt,
          stage: 'GROUP_SCAN',
          group: await this.beginScan('group', current.progress.group, ctx)
        };
        await this.save(current.revision, next, ctx);
        return next;
      }
    );
  }

  async advance(
    pageSize: number,
    ctx: MembershipPrimaryContext
  ): Promise<MembershipBootstrapProgress> {
    return timeMembershipOperation(
      'MembershipBootstrapDb->advance',
      ctx,
      async () => {
        assertMembershipBoundedInteger(pageSize, 'bootstrap page size', 1, 64);
        const current = await this.requireControl(ctx);
        const progress = current.progress;
        let next: MembershipBootstrapProgress;
        switch (progress.stage) {
          case 'GLOBAL_READY':
            if (
              BigInt(await this.now(ctx)) <
              BigInt(progress.pretrack_not_before_millis)
            )
              return progress;
            next = {
              ...progress,
              stage: 'PRETRACK_PROFILE_SCAN',
              profile: await this.beginScan('profile', progress.profile, ctx)
            };
            break;
          case 'PRETRACK_PROFILE_SCAN':
          case 'POSTTRACK_PROFILE_SCAN':
            next = await this.profilePage(progress, pageSize, ctx);
            break;
          case 'GROUP_SCAN':
            next = await this.groupPage(progress, pageSize, ctx);
            break;
          case 'GROUP_SCAN_VERIFY':
            next = await this.verifyGroupSweep(progress, ctx);
            break;
          case 'VERIFY':
            next = await this.verify(progress, ctx);
            break;
          case 'WAITING_FOR_WRITERS':
          case 'COMPLETE':
            return progress;
        }
        await this.save(current.revision, next, ctx);
        return next;
      }
    );
  }

  async requireReady(
    ctx: MembershipPrimaryContext
  ): Promise<MembershipBootstrapProgress> {
    // COMPLETE is immutable. A read-only snapshot avoids serializing workers
    // and dispatcher ticks on the operator checkpoint row.
    const progress = (await this.read(false, ctx))?.progress;
    if (
      progress?.stage !== 'COMPLETE' ||
      !progress.tracked_writer_receipt ||
      !progress.baseline_source_versions ||
      !progress.completed_at_millis
    )
      throw new Error('Membership bootstrap is not complete');
    return progress;
  }

  private async read(
    lock: boolean,
    ctx: MembershipPrimaryContext
  ): Promise<{
    revision: string;
    progress: MembershipBootstrapProgress;
  } | null> {
    const row = await this.db.oneOrNull<CheckpointRow>(
      `SELECT protocol_version,CAST(revision AS CHAR) revision,progress
       FROM ${MEMBERSHIP_RUNTIME_CHECKPOINTS_TABLE} WHERE id=:id ${lock ? 'FOR UPDATE' : ''}`,
      { id: MEMBERSHIP_BOOTSTRAP_CHECKPOINT_ID },
      membershipQueryOptions(ctx)
    );
    if (!row) return null;
    if (row.protocol_version !== 1)
      throw new Error('Invalid membership bootstrap protocol');
    return {
      revision: normalizeCounter(row.revision),
      progress: validateProgress(row.progress)
    };
  }

  private async requireControl(ctx: MembershipPrimaryContext) {
    const control = await this.read(true, ctx);
    if (!control) throw new Error('Membership bootstrap is not prepared');
    return control;
  }

  private async now(ctx: MembershipPrimaryContext): Promise<string> {
    const row = await this.db.oneOrNull<{ now: string }>(
      `SELECT CAST(${MEMBERSHIP_DB_NOW} AS CHAR) now`,
      {},
      membershipQueryOptions(ctx)
    );
    return normalizeCounter(row?.now);
  }

  private async verifyGlobalReceipts(
    ctx: MembershipPrimaryContext
  ): Promise<void> {
    const rows = await this.db.execute<{
      dimension: MembershipSourceDimension;
      job_id: string;
      status: string;
      progress: unknown;
      started_version: string;
      completed_version: string | null;
    }>(
      `SELECT dimension,job_id,status,progress,
       CAST(started_version AS CHAR) started_version,
       CAST(completed_version AS CHAR) completed_version
       FROM ${MEMBERSHIP_SOURCE_JOBS_TABLE}
       WHERE scope='GLOBAL' AND target_id='*'
         AND (job_id LIKE 'bootstrap:%' OR job_id LIKE 'birth:%') FOR UPDATE`,
      {},
      membershipQueryOptions(ctx)
    );
    if (rows.length !== GLOBAL_DIMENSIONS.length)
      throw new Error('Membership GLOBAL bootstrap receipts are incomplete');
    const seen = new Set<MembershipSourceDimension>();
    for (const row of rows) {
      const progress = parseJson(row.progress) as {
        stage?: string;
        coverage_revision?: string;
      };
      if (
        !GLOBAL_DIMENSIONS.includes(row.dimension) ||
        seen.has(row.dimension) ||
        row.job_id !== `bootstrap:${MEMBERSHIP_BOOTSTRAP_ID}` ||
        row.status !== 'COMPLETED' ||
        normalizeCounter(row.started_version) !== '0' ||
        normalizeCounter(row.completed_version) !== '0' ||
        progress?.stage !== 'PROVISIONED' ||
        progress.coverage_revision !== MEMBERSHIP_BOOTSTRAP_COVERAGE_REVISION
      )
        throw new Error('Membership GLOBAL bootstrap receipt has old coverage');
      seen.add(row.dimension);
    }
  }

  private async save(
    revision: string,
    progress: MembershipBootstrapProgress,
    ctx: MembershipPrimaryContext
  ): Promise<void> {
    validateProgress(progress);
    await this.db.execute(
      `UPDATE ${MEMBERSHIP_RUNTIME_CHECKPOINTS_TABLE}
       SET revision=revision+1,progress=:progress,updated_at_millis=${MEMBERSHIP_DB_NOW}
       WHERE id=:id AND revision=:revision`,
      {
        id: MEMBERSHIP_BOOTSTRAP_CHECKPOINT_ID,
        revision,
        progress: JSON.stringify(progress)
      },
      membershipQueryOptions(ctx)
    );
  }

  private async sourceVersion(
    dimension: 'IDENTITY' | 'GROUP_CATALOG',
    lock: boolean,
    ctx: MembershipPrimaryContext
  ): Promise<string> {
    const [source] = await new MembershipSourceStatesDb(() => this.db).capture(
      [
        dimension === 'GROUP_CATALOG'
          ? MEMBERSHIP_CATALOG_KEY
          : GLOBAL_KEYS.find((key) => key.dimension === dimension)!
      ],
      lock,
      ctx
    );
    return source.version;
  }

  private async highBound(
    kind: 'profile' | 'group',
    ctx: MembershipPrimaryContext
  ): Promise<string | null> {
    const table = kind === 'profile' ? IDENTITIES_TABLE : USER_GROUPS_TABLE;
    const column = kind === 'profile' ? 'profile_id' : 'id';
    const where = kind === 'profile' ? 'WHERE profile_id IS NOT NULL' : '';
    const row = await this.db.oneOrNull<IdRow>(
      `SELECT ${column} id FROM ${table} ${where} ORDER BY ${column} DESC LIMIT 1`,
      {},
      membershipQueryOptions(ctx)
    );
    if (row)
      assertMembershipId(
        row.id,
        'bootstrap high bound',
        kind === 'profile' ? 50 : 200
      );
    return row?.id ?? null;
  }

  private async beginScan(
    kind: 'profile' | 'group',
    previous: MembershipBootstrapScan,
    ctx: MembershipPrimaryContext
  ): Promise<MembershipBootstrapScan> {
    // The source lock precedes the high-bound read. A tracked writer cannot
    // publish a version between those two observations.
    const sourceVersion = await this.sourceVersion(
      kind === 'profile' ? 'IDENTITY' : 'GROUP_CATALOG',
      true,
      ctx
    );
    return {
      ...previous,
      after_id: null,
      through_id: await this.highBound(kind, ctx),
      source_version: sourceVersion,
      sweeps: add(previous.sweeps, 1)
    };
  }

  private profileKey(row: ProfileSourceRow): string {
    return `${row.target_id}/${row.dimension}`;
  }

  private async profileStates(
    ids: readonly string[],
    ctx: MembershipPrimaryContext
  ): Promise<ProfileSourceRow[]> {
    if (!ids.length) return [];
    return this.db.execute<ProfileSourceRow>(
      `SELECT target_id,dimension FROM ${MEMBERSHIP_SOURCE_STATES_TABLE}
       WHERE scope='PROFILE' AND target_id IN (:ids) FOR UPDATE`,
      { ids },
      membershipQueryOptions(ctx)
    );
  }

  private async profileReceipts(
    ids: readonly string[],
    ctx: MembershipPrimaryContext
  ): Promise<Map<string, ProfileReceiptRow>> {
    if (!ids.length) return new Map();
    const rows = await this.db.execute<ProfileReceiptRow>(
      `SELECT target_id,dimension,job_id,progress,
       CAST(started_version AS CHAR) started_version,
       CAST(completed_version AS CHAR) completed_version,status
       FROM ${MEMBERSHIP_SOURCE_JOBS_TABLE}
       WHERE scope='PROFILE' AND target_id IN (:ids)
       AND (job_id LIKE 'bootstrap:%' OR job_id LIKE 'birth:%') FOR UPDATE`,
      { ids },
      membershipQueryOptions(ctx)
    );
    const receipts = new Map<string, ProfileReceiptRow>();
    for (const row of rows) {
      const key = this.profileKey(row);
      const progress = parseJson(row.progress) as {
        stage?: string;
        coverage_revision?: string;
      };
      if (
        receipts.has(key) ||
        ![
          `bootstrap:${MEMBERSHIP_BOOTSTRAP_ID}`,
          `birth:${MEMBERSHIP_BOOTSTRAP_ID}`
        ].includes(row.job_id) ||
        row.status !== 'COMPLETED' ||
        normalizeCounter(row.started_version) !== '0' ||
        normalizeCounter(row.completed_version) !== '0' ||
        progress?.stage !== 'PROVISIONED' ||
        progress.coverage_revision !== MEMBERSHIP_BOOTSTRAP_COVERAGE_REVISION
      )
        throw new Error('Membership profile has invalid provisioning evidence');
      receipts.set(key, row);
    }
    return receipts;
  }

  private async provisionProfilePage(
    ids: readonly string[],
    ctx: MembershipPrimaryContext
  ): Promise<number> {
    if (!ids.length) return 0;
    const keys = ids.flatMap((target_id) =>
      PROFILE_DIMENSIONS.map((dimension) => ({ target_id, dimension }))
    );
    const initialStates = new Set(
      (await this.profileStates(ids, ctx)).map((row) => this.profileKey(row))
    );
    const initialReceipts = await this.profileReceipts(ids, ctx);
    for (const key of Array.from(initialStates))
      if (!initialReceipts.has(key))
        throw new Error('Membership profile state has no audited receipt');
    for (const key of Array.from(initialReceipts.keys()))
      if (!initialStates.has(key))
        throw new Error('Membership profile receipt has no source state');
    const absent = keys.filter(
      (key) => !initialStates.has(this.profileKey(key))
    );
    if (!absent.length) return 0;
    const parameters: Record<string, string> = {};
    const values = absent.map((key, i) => {
      parameters[`target${i}`] = key.target_id;
      parameters[`dimension${i}`] = key.dimension;
      return `('PROFILE',:target${i},:dimension${i},0,0,${MEMBERSHIP_DB_NOW})`;
    });
    await this.db.execute(
      `INSERT IGNORE INTO ${MEMBERSHIP_SOURCE_STATES_TABLE}
       (scope,target_id,dimension,version,active_jobs,updated_at_millis)
       VALUES ${values.join(',')}`,
      parameters,
      membershipQueryOptions(ctx)
    );
    // A concurrent birth may have won one or more unique keys. Its committed
    // receipt is visible to this locking read; never add a second receipt.
    const afterReceipts = await this.profileReceipts(ids, ctx);
    const missing = absent.filter(
      (key) => !afterReceipts.has(this.profileKey(key))
    );
    if (!missing.length) return 0;
    const receiptParameters: Record<string, string> = {
      jobId: `bootstrap:${MEMBERSHIP_BOOTSTRAP_ID}`,
      progress: JSON.stringify({
        stage: 'PROVISIONED',
        after_id: null,
        coverage_revision: MEMBERSHIP_BOOTSTRAP_COVERAGE_REVISION
      })
    };
    const receiptValues = missing.map((key, i) => {
      receiptParameters[`target${i}`] = key.target_id;
      receiptParameters[`dimension${i}`] = key.dimension;
      return `('PROFILE',:target${i},:dimension${i},:jobId,'COMPLETED',:progress,0,0,${MEMBERSHIP_DB_NOW},${MEMBERSHIP_DB_NOW},NULL)`;
    });
    await this.db.execute(
      `INSERT INTO ${MEMBERSHIP_SOURCE_JOBS_TABLE}
       (scope,target_id,dimension,job_id,status,progress,started_version,
        completed_version,created_at_millis,updated_at_millis,last_error)
       VALUES ${receiptValues.join(',')}`,
      receiptParameters,
      membershipQueryOptions(ctx)
    );
    return missing.length;
  }

  async assertProfileEvidence(
    ids: readonly string[],
    ctx: MembershipPrimaryContext
  ): Promise<void> {
    const states = new Set(
      (await this.profileStates(ids, ctx)).map((row) => this.profileKey(row))
    );
    const receipts = await this.profileReceipts(ids, ctx);
    const expected = ids.length * PROFILE_DIMENSIONS.length;
    if (states.size !== expected || receipts.size !== expected)
      throw new Error('Membership born profile evidence is incomplete');
    for (const id of ids)
      for (const dimension of PROFILE_DIMENSIONS) {
        const key = this.profileKey({ target_id: id, dimension });
        if (!states.has(key) || !receipts.has(key))
          throw new Error('Membership born profile evidence is incomplete');
      }
  }

  private async pageIds(
    kind: 'profile' | 'group',
    scan: MembershipBootstrapScan,
    pageSize: number,
    ctx: MembershipPrimaryContext
  ): Promise<{ ids: string[]; done: boolean }> {
    if (scan.through_id === null) return { ids: [], done: true };
    const table = kind === 'profile' ? IDENTITIES_TABLE : USER_GROUPS_TABLE;
    const column = kind === 'profile' ? 'profile_id' : 'id';
    const pageSql = `SELECT ${column} id FROM ${table}
       WHERE ${column} IS NOT NULL ${scan.after_id === null ? '' : `AND ${column}>:after`}
         AND ${column}<=:through ORDER BY ${column} LIMIT :limit`;
    const rows = await this.db.execute<IdRow>(
      kind === 'profile'
        ? `SELECT p.id,COUNT(*) OVER(PARTITION BY p.id) occurrences
           FROM (${pageSql}) p ORDER BY p.id`
        : pageSql,
      { after: scan.after_id, through: scan.through_id, limit: pageSize + 1 },
      membershipQueryOptions(ctx)
    );
    const accepted = rows.slice(0, pageSize);
    for (const row of accepted)
      assertMembershipId(
        row.id,
        'bootstrap source ID',
        kind === 'profile' ? 50 : 200
      );
    if (
      kind === 'profile' &&
      rows.some((row) => normalizeCounter(row.occurrences) !== '1')
    )
      throw new Error('Duplicate canonical membership identity');
    return {
      ids: accepted.map((row) => row.id),
      done: rows.length <= pageSize
    };
  }

  private async profilePage(
    progress: MembershipBootstrapProgress,
    size: number,
    ctx: MembershipPrimaryContext
  ): Promise<MembershipBootstrapProgress> {
    const identityVersion = await this.sourceVersion('IDENTITY', false, ctx);
    if (
      progress.stage === 'POSTTRACK_PROFILE_SCAN' &&
      identityVersion !== progress.profile.source_version
    )
      return {
        ...progress,
        profile: await this.beginScan('profile', progress.profile, ctx)
      };
    const page = await this.pageIds('profile', progress.profile, size, ctx);
    const inserted = await this.provisionProfilePage(page.ids, ctx);
    const scan: MembershipBootstrapScan = {
      ...progress.profile,
      after_id: page.ids.at(-1) ?? progress.profile.after_id,
      scanned: add(progress.profile.scanned, page.ids.length),
      inserted: add(progress.profile.inserted, inserted)
    };
    if (!page.done) return { ...progress, profile: scan };
    if (progress.stage === 'PRETRACK_PROFILE_SCAN')
      return { ...progress, profile: scan, stage: 'WAITING_FOR_WRITERS' };
    return { ...progress, profile: scan, stage: 'VERIFY' };
  }

  private async groupPage(
    progress: MembershipBootstrapProgress,
    size: number,
    ctx: MembershipPrimaryContext
  ): Promise<MembershipBootstrapProgress> {
    const catalogueVersion = await this.sourceVersion(
      'GROUP_CATALOG',
      false,
      ctx
    );
    if (catalogueVersion !== progress.group.source_version)
      return {
        ...progress,
        group: await this.beginScan('group', progress.group, ctx)
      };
    const page = await this.pageIds('group', progress.group, size, ctx);
    let inserted = 0;
    if (page.ids.length) {
      await this.db.execute(
        `INSERT IGNORE INTO ${MEMBERSHIP_GROUP_VERSIONS_TABLE}
         (group_id,catalog_version,is_deleted,updated_at_millis)
         SELECT id,0,false,${MEMBERSHIP_DB_NOW} FROM ${USER_GROUPS_TABLE}
         WHERE id IN (:ids)`,
        { ids: page.ids },
        membershipQueryOptions(ctx)
      );
      const affected = await this.db.oneOrNull<{ count: number }>(
        'SELECT ROW_COUNT() count',
        {},
        membershipQueryOptions(ctx)
      );
      inserted = Number(affected?.count ?? -1);
      if (
        !Number.isSafeInteger(inserted) ||
        inserted < 0 ||
        inserted > page.ids.length
      )
        throw new Error('Invalid membership group baseline count');
    }
    const scan: MembershipBootstrapScan = {
      ...progress.group,
      after_id: page.ids.at(-1) ?? progress.group.after_id,
      scanned: add(progress.group.scanned, page.ids.length),
      inserted: add(progress.group.inserted, inserted)
    };
    if (!page.done) return { ...progress, group: scan };
    return { ...progress, group: scan, stage: 'GROUP_SCAN_VERIFY' };
  }

  private async verifyGroupSweep(
    progress: MembershipBootstrapProgress,
    ctx: MembershipPrimaryContext
  ): Promise<MembershipBootstrapProgress> {
    // This transaction holds no group-version row locks. Keep the GLOBAL lock
    // only for the current-read recheck and next high-bound capture.
    const catalogueVersion = await this.sourceVersion(
      'GROUP_CATALOG',
      true,
      ctx
    );
    if (catalogueVersion !== progress.group.source_version)
      return {
        ...progress,
        stage: 'GROUP_SCAN',
        group: await this.beginScan('group', progress.group, ctx)
      };
    return {
      ...progress,
      stage: 'POSTTRACK_PROFILE_SCAN',
      profile: await this.beginScan('profile', progress.profile, ctx)
    };
  }

  private async verify(
    progress: MembershipBootstrapProgress,
    ctx: MembershipPrimaryContext
  ): Promise<MembershipBootstrapProgress> {
    if (!progress.tracked_writer_receipt)
      throw new Error('Membership bootstrap has no tracked writer receipt');
    const sources = new MembershipSourceStatesDb(() => this.db);
    const captured = await sources.capture(GLOBAL_KEYS, true, ctx);
    const versions = Object.fromEntries(
      captured.map((source) => [source.dimension, source.version])
    ) as Record<MembershipSourceDimension, string>;
    if (versions.GROUP_CATALOG !== progress.group.source_version)
      return {
        ...progress,
        stage: 'GROUP_SCAN',
        group: await this.beginScan('group', progress.group, ctx)
      };
    if (versions.IDENTITY !== progress.profile.source_version)
      return {
        ...progress,
        stage: 'POSTTRACK_PROFILE_SCAN',
        profile: await this.beginScan('profile', progress.profile, ctx)
      };
    const clock = await this.db.oneOrNull<{ now: string }>(
      `SELECT CAST(${MEMBERSHIP_DB_NOW} AS CHAR) now`,
      {},
      membershipQueryOptions(ctx)
    );
    return {
      ...progress,
      stage: 'COMPLETE',
      baseline_source_versions: versions,
      completed_at_millis: normalizeCounter(clock?.now)
    };
  }
}

export async function requireMembershipBootstrapReady(
  ctx: MembershipPrimaryContext
): Promise<MembershipBootstrapProgress> {
  return new MembershipBootstrapDb(dbSupplier).requireReady(ctx);
}

/** Call only for IDs proven newly created in this caller-owned identity transaction. */
export async function provisionBornProfiles(
  profileIds: readonly string[],
  ctx: MembershipPrimaryContext
): Promise<void> {
  const bootstrap = new MembershipBootstrapDb(dbSupplier);
  if (!(await bootstrap.isPreparedCommitted())) return;
  const ids = Array.from(new Set(profileIds));
  if (ids.length > 64)
    throw new Error('Membership birth batch exceeds 64 profiles');
  const sources = new MembershipSourceStatesDb(dbSupplier);
  for (const id of ids) {
    assertMembershipId(id, 'born profile ID', 50);
    const keys = PROFILE_DIMENSIONS.map((dimension) => ({
      scope: 'PROFILE' as const,
      target_id: id,
      dimension
    }));
    await sources.provisionBorn(
      keys,
      {
        bootstrap_id: MEMBERSHIP_BOOTSTRAP_ID,
        coverage_revision: MEMBERSHIP_BOOTSTRAP_COVERAGE_REVISION
      },
      ctx
    );
  }
  await bootstrap.assertProfileEvidence(ids, ctx);
  await new MembershipRefreshTargetsDb(dbSupplier).request(
    ids.map((id) => ({
      scope: 'PROFILE',
      target_id: id,
      reason: 'profile-birth'
    })),
    ctx
  );
}
