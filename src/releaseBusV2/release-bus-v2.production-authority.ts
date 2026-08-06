import { randomUUID } from 'node:crypto';
import { canDeployServiceToEnvironment } from '@/api/deploy/deploy.config';
import {
  deriveReleaseBusV2LaneStates,
  getReleaseBusV2Mode,
  RELEASE_BUS_OPERATOR_TEAM,
  RELEASE_BUS_V2_PRODUCTION_AUTHORITY_CONTROLLER_IDENTITIES,
  RELEASE_BUS_V2_PRODUCTION_AUTHORITY_CONTROLLER_IDENTITIES_BY_REPOSITORY,
  RELEASE_BUS_V2_PRODUCTION_AUTHORITY_HARD_TTL_MS,
  RELEASE_BUS_V2_PRODUCTION_AUTHORITY_LEASE_TTL_MS,
  RELEASE_BUS_V2_PRODUCTION_AUTHORITY_LOCK_NAME,
  RELEASE_BUS_V2_PRODUCTION_AUTHORITY_UNBOUND_TTL_MS
} from '@/releaseBusV2/release-bus-v2.config';
import {
  releaseBusGitHubApp,
  type ReleaseBusWorkflowRunIdentity
} from '@/releaseBusV2/release-bus-v2.github-app';
import {
  releaseBusV2Repository,
  ReleaseBusV2Repository as ReleaseBusV2RepositoryStore,
  type ReleaseBusV2ControlRecord,
  type ReleaseBusV2LockRecord
} from '@/releaseBusV2/release-bus-v2.repository';
import type { RequestContext } from '@/request.context';
import type { ConnectionWrapper } from '@/sql-executor';
import type {
  ReleaseBusV2ControlEpoch,
  ReleaseBusV2Mode,
  ReleaseBusV2ProductionAuthorityBinding,
  ReleaseBusV2ProductionAuthorityCompletionInput,
  ReleaseBusV2ProductionAuthorityDenialCode,
  ReleaseBusV2ProductionAuthorityFailureCode,
  ReleaseBusV2ProductionAuthorityIdentity,
  ReleaseBusV2ProductionAuthorityReauthorizeInput,
  ReleaseBusV2ProductionAuthorityRecord,
  ReleaseBusV2ProductionAuthoritySelectionState,
  ReleaseBusV2ProductionAuthorityStatus,
  ReleaseBusV2ProductionAuthorityTerminalEvidence,
  ReleaseBusV2Lane,
  ReleaseBusV2Repository
} from '@/releaseBusV2/release-bus-v2.types';

type AuthorityRepository = Pick<
  ReleaseBusV2RepositoryStore,
  | 'executeNativeQueriesInTransaction'
  | 'findProductionAuthority'
  | 'findProductionAuthorityById'
  | 'createProductionAuthority'
  | 'updateProductionAuthority'
  | 'acquireLock'
  | 'renewLock'
  | 'releaseLock'
  | 'listControls'
  | 'listLocks'
  | 'listActiveTrains'
  | 'listNonterminalOperationsForLanes'
>;

type WorkflowRunIdentityReader = (
  repository: ReleaseBusV2Repository,
  workflowRunId: string
) => Promise<ReleaseBusWorkflowRunIdentity>;

export type ReleaseBusV2ProductionAuthorityDependencies = {
  readonly repository: AuthorityRepository;
  readonly getMode: () => ReleaseBusV2Mode;
  readonly listControls: (
    ctx: RequestContext,
    forUpdate?: boolean
  ) => Promise<readonly ReleaseBusV2ControlRecord[]>;
  readonly listLocks: (
    ctx: RequestContext,
    forUpdate?: boolean
  ) => Promise<readonly ReleaseBusV2LockRecord[]>;
  readonly listActiveTrains: (
    ctx: RequestContext,
    forUpdate?: boolean
  ) => Promise<readonly { readonly lane: string }[]>;
  readonly listNonterminalOperationsForLanes: (
    lanes: readonly ReleaseBusV2Lane[],
    ctx: RequestContext,
    forUpdate?: boolean
  ) => Promise<readonly unknown[]>;
  readonly getWorkflowRunIdentity: WorkflowRunIdentityReader;
  readonly isOrganizationOperator: (actor: string) => Promise<boolean>;
  readonly resolveRef: (
    repository: ReleaseBusV2Repository,
    ref: string
  ) => Promise<string>;
  readonly refContainsCommit: (
    repository: ReleaseBusV2Repository,
    ref: string,
    commitSha: string
  ) => Promise<boolean>;
  readonly hasActiveProductionMutationOrE2ERun: (
    repository: ReleaseBusV2Repository,
    ignoredRunIds: readonly string[]
  ) => Promise<boolean>;
  readonly now?: () => number;
};

const defaultDependencies: ReleaseBusV2ProductionAuthorityDependencies = {
  repository: releaseBusV2Repository,
  getMode: getReleaseBusV2Mode,
  listControls: (ctx, forUpdate = false) =>
    releaseBusV2Repository.listControls(ctx, forUpdate),
  listLocks: (ctx, forUpdate = false) =>
    releaseBusV2Repository.listLocks(ctx, forUpdate),
  listActiveTrains: (ctx, forUpdate = false) =>
    releaseBusV2Repository.listActiveTrains(ctx, forUpdate),
  listNonterminalOperationsForLanes: (lanes, ctx, forUpdate = false) =>
    releaseBusV2Repository.listNonterminalOperationsForLanes(
      lanes,
      ctx,
      forUpdate
    ),
  getWorkflowRunIdentity: (repository, workflowRunId) =>
    releaseBusGitHubApp.getWorkflowRunIdentity(repository, workflowRunId),
  isOrganizationOperator: (actor) =>
    releaseBusGitHubApp.isOrganizationOperator(
      actor,
      RELEASE_BUS_OPERATOR_TEAM
    ),
  resolveRef: (repository, ref) =>
    releaseBusGitHubApp.resolveRef(repository, ref),
  refContainsCommit: (repository, ref, commitSha) =>
    releaseBusGitHubApp.refContainsCommit(repository, ref, commitSha),
  hasActiveProductionMutationOrE2ERun: (repository, ignoredRunIds) =>
    releaseBusGitHubApp.hasActiveProductionMutationOrE2ERun(
      repository,
      ignoredRunIds
    )
};

export type ReleaseBusV2ProductionAuthorityPrepareInput =
  ReleaseBusV2ProductionAuthorityIdentity & { readonly selection_digest: null };
export type ReleaseBusV2ProductionAuthorityBindInput =
  ReleaseBusV2ProductionAuthorityPrepareInput &
    ReleaseBusV2ProductionAuthorityBinding;
export type ReleaseBusV2ProductionAuthorityFailureInput = Omit<
  ReleaseBusV2ProductionAuthorityReauthorizeInput,
  'selection_digest'
> & {
  readonly selection_digest: string | null;
  readonly reason_code: ReleaseBusV2ProductionAuthorityFailureCode;
} & ReleaseBusV2ProductionAuthorityTerminalEvidence;
export type ReleaseBusV2ProductionAuthorityCompleteInput =
  ReleaseBusV2ProductionAuthorityCompletionInput;

type ReleaseBusV2ProductionAuthorityWorkflowInput =
  ReleaseBusV2ProductionAuthorityIdentity &
    ReleaseBusV2ProductionAuthorityBinding;

type ReleaseBusV2ProductionAuthorityIdentityInput =
  ReleaseBusV2ProductionAuthorityIdentity &
    ReleaseBusV2ProductionAuthoritySelectionState;

type AuthorityResponseIdentity = {
  readonly operation_id: string;
  readonly controller_identity: string;
  readonly repository: ReleaseBusV2Repository;
  readonly environment: 'prod';
  readonly service: string;
  readonly target_sha: string;
  readonly selection_digest: string | null;
  readonly workflow_run_id: string | null;
  readonly workflow_run_attempt: number | null;
  readonly status: ReleaseBusV2ProductionAuthorityStatus;
  readonly lease_expires_at: number | null;
  readonly hard_expires_at: number | null;
  readonly control_epoch: ReleaseBusV2ControlEpoch;
  readonly lock_row_version: number | null;
};

export type ReleaseBusV2ProductionAuthorityPrepareResponse =
  AuthorityResponseIdentity & {
    readonly prepared: boolean;
    readonly authorized: boolean;
    readonly reused: boolean;
    readonly reason_code?: ReleaseBusV2ProductionAuthorityDenialCode;
    readonly observed_epoch?: ReleaseBusV2ControlEpoch;
  };

export type ReleaseBusV2ProductionAuthorityBindResponse =
  AuthorityResponseIdentity & {
    readonly bound: boolean;
    readonly authorized: boolean;
    readonly reused: boolean;
    readonly reason_code?: ReleaseBusV2ProductionAuthorityDenialCode;
    readonly observed_epoch?: ReleaseBusV2ControlEpoch;
  };

export type ReleaseBusV2ProductionAuthorityCompletionResponse = {
  readonly operation_id: string;
  readonly status: 'COMPLETED' | 'FAILED' | 'DENIED' | 'EXPIRED';
  readonly completed?: boolean;
  readonly failed?: boolean;
  readonly reused: boolean;
  readonly lock_row_version: number | null;
  readonly reason_code?: ReleaseBusV2ProductionAuthorityDenialCode;
  readonly observed_epoch?: ReleaseBusV2ControlEpoch;
};

export class ReleaseBusV2ProductionAuthorityError extends Error {
  public constructor(
    public readonly code: 'CONFLICT' | 'UNAVAILABLE',
    message: string,
    public readonly reason_code: ReleaseBusV2ProductionAuthorityDenialCode,
    public readonly observed_epoch: ReleaseBusV2ControlEpoch | null = null
  ) {
    super(message);
    this.name = 'ReleaseBusV2ProductionAuthorityError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export function isReleaseBusV2ProductionAuthorityError(
  error: unknown
): error is ReleaseBusV2ProductionAuthorityError {
  const code =
    error instanceof Error
      ? (error as Error & { readonly code?: unknown }).code
      : undefined;
  return (
    error instanceof ReleaseBusV2ProductionAuthorityError ||
    (error instanceof Error &&
      error.name === 'ReleaseBusV2ProductionAuthorityError' &&
      typeof code === 'string' &&
      ['CONFLICT', 'UNAVAILABLE'].includes(code))
  );
}

type ControlSnapshot = {
  readonly epoch: ReleaseBusV2ControlEpoch;
  readonly laneStatus: 'ON' | 'OFF';
  readonly changeable: boolean;
};

type DatabaseDrain = {
  readonly locks: readonly ReleaseBusV2LockRecord[];
  readonly activeTrains: readonly { readonly lane: string }[];
  readonly activeOperations: readonly unknown[];
};

type Preflight = {
  readonly epoch: ReleaseBusV2ControlEpoch;
  readonly denial: ReleaseBusV2ProductionAuthorityDenialCode | null;
};

type CompletionEvidence = Pick<
  ReleaseBusV2ProductionAuthorityTerminalEvidence,
  | 'qualifier_workflow_run_id'
  | 'qualifier_workflow_run_attempt'
  | 'evidence_digest'
>;

const PRODUCTION_LANES = ['PRODUCTION'] as const;
const MAIN_REF = 'main';
const FRONTEND_HEAD_REPOSITORY = '6529-Collections/6529seize-frontend';
const BACKEND_HEAD_REPOSITORY = '6529-Collections/6529seize-backend';
const SHA_PATTERN = /^[a-f0-9]{40}$/;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const OPERATION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,179}$/;
const CONTROLLER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const CONTROLLER_IDENTITIES = new Set<string>(
  RELEASE_BUS_V2_PRODUCTION_AUTHORITY_CONTROLLER_IDENTITIES
);
const FAILED_WORKFLOW_CONCLUSIONS = new Set([
  'failure',
  'cancelled',
  'timed_out',
  'action_required',
  'startup_failure',
  'stale'
]);

function epochFromControls(
  mode: ReleaseBusV2Mode,
  controls: readonly ReleaseBusV2ControlRecord[]
): ReleaseBusV2ControlEpoch {
  const all = controls.find((control) => control.scope === 'ALL');
  const production = controls.find((control) => control.scope === 'PRODUCTION');
  if (
    !all ||
    !production ||
    !Number.isInteger(all.row_version) ||
    !Number.isInteger(production.row_version) ||
    all.row_version < 1 ||
    production.row_version < 1
  )
    throw new Error('Release Bus v2 production control epoch is unavailable');
  return {
    all: all.row_version,
    production: production.row_version,
    mode
  };
}

function sameEpoch(
  left: ReleaseBusV2ControlEpoch,
  right: ReleaseBusV2ControlEpoch
): boolean {
  return (
    left.all === right.all &&
    left.production === right.production &&
    left.mode === right.mode
  );
}

function authorityOwner(id: string): string {
  return `release-bus-authority:${id}`;
}

function lockIsActive(lock: ReleaseBusV2LockRecord, now: number): boolean {
  const hasOwner =
    lock.owner_train_id !== null ||
    lock.lease_owner !== null ||
    lock.lease_token !== null;
  return hasOwner && (lock.expires_at === null || lock.expires_at >= now);
}

function isTerminal(status: ReleaseBusV2ProductionAuthorityStatus): boolean {
  return ['COMPLETED', 'FAILED', 'DENIED', 'EXPIRED'].includes(status);
}

function identityMatchesRecord(
  record: ReleaseBusV2ProductionAuthorityRecord,
  input: ReleaseBusV2ProductionAuthorityIdentity
): boolean {
  return (
    record.operation_id === input.operation_id &&
    record.controller_identity === input.controller_identity &&
    record.repository === input.repository &&
    record.environment === input.environment &&
    record.service === input.service &&
    record.target_sha === input.target_sha
  );
}

function bindingMatchesRecord(
  record: ReleaseBusV2ProductionAuthorityRecord,
  input: ReleaseBusV2ProductionAuthorityBinding
): boolean {
  return (
    record.workflow_run_id === input.workflow_run_id &&
    record.workflow_run_attempt === input.workflow_run_attempt
  );
}

function responseIdentity(
  record: ReleaseBusV2ProductionAuthorityRecord
): AuthorityResponseIdentity {
  return {
    operation_id: record.operation_id,
    controller_identity: record.controller_identity,
    repository: record.repository,
    environment: record.environment,
    service: record.service,
    target_sha: record.target_sha,
    selection_digest: record.selection_digest,
    workflow_run_id: record.workflow_run_id,
    workflow_run_attempt: record.workflow_run_attempt,
    status: record.status,
    lease_expires_at: record.lease_expires_at,
    hard_expires_at: record.hard_expires_at,
    control_epoch: {
      all: record.control_epoch_all,
      production: record.control_epoch_production,
      mode: record.control_mode
    },
    lock_row_version: record.lock_row_version
  };
}

function observedEpoch(
  record: ReleaseBusV2ProductionAuthorityRecord
): ReleaseBusV2ControlEpoch {
  return {
    all: record.denial_observed_all_epoch ?? record.control_epoch_all,
    production:
      record.denial_observed_production_epoch ??
      record.control_epoch_production,
    mode: record.denial_observed_mode ?? record.control_mode
  };
}

export class ReleaseBusV2ProductionAuthorityService {
  public constructor(
    private readonly deps: ReleaseBusV2ProductionAuthorityDependencies = defaultDependencies
  ) {}

  public async prepare(
    input: ReleaseBusV2ProductionAuthorityPrepareInput
  ): Promise<ReleaseBusV2ProductionAuthorityPrepareResponse> {
    this.assertIdentityInput(input);
    this.assertUnselectedInput(input);
    const existing = await this.deps.repository.findProductionAuthority(
      input.operation_id,
      {},
      false,
      true
    );
    if (existing) {
      this.assertRecordIdentity(existing, input);
      if (
        (existing.status === 'PREPARED' || existing.status === 'BOUND') &&
        this.expired(existing)
      ) {
        const expired = await this.expire(existing, 'LEASE_EXPIRED');
        return this.prepareResponse(expired, true);
      }
      return this.prepareResponse(existing, true);
    }

    const preflight = await this.preflight(input, null);
    if (preflight.denial)
      return this.prepareResponse(
        await this.createDenied(input, preflight.epoch, preflight.denial),
        false
      );
    const id = randomUUID();
    const owner = authorityOwner(id);
    const created =
      await this.deps.repository.executeNativeQueriesInTransaction(
        async (connection: ConnectionWrapper<unknown>) => {
          const ctx: RequestContext = { connection };
          const race = await this.deps.repository.findProductionAuthority(
            input.operation_id,
            ctx,
            true
          );
          if (race) {
            this.assertRecordIdentity(race, input);
            return race;
          }
          const current = await this.controlSnapshot(ctx, true);
          if (!sameEpoch(preflight.epoch, current.epoch))
            return this.createDeniedInTransaction(
              input,
              current.epoch,
              'CONTROL_EPOCH_CHANGED',
              ctx
            );
          const drain = await this.databaseDrain(ctx, true);
          const denial = this.databaseDenial(drain, this.now(), null);
          if (denial)
            return this.createDeniedInTransaction(
              input,
              current.epoch,
              denial,
              ctx
            );
          const lock = this.productionLock(drain.locks);
          if (!lock)
            throw new ReleaseBusV2ProductionAuthorityError(
              'UNAVAILABLE',
              'Production authority lock is unavailable',
              'AUTHORITY_UNAVAILABLE',
              current.epoch
            );
          if (lockIsActive(lock, this.now()))
            return this.createDeniedInTransaction(
              input,
              current.epoch,
              'ENVIRONMENT_LOCK_HELD',
              ctx
            );
          const lease = await this.deps.repository.acquireLock(
            RELEASE_BUS_V2_PRODUCTION_AUTHORITY_LOCK_NAME,
            null,
            owner,
            RELEASE_BUS_V2_PRODUCTION_AUTHORITY_UNBOUND_TTL_MS,
            ctx
          );
          if (!lease?.lease_token || lease.expires_at === null)
            return this.createDeniedInTransaction(
              input,
              current.epoch,
              'ENVIRONMENT_LOCK_HELD',
              ctx
            );
          const now = this.now();
          return this.deps.repository.createProductionAuthority(
            this.insertRecord(input, current.epoch, {
              id,
              status: 'PREPARED',
              lease_owner: owner,
              lease_token: lease.lease_token,
              lease_expires_at: lease.expires_at,
              hard_expires_at:
                now + RELEASE_BUS_V2_PRODUCTION_AUTHORITY_HARD_TTL_MS,
              lock_row_version: lease.row_version
            }),
            ctx
          );
        }
      );
    return this.prepareResponse(created, false);
  }

  /**
   * GitHub's first job uses this entry point.  The run is verified before its
   * id is ever supplied to the active-workflow fence, and the lock plus the
   * BOUND authority row are acquired in one database transaction.
   */
  public async prepareAndBind(
    input: ReleaseBusV2ProductionAuthorityBindInput
  ): Promise<ReleaseBusV2ProductionAuthorityBindResponse> {
    this.assertIdentityInput(input);
    this.assertUnselectedInput(input);
    await this.verifyWorkflowBinding(input);
    const existing = await this.deps.repository.findProductionAuthority(
      input.operation_id,
      {},
      false,
      true
    );
    if (existing) this.assertRecordIdentity(existing, input);
    if (existing?.status === 'BOUND') {
      this.assertBoundInput(existing, input);
      if (this.expired(existing))
        return this.bindResponse(
          await this.expire(existing, 'LEASE_EXPIRED'),
          false
        );
      return this.bindResponse(existing, true);
    }
    if (existing && isTerminal(existing.status))
      return this.bindResponse(existing, true);

    const preflight = await this.preflight(input, existing, input);
    if (preflight.denial) {
      const denied = existing
        ? await this.denyExisting(existing, preflight.epoch, preflight.denial)
        : await this.createDenied(input, preflight.epoch, preflight.denial);
      return this.bindResponse(denied, false);
    }
    // Re-read immediately before entering the transaction.  The caller's run
    // id is never an ignore token until this second identity check succeeds.
    await this.verifyWorkflowBinding(input);
    const id = randomUUID();
    const owner = authorityOwner(id);
    const bound = await this.deps.repository.executeNativeQueriesInTransaction(
      (connection: ConnectionWrapper<unknown>) =>
        this.acquireBoundInTransaction(
          input,
          preflight.epoch,
          id,
          owner,
          connection
        )
    );
    return this.bindResponse(bound, false);
  }

  public async bind(
    input: ReleaseBusV2ProductionAuthorityBindInput
  ): Promise<ReleaseBusV2ProductionAuthorityBindResponse> {
    this.assertIdentityInput(input);
    this.assertUnselectedInput(input);
    const prepared = await this.requireRecord(input);
    this.assertRecordIdentity(prepared, input);
    if (prepared.status === 'BOUND') {
      this.assertBoundInput(prepared, input);
      await this.verifyWorkflowBinding(input);
      if (this.expired(prepared))
        return this.bindResponse(
          await this.expire(prepared, 'LEASE_EXPIRED'),
          false
        );
      return this.bindResponse(prepared, true);
    }
    if (isTerminal(prepared.status)) return this.bindResponse(prepared, true);
    if (prepared.status !== 'PREPARED')
      throw this.conflict(
        'Production authority is not prepared for GitHub binding',
        'AUTHORITY_NOT_BOUND'
      );
    await this.verifyWorkflowBinding(input);
    const preflight = await this.preflight(input, prepared, input);
    if (preflight.denial)
      return this.bindResponse(
        await this.denyExisting(prepared, preflight.epoch, preflight.denial),
        false
      );
    await this.verifyWorkflowBinding(input);
    const bound = await this.deps.repository.executeNativeQueriesInTransaction(
      async (connection: ConnectionWrapper<unknown>) => {
        const ctx: RequestContext = { connection };
        const current = await this.requireRecord(input, ctx, true);
        this.assertRecordIdentity(current, input);
        if (current.status === 'BOUND') {
          this.assertBoundInput(current, input);
          return current;
        }
        if (current.status !== 'PREPARED') return current;
        const controls = await this.controlSnapshot(ctx, true);
        if (!sameEpoch(preflight.epoch, controls.epoch))
          return this.denyExistingInTransaction(
            current,
            controls.epoch,
            'CONTROL_EPOCH_CHANGED',
            ctx
          );
        const drain = await this.databaseDrain(ctx, true);
        const denial = this.databaseDenial(drain, this.now(), current);
        if (denial)
          return this.denyExistingInTransaction(
            current,
            controls.epoch,
            denial,
            ctx
          );
        return this.bindInTransaction(current, input, controls.epoch, ctx);
      }
    );
    return this.bindResponse(bound, false);
  }

  public async reauthorize(
    input: ReleaseBusV2ProductionAuthorityReauthorizeInput
  ): Promise<ReleaseBusV2ProductionAuthorityBindResponse> {
    this.assertIdentityInput(input);
    this.assertSelectionDigest(input);
    const current = await this.requireRecord(input);
    this.assertRecordIdentity(current, input);
    this.assertBoundInput(current, input);
    if (
      current.status === 'BOUND' &&
      current.hard_expires_at !== null &&
      this.now() >= current.hard_expires_at
    )
      return this.bindResponse(
        await this.expire(current, 'HARD_TTL_EXPIRED'),
        false
      );
    if (current.status === 'BOUND' && this.expired(current))
      return this.bindResponse(
        await this.expire(current, 'LEASE_EXPIRED'),
        false
      );
    if (isTerminal(current.status)) return this.bindResponse(current, true);
    await this.verifyWorkflowBinding(input);
    const preflight = await this.preflight(input, current, input);
    if (preflight.denial)
      return this.bindResponse(
        await this.denyExisting(current, preflight.epoch, preflight.denial),
        false
      );
    await this.verifyWorkflowBinding(input);
    const renewed =
      await this.deps.repository.executeNativeQueriesInTransaction(
        async (connection: ConnectionWrapper<unknown>) => {
          const ctx: RequestContext = { connection };
          const locked = await this.requireRecord(input, ctx, true);
          this.assertRecordIdentity(locked, input);
          this.assertBoundInput(locked, input);
          this.assertPersistedSelection(locked, input.selection_digest);
          if (locked.status !== 'BOUND') return locked;
          const controls = await this.controlSnapshot(ctx, true);
          if (!sameEpoch(preflight.epoch, controls.epoch))
            return this.denyExistingInTransaction(
              locked,
              controls.epoch,
              'CONTROL_EPOCH_CHANGED',
              ctx
            );
          const drain = await this.databaseDrain(ctx, true);
          const denial = this.databaseDenial(drain, this.now(), locked);
          if (denial)
            return this.denyExistingInTransaction(
              locked,
              controls.epoch,
              denial,
              ctx
            );
          return this.renewBoundInTransaction(
            locked,
            controls.epoch,
            ctx,
            input.selection_digest
          );
        }
      );
    return this.bindResponse(renewed, false);
  }

  public async complete(
    input: ReleaseBusV2ProductionAuthorityCompleteInput
  ): Promise<ReleaseBusV2ProductionAuthorityCompletionResponse> {
    this.assertCompletionInput(input);
    const current = await this.requireRecord(input);
    this.assertRecordIdentity(current, input);
    this.assertBoundInput(current, input);
    this.assertCompletedSelection(current, input.selection_digest);
    if (current.workflow_run_id === null)
      throw this.conflict(
        'Production authority is not bound to a deployment workflow run',
        'AUTHORITY_NOT_BOUND'
      );
    await this.verifyCompletedDeploymentBinding(input);
    const qualifierIdentity = await this.qualifierWorkflowIdentity(
      input,
      current.repository
    );
    if (current.repository === 'frontend') {
      this.assertProductionE2EIdentity(
        qualifierIdentity,
        input,
        current.workflow_run_id
      );
    } else {
      if (current.workflow_run_attempt === null)
        throw this.conflict(
          'Production authority is missing its deployment attempt',
          'AUTHORITY_NOT_BOUND'
        );
      this.assertBackendDeploymentCompletionIdentity(
        qualifierIdentity,
        input,
        current.workflow_run_id,
        current.workflow_run_attempt
      );
    }
    return this.finish(input, 'COMPLETED', undefined, input);
  }

  public async fail(
    input: ReleaseBusV2ProductionAuthorityFailureInput
  ): Promise<ReleaseBusV2ProductionAuthorityCompletionResponse> {
    this.assertFailureInput(input);
    const current = await this.requireRecord(input);
    this.assertRecordIdentity(current, input);
    this.assertBoundInput(current, input);
    await this.verifyFailureEvidence(input, current);
    return this.finish(input, 'FAILED', input.reason_code, input);
  }

  private async finish(
    input:
      | ReleaseBusV2ProductionAuthorityReauthorizeInput
      | ReleaseBusV2ProductionAuthorityFailureInput,
    status: 'COMPLETED' | 'FAILED',
    failureCode:
      | ReleaseBusV2ProductionAuthorityFailureCode
      | undefined = undefined,
    completionEvidence: CompletionEvidence | undefined = undefined
  ): Promise<ReleaseBusV2ProductionAuthorityCompletionResponse> {
    this.assertIdentityInput(input);
    const current = await this.requireRecord(input);
    this.assertRecordIdentity(current, input);
    this.assertBoundInput(current, input);
    if (status === 'COMPLETED') {
      this.assertSelectionDigest(input);
      this.assertCompletedSelection(current, input.selection_digest);
    } else {
      this.assertFailureSelection(current, input.selection_digest);
    }
    if (completionEvidence)
      this.assertPersistedCompletion(current, completionEvidence);
    if (current.status === status)
      return this.completionResponse(current, status, true);
    if (isTerminal(current.status))
      return this.completionResponse(current, status, false);
    const completed =
      await this.deps.repository.executeNativeQueriesInTransaction(
        async (connection: ConnectionWrapper<unknown>) => {
          const ctx: RequestContext = { connection };
          const locked = await this.requireRecord(input, ctx, true);
          this.assertRecordIdentity(locked, input);
          this.assertBoundInput(locked, input);
          if (status === 'COMPLETED') {
            this.assertSelectionDigest(input);
            this.assertCompletedSelection(locked, input.selection_digest);
          } else {
            this.assertFailureSelection(locked, input.selection_digest);
          }
          if (completionEvidence)
            this.assertPersistedCompletion(locked, completionEvidence);
          if (locked.status === status) return locked;
          if (isTerminal(locked.status)) return locked;
          if (locked.status !== 'BOUND')
            return this.expireInTransaction(locked, 'AUTHORITY_NOT_BOUND', ctx);
          if (status === 'COMPLETED') {
            const controls = await this.controlSnapshot(ctx, true);
            const boundEpoch: ReleaseBusV2ControlEpoch = {
              all: locked.control_epoch_all,
              production: locked.control_epoch_production,
              mode: locked.control_mode
            };
            if (!sameEpoch(boundEpoch, controls.epoch))
              return this.denyExistingInTransaction(
                locked,
                controls.epoch,
                'CONTROL_EPOCH_CHANGED',
                ctx
              );
          }
          if (this.expired(locked))
            return this.expireInTransaction(locked, 'LEASE_EXPIRED', ctx);
          const lock = this.productionLock(
            await this.deps.repository.listLocks(ctx, true)
          );
          if (!this.ownsLock(locked, lock))
            return this.expireInTransaction(locked, 'LEASE_LOST', ctx);
          if (!locked.lease_token || !locked.lease_owner)
            return this.expireInTransaction(locked, 'LEASE_LOST', ctx);
          if (
            !(await this.deps.repository.releaseLock(
              RELEASE_BUS_V2_PRODUCTION_AUTHORITY_LOCK_NAME,
              locked.lease_token,
              ctx
            ))
          )
            return this.expireInTransaction(locked, 'LEASE_LOST', ctx);
          const releasedLock = this.productionLock(
            await this.deps.repository.listLocks(ctx, true)
          );
          const updated = await this.deps.repository.updateProductionAuthority(
            locked.id,
            locked.row_version,
            {
              status,
              lease_owner: null,
              lease_token: null,
              lease_expires_at: null,
              lock_row_version: releasedLock?.row_version ?? null,
              completed_at: this.now(),
              ...(completionEvidence
                ? {
                    qualifier_workflow_run_id:
                      completionEvidence.qualifier_workflow_run_id,
                    qualifier_workflow_run_attempt:
                      completionEvidence.qualifier_workflow_run_attempt,
                    evidence_digest: completionEvidence.evidence_digest
                  }
                : {}),
              failure_code: failureCode ?? null
            },
            ctx
          );
          if (!updated)
            throw new Error('Production authority completion raced');
          const result = await this.requireRecord(input, ctx, true);
          return result;
        }
      );
    return this.completionResponse(
      completed,
      status,
      completed.status === status
    );
  }

  private async acquireBoundInTransaction(
    input: ReleaseBusV2ProductionAuthorityBindInput,
    preflightEpoch: ReleaseBusV2ControlEpoch,
    id: string,
    owner: string,
    connection: ConnectionWrapper<unknown>
  ): Promise<ReleaseBusV2ProductionAuthorityRecord> {
    const ctx: RequestContext = { connection };
    const race = await this.deps.repository.findProductionAuthority(
      input.operation_id,
      ctx,
      true
    );
    const raceResolution = await this.resolveAcquireRace(
      race,
      input,
      preflightEpoch,
      ctx
    );
    if (raceResolution) return raceResolution;

    const controls = await this.controlSnapshot(ctx, true);
    if (!sameEpoch(preflightEpoch, controls.epoch))
      return this.denyRaceOrCreateInTransaction(
        race,
        input,
        controls.epoch,
        'CONTROL_EPOCH_CHANGED',
        ctx
      );

    const drain = await this.databaseDrain(ctx, true);
    const denial = this.databaseDenial(drain, this.now(), race);
    if (denial)
      return this.denyRaceOrCreateInTransaction(
        race,
        input,
        controls.epoch,
        denial,
        ctx
      );
    if (race) return this.bindInTransaction(race, input, controls.epoch, ctx);
    return this.createBoundInTransaction(
      input,
      controls.epoch,
      drain,
      id,
      owner,
      ctx
    );
  }

  private async resolveAcquireRace(
    race: ReleaseBusV2ProductionAuthorityRecord | null,
    input: ReleaseBusV2ProductionAuthorityBindInput,
    epoch: ReleaseBusV2ControlEpoch,
    ctx: RequestContext
  ): Promise<ReleaseBusV2ProductionAuthorityRecord | null> {
    if (!race) return null;
    this.assertRecordIdentity(race, input);
    if (race.status === 'BOUND') {
      this.assertBoundInput(race, input);
      return this.expired(race)
        ? this.expireInTransaction(race, 'LEASE_EXPIRED', ctx)
        : race;
    }
    if (isTerminal(race.status)) return race;
    if (race.status === 'PREPARED') return null;
    return this.denyExistingInTransaction(
      race,
      epoch,
      'AUTHORITY_NOT_BOUND',
      ctx
    );
  }

  private denyRaceOrCreateInTransaction(
    race: ReleaseBusV2ProductionAuthorityRecord | null,
    input: ReleaseBusV2ProductionAuthorityBindInput,
    epoch: ReleaseBusV2ControlEpoch,
    denial: ReleaseBusV2ProductionAuthorityDenialCode,
    ctx: RequestContext
  ): Promise<ReleaseBusV2ProductionAuthorityRecord> {
    return race
      ? this.denyExistingInTransaction(race, epoch, denial, ctx)
      : this.createDeniedInTransaction(input, epoch, denial, ctx);
  }

  private async createBoundInTransaction(
    input: ReleaseBusV2ProductionAuthorityBindInput,
    epoch: ReleaseBusV2ControlEpoch,
    drain: DatabaseDrain,
    id: string,
    owner: string,
    ctx: RequestContext
  ): Promise<ReleaseBusV2ProductionAuthorityRecord> {
    const lock = this.productionLock(drain.locks);
    if (!lock)
      throw new ReleaseBusV2ProductionAuthorityError(
        'UNAVAILABLE',
        'Production authority lock is unavailable',
        'AUTHORITY_UNAVAILABLE',
        epoch
      );
    if (lockIsActive(lock, this.now()))
      return this.createDeniedInTransaction(
        input,
        epoch,
        'ENVIRONMENT_LOCK_HELD',
        ctx
      );
    const lease = await this.deps.repository.acquireLock(
      RELEASE_BUS_V2_PRODUCTION_AUTHORITY_LOCK_NAME,
      null,
      owner,
      RELEASE_BUS_V2_PRODUCTION_AUTHORITY_LEASE_TTL_MS,
      ctx
    );
    if (!lease?.lease_token || lease.expires_at === null)
      return this.createDeniedInTransaction(
        input,
        epoch,
        'ENVIRONMENT_LOCK_HELD',
        ctx
      );
    return this.deps.repository.createProductionAuthority(
      this.insertRecord(
        input,
        epoch,
        {
          id,
          status: 'BOUND',
          lease_owner: owner,
          lease_token: lease.lease_token,
          lease_expires_at: lease.expires_at,
          hard_expires_at:
            this.now() + RELEASE_BUS_V2_PRODUCTION_AUTHORITY_HARD_TTL_MS,
          lock_row_version: lease.row_version
        },
        input
      ),
      ctx
    );
  }

  private async bindInTransaction(
    current: ReleaseBusV2ProductionAuthorityRecord,
    input: ReleaseBusV2ProductionAuthorityBindInput,
    epoch: ReleaseBusV2ControlEpoch,
    ctx: RequestContext
  ): Promise<ReleaseBusV2ProductionAuthorityRecord> {
    if (this.expired(current))
      return this.expireInTransaction(current, 'LEASE_EXPIRED', ctx);
    const renewed = await this.renewLockInTransaction(current, ctx);
    if (!renewed) return this.expireInTransaction(current, 'LEASE_LOST', ctx);
    const updated = await this.deps.repository.updateProductionAuthority(
      current.id,
      current.row_version,
      {
        status: 'BOUND',
        workflow_run_id: input.workflow_run_id,
        workflow_run_attempt: input.workflow_run_attempt,
        lease_expires_at: renewed.expires_at,
        lock_row_version: renewed.row_version,
        control_epoch_all: epoch.all,
        control_epoch_production: epoch.production,
        control_mode: epoch.mode
      },
      ctx
    );
    if (!updated) throw new Error('Production authority bind raced');
    return this.requireRecord(input, ctx, true);
  }

  private async renewBoundInTransaction(
    current: ReleaseBusV2ProductionAuthorityRecord,
    epoch: ReleaseBusV2ControlEpoch,
    ctx: RequestContext,
    selectionDigest?: string
  ): Promise<ReleaseBusV2ProductionAuthorityRecord> {
    if (this.now() >= (current.hard_expires_at ?? 0))
      return this.expireInTransaction(current, 'HARD_TTL_EXPIRED', ctx);
    if (this.expired(current))
      return this.expireInTransaction(current, 'LEASE_EXPIRED', ctx);
    const renewed = await this.renewLockInTransaction(current, ctx);
    if (!renewed) return this.expireInTransaction(current, 'LEASE_LOST', ctx);
    const updated = await this.deps.repository.updateProductionAuthority(
      current.id,
      current.row_version,
      {
        lease_expires_at: renewed.expires_at,
        lock_row_version: renewed.row_version,
        control_epoch_all: epoch.all,
        control_epoch_production: epoch.production,
        control_mode: epoch.mode,
        ...(selectionDigest === undefined
          ? {}
          : { selection_digest: selectionDigest })
      },
      ctx
    );
    if (!updated) throw new Error('Production authority renewal raced');
    return this.requireRecordById(current.id, ctx, true);
  }

  private async renewLockInTransaction(
    current: ReleaseBusV2ProductionAuthorityRecord,
    ctx: RequestContext
  ): Promise<ReleaseBusV2LockRecord | null> {
    if (!current.lease_owner || !current.lease_token) return null;
    const hardExpiry = current.hard_expires_at ?? 0;
    const expiresAt = Math.min(
      this.now() + RELEASE_BUS_V2_PRODUCTION_AUTHORITY_LEASE_TTL_MS,
      hardExpiry
    );
    if (expiresAt <= this.now()) return null;
    const lock = this.productionLock(
      await this.deps.repository.listLocks(ctx, true)
    );
    if (!this.ownsLock(current, lock)) return null;
    return this.deps.repository.renewLock(
      RELEASE_BUS_V2_PRODUCTION_AUTHORITY_LOCK_NAME,
      current.lease_owner,
      current.lease_token,
      expiresAt,
      this.now(),
      ctx
    );
  }

  private async preflight(
    input: ReleaseBusV2ProductionAuthorityIdentity,
    current: ReleaseBusV2ProductionAuthorityRecord | null,
    verifiedBinding: ReleaseBusV2ProductionAuthorityBinding | null = null
  ): Promise<Preflight> {
    const controls = await this.controlSnapshot({});
    if (controls.laneStatus === 'ON')
      return { epoch: controls.epoch, denial: 'LANE_ON' };
    if (!controls.changeable)
      return { epoch: controls.epoch, denial: 'LANE_NOT_CHANGEABLE' };
    try {
      await this.assertProtectedMainHistory(input);
    } catch (error) {
      if (
        error instanceof ReleaseBusV2ProductionAuthorityError &&
        error.code === 'CONFLICT' &&
        error.reason_code === 'TARGET_NOT_IN_PROTECTED_MAIN_HISTORY'
      )
        return { epoch: controls.epoch, denial: error.reason_code };
      throw error;
    }
    const drain = await this.databaseDrain({}, false);
    const denial = this.databaseDenial(drain, this.now(), current);
    if (denial) return { epoch: controls.epoch, denial };
    const activeRunIds = (
      repository: ReleaseBusV2Repository
    ): readonly string[] =>
      verifiedBinding && input.repository === repository
        ? [verifiedBinding.workflow_run_id]
        : [];
    const [backendActive, frontendActive] = await Promise.all([
      this.deps.hasActiveProductionMutationOrE2ERun(
        'backend',
        activeRunIds('backend')
      ),
      this.deps.hasActiveProductionMutationOrE2ERun(
        'frontend',
        activeRunIds('frontend')
      )
    ]);
    if (backendActive || frontendActive)
      return { epoch: controls.epoch, denial: 'ACTIVE_WORKFLOW' };
    return { epoch: controls.epoch, denial: null };
  }

  private async assertProtectedMainHistory(
    input: ReleaseBusV2ProductionAuthorityIdentity
  ): Promise<void> {
    const head = await this.deps.resolveRef(input.repository, MAIN_REF);
    if (!SHA_PATTERN.test(head.toLowerCase()))
      throw new ReleaseBusV2ProductionAuthorityError(
        'UNAVAILABLE',
        'Protected main history could not be read',
        'AUTHORITY_UNAVAILABLE'
      );
    if (
      !(await this.deps.refContainsCommit(
        input.repository,
        MAIN_REF,
        input.target_sha
      ))
    )
      throw this.conflict(
        'Target SHA is not in protected main history',
        'TARGET_NOT_IN_PROTECTED_MAIN_HISTORY'
      );
  }

  private async workflowIdentity(
    input: ReleaseBusV2ProductionAuthorityWorkflowInput
  ): Promise<ReleaseBusWorkflowRunIdentity> {
    try {
      return await this.deps.getWorkflowRunIdentity(
        input.repository,
        input.workflow_run_id
      );
    } catch {
      throw new ReleaseBusV2ProductionAuthorityError(
        'UNAVAILABLE',
        'GitHub workflow identity could not be read',
        'AUTHORITY_UNAVAILABLE'
      );
    }
  }

  private assertRunIdentity(
    identity: ReleaseBusWorkflowRunIdentity,
    input: ReleaseBusV2ProductionAuthorityWorkflowInput
  ): void {
    this.assertDeploymentIdentity(identity, input, 'in_progress');
  }

  private assertDeploymentIdentity(
    identity: ReleaseBusWorkflowRunIdentity,
    input: ReleaseBusV2ProductionAuthorityWorkflowInput,
    expectedStatus: 'in_progress' | 'completed',
    expectedConclusion: 'success' | 'failure' = 'success',
    reason: Extract<
      ReleaseBusV2ProductionAuthorityDenialCode,
      'WORKFLOW_IDENTITY_MISMATCH' | 'QUALIFIER_WORKFLOW_IDENTITY_MISMATCH'
    > = 'WORKFLOW_IDENTITY_MISMATCH'
  ): void {
    const expectedHeadRepository =
      input.repository === 'frontend'
        ? FRONTEND_HEAD_REPOSITORY
        : BACKEND_HEAD_REPOSITORY;
    let conclusionMatches: boolean;
    if (expectedStatus === 'in_progress') {
      conclusionMatches = identity.conclusion === null;
    } else if (expectedConclusion === 'success') {
      conclusionMatches = identity.conclusion === 'success';
    } else {
      conclusionMatches = FAILED_WORKFLOW_CONCLUSIONS.has(
        identity.conclusion ?? ''
      );
    }
    const common =
      identity.attempt === input.workflow_run_attempt &&
      identity.status === expectedStatus &&
      conclusionMatches &&
      identity.repository === expectedHeadRepository &&
      identity.headRepository === expectedHeadRepository &&
      identity.headBranch === MAIN_REF &&
      identity.headSha === input.target_sha;
    const valid =
      input.repository === 'frontend'
        ? common &&
          identity.event === 'workflow_dispatch' &&
          identity.path === '.github/workflows/build-upload-deploy-prod.yml' &&
          identity.name === 'Web Deploy - PROD' &&
          identity.displayTitle === 'Web Deploy - PROD'
        : common &&
          identity.event === 'workflow_dispatch' &&
          identity.path === '.github/workflows/deploy.yml' &&
          identity.name === 'Deploy a service' &&
          identity.displayTitle ===
            `Deploy ${input.service} to prod [${input.operation_id}]`;
    if (!valid)
      throw this.conflict(
        'GitHub workflow identity does not match the prepared production authority',
        reason
      );
  }

  private async verifyWorkflowBinding(
    input: ReleaseBusV2ProductionAuthorityWorkflowInput
  ): Promise<void> {
    const identity = await this.workflowIdentity(input);
    this.assertRunIdentity(identity, input);
    await this.assertApprovedOperator(identity);
  }

  private async verifyCompletedDeploymentBinding(
    input: ReleaseBusV2ProductionAuthorityWorkflowInput
  ): Promise<void> {
    const identity = await this.workflowIdentity(input);
    this.assertDeploymentIdentity(identity, input, 'completed');
    await this.assertApprovedOperator(identity);
  }

  private async assertApprovedOperator(
    identity: ReleaseBusWorkflowRunIdentity
  ): Promise<void> {
    let approved = false;
    try {
      approved = await this.deps.isOrganizationOperator(identity.actor);
    } catch {
      throw new ReleaseBusV2ProductionAuthorityError(
        'UNAVAILABLE',
        'GitHub workflow operator authorization could not be read',
        'AUTHORITY_UNAVAILABLE'
      );
    }
    if (!approved)
      throw this.conflict(
        'GitHub workflow actor is not an approved production operator',
        'WORKFLOW_IDENTITY_MISMATCH'
      );
  }

  private async qualifierWorkflowIdentity(
    input:
      | ReleaseBusV2ProductionAuthorityCompleteInput
      | ReleaseBusV2ProductionAuthorityFailureInput,
    repository: ReleaseBusV2Repository
  ): Promise<ReleaseBusWorkflowRunIdentity> {
    try {
      return await this.deps.getWorkflowRunIdentity(
        repository,
        input.qualifier_workflow_run_id
      );
    } catch {
      throw new ReleaseBusV2ProductionAuthorityError(
        'UNAVAILABLE',
        'Completion qualifier workflow identity could not be read',
        'AUTHORITY_UNAVAILABLE'
      );
    }
  }

  private assertProductionE2EIdentity(
    identity: ReleaseBusWorkflowRunIdentity,
    input: ReleaseBusV2ProductionAuthorityCompleteInput,
    deployWorkflowRunId: string
  ): void {
    // Production E2E is dispatched from current protected main, so its head
    // may be a later descendant. The immutable E2E artifact binds the deployed
    // target; this authority binds the qualifier to the exact deploy run ID.
    const valid =
      identity.attempt === input.qualifier_workflow_run_attempt &&
      identity.status === 'completed' &&
      identity.conclusion === 'success' &&
      identity.event === 'workflow_dispatch' &&
      identity.actor === 'github-actions[bot]' &&
      identity.repository === FRONTEND_HEAD_REPOSITORY &&
      identity.headRepository === FRONTEND_HEAD_REPOSITORY &&
      identity.headBranch === MAIN_REF &&
      identity.path === '.github/workflows/production-e2e.yml' &&
      identity.name === 'Production E2E' &&
      identity.displayTitle ===
        `Production E2E automatic ${deployWorkflowRunId}`;
    if (!valid)
      throw this.conflict(
        'Production E2E workflow identity or result is not trusted',
        'QUALIFIER_WORKFLOW_IDENTITY_MISMATCH'
      );
  }

  private assertProductionE2EFailureIdentity(
    identity: ReleaseBusWorkflowRunIdentity,
    input: ReleaseBusV2ProductionAuthorityFailureInput,
    deployWorkflowRunId: string
  ): void {
    const valid =
      identity.attempt === input.qualifier_workflow_run_attempt &&
      identity.status === 'completed' &&
      FAILED_WORKFLOW_CONCLUSIONS.has(identity.conclusion ?? '') &&
      identity.event === 'workflow_dispatch' &&
      identity.actor === 'github-actions[bot]' &&
      identity.repository === FRONTEND_HEAD_REPOSITORY &&
      identity.headRepository === FRONTEND_HEAD_REPOSITORY &&
      identity.headBranch === MAIN_REF &&
      identity.path === '.github/workflows/production-e2e.yml' &&
      identity.name === 'Production E2E' &&
      identity.displayTitle ===
        `Production E2E automatic ${deployWorkflowRunId}`;
    if (!valid)
      throw this.conflict(
        'Production E2E workflow identity or failure result is not trusted',
        'QUALIFIER_WORKFLOW_IDENTITY_MISMATCH'
      );
  }

  private async verifyFailureEvidence(
    input: ReleaseBusV2ProductionAuthorityFailureInput,
    current: ReleaseBusV2ProductionAuthorityRecord
  ): Promise<void> {
    if (
      current.workflow_run_id === null ||
      current.workflow_run_attempt === null
    )
      throw this.conflict(
        'Production authority is not bound to a deployment workflow run',
        'AUTHORITY_NOT_BOUND'
      );

    const isBoundDeployment =
      input.qualifier_workflow_run_id === current.workflow_run_id &&
      input.qualifier_workflow_run_attempt === current.workflow_run_attempt;
    if (current.repository === 'backend' || isBoundDeployment) {
      if (
        input.qualifier_workflow_run_id !== current.workflow_run_id ||
        input.qualifier_workflow_run_attempt !== current.workflow_run_attempt
      )
        throw this.conflict(
          'Failure evidence does not identify the bound deployment run',
          'QUALIFIER_WORKFLOW_IDENTITY_MISMATCH'
        );
      const identity = await this.workflowIdentity(input);
      this.assertDeploymentIdentity(
        identity,
        input,
        'completed',
        'failure',
        'QUALIFIER_WORKFLOW_IDENTITY_MISMATCH'
      );
      await this.assertApprovedOperator(identity);
      return;
    }

    await this.verifyCompletedDeploymentBinding(input);
    const qualifierIdentity = await this.qualifierWorkflowIdentity(
      input,
      current.repository
    );
    this.assertProductionE2EFailureIdentity(
      qualifierIdentity,
      input,
      current.workflow_run_id
    );
    if (current.repository !== 'frontend')
      throw this.conflict(
        'Only frontend authorities accept a Production E2E failure qualifier',
        'QUALIFIER_WORKFLOW_IDENTITY_MISMATCH'
      );
  }

  private assertBackendDeploymentCompletionIdentity(
    identity: ReleaseBusWorkflowRunIdentity,
    input: ReleaseBusV2ProductionAuthorityCompleteInput,
    deployWorkflowRunId: string,
    deployWorkflowRunAttempt: number
  ): void {
    const valid =
      input.qualifier_workflow_run_id === deployWorkflowRunId &&
      input.qualifier_workflow_run_attempt === deployWorkflowRunAttempt &&
      identity.attempt === deployWorkflowRunAttempt &&
      identity.status === 'completed' &&
      identity.conclusion === 'success' &&
      identity.event === 'workflow_dispatch' &&
      identity.repository === BACKEND_HEAD_REPOSITORY &&
      identity.headRepository === BACKEND_HEAD_REPOSITORY &&
      identity.headBranch === MAIN_REF &&
      identity.headSha === input.target_sha &&
      identity.path === '.github/workflows/deploy.yml' &&
      identity.name === 'Deploy a service' &&
      identity.displayTitle ===
        `Deploy ${input.service} to prod [${input.operation_id}]`;
    if (!valid)
      throw this.conflict(
        'Backend deployment completion workflow identity or result is not trusted',
        'QUALIFIER_WORKFLOW_IDENTITY_MISMATCH'
      );
  }

  private async controlSnapshot(
    ctx: RequestContext,
    forUpdate = false
  ): Promise<ControlSnapshot> {
    const mode = this.deps.getMode();
    try {
      const controls = await this.deps.listControls(ctx, forUpdate);
      const epoch = epochFromControls(mode, controls);
      const lane = deriveReleaseBusV2LaneStates(mode, controls).find(
        (state) => state.lane === 'PRODUCTION'
      );
      if (!lane) throw new Error('Production lane is unavailable');
      return {
        epoch,
        laneStatus: lane.status,
        changeable: lane.changeable
      };
    } catch (error) {
      if (error instanceof ReleaseBusV2ProductionAuthorityError) throw error;
      throw new ReleaseBusV2ProductionAuthorityError(
        'UNAVAILABLE',
        'Production control state could not be read',
        'AUTHORITY_UNAVAILABLE'
      );
    }
  }

  private async databaseDrain(
    ctx: RequestContext,
    forUpdate: boolean
  ): Promise<DatabaseDrain> {
    const [locks, activeTrains, activeOperations] = await Promise.all([
      this.deps.listLocks(ctx, forUpdate),
      this.deps.listActiveTrains(ctx, forUpdate),
      this.deps.listNonterminalOperationsForLanes(
        PRODUCTION_LANES,
        ctx,
        forUpdate
      )
    ]);
    return { locks, activeTrains, activeOperations };
  }

  private databaseDenial(
    drain: DatabaseDrain,
    now: number,
    current: ReleaseBusV2ProductionAuthorityRecord | null
  ): ReleaseBusV2ProductionAuthorityDenialCode | null {
    if (drain.activeTrains.some((train) => train.lane === 'PRODUCTION'))
      return 'ACTIVE_TRAIN';
    if (drain.activeOperations.length > 0) return 'ACTIVE_OPERATION';
    const lock = this.productionLock(drain.locks);
    if (
      lock &&
      lockIsActive(lock, now) &&
      !(current && this.ownsLock(current, lock))
    )
      return 'ENVIRONMENT_LOCK_HELD';
    return null;
  }

  private productionLock(
    locks: readonly ReleaseBusV2LockRecord[]
  ): ReleaseBusV2LockRecord | null {
    const matches = locks.filter(
      (lock) => lock.name === RELEASE_BUS_V2_PRODUCTION_AUTHORITY_LOCK_NAME
    );
    if (matches.length !== 1) return null;
    return matches[0] ?? null;
  }

  private ownsLock(
    record: ReleaseBusV2ProductionAuthorityRecord,
    lock: ReleaseBusV2LockRecord | null
  ): boolean {
    return Boolean(
      lock &&
      record.lease_owner &&
      record.lease_token &&
      lock.lease_owner === record.lease_owner &&
      lock.lease_token === record.lease_token &&
      lock.owner_train_id === null
    );
  }

  private insertRecord(
    input: ReleaseBusV2ProductionAuthorityIdentity,
    epoch: ReleaseBusV2ControlEpoch,
    fields: {
      readonly id: string;
      readonly status: ReleaseBusV2ProductionAuthorityStatus;
      readonly lease_owner: string | null;
      readonly lease_token: string | null;
      readonly lease_expires_at: number | null;
      readonly hard_expires_at: number | null;
      readonly lock_row_version: number | null;
    },
    binding: ReleaseBusV2ProductionAuthorityBinding | null = null
  ): Omit<
    ReleaseBusV2ProductionAuthorityRecord,
    'created_at' | 'updated_at' | 'row_version'
  > {
    return {
      id: fields.id,
      operation_id: input.operation_id,
      controller_identity: input.controller_identity,
      repository: input.repository,
      environment: input.environment,
      service: input.service,
      target_sha: input.target_sha,
      selection_digest: null,
      workflow_run_id: binding?.workflow_run_id ?? null,
      workflow_run_attempt: binding?.workflow_run_attempt ?? null,
      qualifier_workflow_run_id: null,
      qualifier_workflow_run_attempt: null,
      evidence_digest: null,
      status: fields.status,
      lease_owner: fields.lease_owner,
      lease_token: fields.lease_token,
      lease_expires_at: fields.lease_expires_at,
      hard_expires_at: fields.hard_expires_at,
      lock_row_version: fields.lock_row_version,
      control_epoch_all: epoch.all,
      control_epoch_production: epoch.production,
      control_mode: epoch.mode,
      denial_code: null,
      denial_observed_all_epoch: null,
      denial_observed_production_epoch: null,
      denial_observed_mode: null,
      failure_code: null,
      completed_at: null
    };
  }

  private async createDenied(
    input: ReleaseBusV2ProductionAuthorityIdentity,
    epoch: ReleaseBusV2ControlEpoch,
    denial: ReleaseBusV2ProductionAuthorityDenialCode
  ): Promise<ReleaseBusV2ProductionAuthorityRecord> {
    return this.deps.repository.executeNativeQueriesInTransaction(
      async (connection: ConnectionWrapper<unknown>) =>
        this.createDeniedInTransaction(input, epoch, denial, { connection })
    );
  }

  private async createDeniedInTransaction(
    input: ReleaseBusV2ProductionAuthorityIdentity,
    epoch: ReleaseBusV2ControlEpoch,
    denial: ReleaseBusV2ProductionAuthorityDenialCode,
    ctx: RequestContext
  ): Promise<ReleaseBusV2ProductionAuthorityRecord> {
    const existing = await this.deps.repository.findProductionAuthority(
      input.operation_id,
      ctx,
      true
    );
    if (existing) {
      this.assertRecordIdentity(existing, input);
      return existing;
    }
    const base = this.insertRecord(input, epoch, {
      id: randomUUID(),
      status: 'DENIED',
      lease_owner: null,
      lease_token: null,
      lease_expires_at: null,
      hard_expires_at: null,
      lock_row_version: null
    });
    return this.deps.repository.createProductionAuthority(
      {
        ...base,
        denial_code: denial,
        denial_observed_all_epoch: epoch.all,
        denial_observed_production_epoch: epoch.production,
        denial_observed_mode: epoch.mode
      },
      ctx
    );
  }

  private async denyExisting(
    record: ReleaseBusV2ProductionAuthorityRecord,
    epoch: ReleaseBusV2ControlEpoch,
    denial: ReleaseBusV2ProductionAuthorityDenialCode
  ): Promise<ReleaseBusV2ProductionAuthorityRecord> {
    return this.deps.repository.executeNativeQueriesInTransaction(
      async (connection: ConnectionWrapper<unknown>) => {
        const ctx: RequestContext = { connection };
        const current = await this.requireRecordById(record.id, ctx, true);
        return this.denyExistingInTransaction(current, epoch, denial, ctx);
      }
    );
  }

  private async denyExistingInTransaction(
    record: ReleaseBusV2ProductionAuthorityRecord,
    epoch: ReleaseBusV2ControlEpoch,
    denial: ReleaseBusV2ProductionAuthorityDenialCode,
    ctx: RequestContext
  ): Promise<ReleaseBusV2ProductionAuthorityRecord> {
    if (isTerminal(record.status)) return record;
    let lockRowVersion = record.lock_row_version;
    const lock = this.productionLock(
      await this.deps.repository.listLocks(ctx, true)
    );
    if (this.ownsLock(record, lock) && record.lease_token) {
      if (
        await this.deps.repository.releaseLock(
          RELEASE_BUS_V2_PRODUCTION_AUTHORITY_LOCK_NAME,
          record.lease_token,
          ctx
        )
      ) {
        lockRowVersion =
          this.productionLock(await this.deps.repository.listLocks(ctx, true))
            ?.row_version ?? null;
      }
    } else if (record.lease_token) {
      denial = 'LEASE_LOST';
    }
    const updated = await this.deps.repository.updateProductionAuthority(
      record.id,
      record.row_version,
      {
        status: denial === 'LEASE_LOST' ? 'EXPIRED' : 'DENIED',
        lease_owner: null,
        lease_token: null,
        lease_expires_at: null,
        lock_row_version: lockRowVersion,
        denial_code: denial,
        denial_observed_all_epoch: epoch.all,
        denial_observed_production_epoch: epoch.production,
        denial_observed_mode: epoch.mode
      },
      ctx
    );
    if (!updated) throw new Error('Production authority denial raced');
    return this.requireRecordById(record.id, ctx, true);
  }

  private async expire(
    record: ReleaseBusV2ProductionAuthorityRecord,
    denial: Extract<
      ReleaseBusV2ProductionAuthorityDenialCode,
      'LEASE_EXPIRED' | 'LEASE_LOST' | 'HARD_TTL_EXPIRED'
    >
  ): Promise<ReleaseBusV2ProductionAuthorityRecord> {
    return this.deps.repository.executeNativeQueriesInTransaction(
      async (connection: ConnectionWrapper<unknown>) => {
        const ctx: RequestContext = { connection };
        const current = await this.requireRecordById(record.id, ctx, true);
        return this.expireInTransaction(current, denial, ctx);
      }
    );
  }

  private async expireInTransaction(
    record: ReleaseBusV2ProductionAuthorityRecord,
    denial: ReleaseBusV2ProductionAuthorityDenialCode,
    ctx: RequestContext
  ): Promise<ReleaseBusV2ProductionAuthorityRecord> {
    if (isTerminal(record.status)) return record;
    let lockRowVersion = record.lock_row_version;
    const lock = this.productionLock(
      await this.deps.repository.listLocks(ctx, true)
    );
    if (this.ownsLock(record, lock) && record.lease_token) {
      if (
        await this.deps.repository.releaseLock(
          RELEASE_BUS_V2_PRODUCTION_AUTHORITY_LOCK_NAME,
          record.lease_token,
          ctx
        )
      )
        lockRowVersion =
          this.productionLock(await this.deps.repository.listLocks(ctx, true))
            ?.row_version ?? null;
      else denial = 'LEASE_LOST';
    } else if (record.lease_token) {
      denial = 'LEASE_LOST';
    }
    const controls = await this.controlSnapshot(ctx, true);
    const updated = await this.deps.repository.updateProductionAuthority(
      record.id,
      record.row_version,
      {
        status: 'EXPIRED',
        lease_owner: null,
        lease_token: null,
        lease_expires_at: null,
        lock_row_version: lockRowVersion,
        denial_code: denial,
        denial_observed_all_epoch: controls.epoch.all,
        denial_observed_production_epoch: controls.epoch.production,
        denial_observed_mode: controls.epoch.mode
      },
      ctx
    );
    if (!updated) throw new Error('Production authority expiry raced');
    return this.requireRecordById(record.id, ctx, true);
  }

  private async requireRecord(
    input: ReleaseBusV2ProductionAuthorityIdentity,
    ctx: RequestContext = {},
    forUpdate = false
  ): Promise<ReleaseBusV2ProductionAuthorityRecord> {
    const record = await this.deps.repository.findProductionAuthority(
      input.operation_id,
      ctx,
      forUpdate,
      Boolean(ctx.connection)
    );
    if (!record)
      throw this.conflict(
        'Production authority operation was not found',
        'AUTHORITY_NOT_FOUND'
      );
    return record;
  }

  private async requireRecordById(
    id: string,
    ctx: RequestContext,
    forUpdate: boolean
  ): Promise<ReleaseBusV2ProductionAuthorityRecord> {
    const record = await this.deps.repository.findProductionAuthorityById(
      id,
      ctx,
      forUpdate,
      Boolean(ctx.connection)
    );
    if (!record)
      throw this.conflict(
        'Production authority operation was not found',
        'AUTHORITY_NOT_FOUND'
      );
    return record;
  }

  private assertIdentityInput(
    input: ReleaseBusV2ProductionAuthorityIdentityInput
  ): void {
    if (
      !OPERATION_PATTERN.test(input.operation_id) ||
      !CONTROLLER_PATTERN.test(input.controller_identity) ||
      !CONTROLLER_IDENTITIES.has(input.controller_identity) ||
      input.environment !== 'prod' ||
      !SHA_PATTERN.test(input.target_sha) ||
      (input.selection_digest !== null &&
        !DIGEST_PATTERN.test(input.selection_digest)) ||
      (input.repository === 'backend' &&
        !canDeployServiceToEnvironment(input.service, input.environment)) ||
      (input.repository === 'frontend' && input.service !== 'frontend') ||
      !RELEASE_BUS_V2_PRODUCTION_AUTHORITY_CONTROLLER_IDENTITIES_BY_REPOSITORY[
        input.repository
      ].includes(input.controller_identity)
    )
      throw this.conflict(
        'Production authority identity is invalid',
        'OWNER_MISMATCH'
      );
  }

  private assertUnselectedInput(
    input: ReleaseBusV2ProductionAuthorityIdentityInput
  ): void {
    if (input.selection_digest !== null)
      throw this.conflict(
        'Prepare and bind must not freeze a selection digest',
        'SELECTION_DIGEST_MISMATCH'
      );
  }

  private assertSelectionDigest(input: {
    readonly selection_digest: string | null;
  }): void {
    if (
      input.selection_digest === null ||
      !DIGEST_PATTERN.test(input.selection_digest)
    )
      throw this.conflict(
        'Selection digest must be a lowercase SHA-256 digest',
        'SELECTION_DIGEST_MISMATCH'
      );
  }

  private assertCompletedSelection(
    record: ReleaseBusV2ProductionAuthorityRecord,
    selectionDigest: string | null
  ): void {
    if (
      record.selection_digest === null ||
      record.selection_digest !== selectionDigest
    )
      throw this.conflict(
        'Completion requires the exact persisted selection digest',
        'SELECTION_DIGEST_MISMATCH'
      );
  }

  private assertPersistedSelection(
    record: ReleaseBusV2ProductionAuthorityRecord,
    selectionDigest: string
  ): void {
    if (
      record.selection_digest !== null &&
      record.selection_digest !== selectionDigest
    )
      throw this.conflict(
        'Selection digest does not match the persisted production authority',
        'SELECTION_DIGEST_MISMATCH'
      );
  }

  private assertFailureSelection(
    record: ReleaseBusV2ProductionAuthorityRecord,
    selectionDigest: string | null
  ): void {
    if (
      (record.selection_digest === null && selectionDigest !== null) ||
      (record.selection_digest !== null &&
        selectionDigest !== record.selection_digest)
    )
      throw this.conflict(
        'Failure selection must match the authority selection state',
        'SELECTION_DIGEST_MISMATCH'
      );
    if (selectionDigest !== null && !DIGEST_PATTERN.test(selectionDigest))
      throw this.conflict(
        'Failure selection digest must be a lowercase SHA-256 digest',
        'SELECTION_DIGEST_MISMATCH'
      );
  }

  private assertCompletionInput(
    input: ReleaseBusV2ProductionAuthorityCompleteInput
  ): void {
    this.assertSelectionDigest(input);
    this.assertTerminalEvidence(input);
  }

  private assertFailureInput(
    input: ReleaseBusV2ProductionAuthorityFailureInput
  ): void {
    if (
      input.selection_digest !== null &&
      !DIGEST_PATTERN.test(input.selection_digest)
    )
      throw this.conflict(
        'Failure selection digest must be a lowercase SHA-256 digest',
        'SELECTION_DIGEST_MISMATCH'
      );
    this.assertTerminalEvidence(input);
  }

  private assertTerminalEvidence(
    input: ReleaseBusV2ProductionAuthorityTerminalEvidence
  ): void {
    if (
      !/^[1-9]\d{0,19}$/.test(input.qualifier_workflow_run_id) ||
      !Number.isInteger(input.qualifier_workflow_run_attempt) ||
      input.qualifier_workflow_run_attempt < 1 ||
      input.qualifier_workflow_run_attempt > 1_000_000 ||
      !DIGEST_PATTERN.test(input.evidence_digest)
    )
      throw this.conflict(
        'Terminal workflow evidence is invalid',
        'EVIDENCE_DIGEST_MISMATCH'
      );
  }

  private assertPersistedCompletion(
    record: ReleaseBusV2ProductionAuthorityRecord,
    evidence: CompletionEvidence
  ): void {
    if (
      (record.qualifier_workflow_run_id !== null &&
        record.qualifier_workflow_run_id !==
          evidence.qualifier_workflow_run_id) ||
      (record.qualifier_workflow_run_attempt !== null &&
        record.qualifier_workflow_run_attempt !==
          evidence.qualifier_workflow_run_attempt) ||
      (record.evidence_digest !== null &&
        record.evidence_digest !== evidence.evidence_digest)
    )
      throw this.conflict(
        'Production completion evidence is immutable and does not match',
        'EVIDENCE_DIGEST_MISMATCH'
      );
  }

  private assertRecordIdentity(
    record: ReleaseBusV2ProductionAuthorityRecord,
    input: ReleaseBusV2ProductionAuthorityIdentity
  ): void {
    if (!identityMatchesRecord(record, input))
      throw this.conflict(
        'Production authority immutable identity does not match',
        'OWNER_MISMATCH'
      );
  }

  private assertBoundInput(
    record: ReleaseBusV2ProductionAuthorityRecord,
    input: ReleaseBusV2ProductionAuthorityBinding
  ): void {
    if (
      record.status === 'PREPARED' ||
      record.workflow_run_id === null ||
      record.workflow_run_attempt === null
    )
      throw this.conflict(
        'Production authority is not bound to a GitHub workflow run',
        'AUTHORITY_NOT_BOUND'
      );
    if (!bindingMatchesRecord(record, input))
      throw this.conflict(
        'GitHub workflow run identity does not match the production authority',
        'OWNER_MISMATCH'
      );
  }

  private expired(record: ReleaseBusV2ProductionAuthorityRecord): boolean {
    return (
      record.lease_expires_at === null || this.now() >= record.lease_expires_at
    );
  }

  private prepareResponse(
    record: ReleaseBusV2ProductionAuthorityRecord,
    reused: boolean
  ): ReleaseBusV2ProductionAuthorityPrepareResponse {
    const identity = responseIdentity(record);
    if (record.status === 'PREPARED' || record.status === 'BOUND')
      return {
        ...identity,
        prepared: true,
        authorized: record.status === 'BOUND',
        reused
      };
    return {
      ...identity,
      prepared: false,
      authorized: false,
      reused,
      reason_code: record.denial_code ?? 'AUTHORITY_TERMINAL',
      observed_epoch: observedEpoch(record)
    };
  }

  private bindResponse(
    record: ReleaseBusV2ProductionAuthorityRecord,
    reused: boolean
  ): ReleaseBusV2ProductionAuthorityBindResponse {
    const identity = responseIdentity(record);
    if (record.status === 'BOUND')
      return { ...identity, bound: true, authorized: true, reused };
    return {
      ...identity,
      bound: false,
      authorized: false,
      reused,
      reason_code: record.denial_code ?? 'AUTHORITY_TERMINAL',
      observed_epoch: observedEpoch(record)
    };
  }

  private completionResponse(
    record: ReleaseBusV2ProductionAuthorityRecord,
    requestedStatus: 'COMPLETED' | 'FAILED',
    reused: boolean
  ): ReleaseBusV2ProductionAuthorityCompletionResponse {
    const isRequested = record.status === requestedStatus;
    const status = (
      isTerminal(record.status) ? record.status : requestedStatus
    ) as ReleaseBusV2ProductionAuthorityCompletionResponse['status'];
    return {
      operation_id: record.operation_id,
      status,
      ...(requestedStatus === 'COMPLETED'
        ? { completed: isRequested }
        : { failed: isRequested }),
      reused,
      lock_row_version: record.lock_row_version,
      ...(isRequested
        ? {}
        : {
            reason_code: record.denial_code ?? 'AUTHORITY_TERMINAL',
            observed_epoch: observedEpoch(record)
          })
    };
  }

  private conflict(
    message: string,
    reason: ReleaseBusV2ProductionAuthorityDenialCode
  ): ReleaseBusV2ProductionAuthorityError {
    return new ReleaseBusV2ProductionAuthorityError(
      'CONFLICT',
      message,
      reason
    );
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }
}

export const releaseBusV2ProductionAuthorityService =
  new ReleaseBusV2ProductionAuthorityService();
