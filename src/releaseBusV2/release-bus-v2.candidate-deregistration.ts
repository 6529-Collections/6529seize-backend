import { createHash, randomUUID } from 'node:crypto';
import {
  deriveReleaseBusV2LaneStates,
  getReleaseBusV2Mode,
  RELEASE_BUS_V2_LOCK_TTL_MS
} from '@/releaseBusV2/release-bus-v2.config';
import { releaseBusGitHubApp } from '@/releaseBusV2/release-bus-v2.github-app';
import {
  releaseBusV2CandidateInventoryDigest,
  releaseBusV2Repository,
  type ReleaseBusV2CandidateVersion,
  type ReleaseBusV2ControlRecord,
  type ReleaseBusV2ControlVersion,
  type ReleaseBusV2LockRecord,
  type ReleaseBusV2LockVersion,
  type ReleaseBusV2MaintenanceLease,
  type ReleaseBusV2Repository as ReleaseBusV2RepositoryClass
} from '@/releaseBusV2/release-bus-v2.repository';
import type {
  ReleaseBusV2CandidateRecord,
  ReleaseBusV2Mode,
  ReleaseBusV2StagingStateRecord
} from '@/releaseBusV2/release-bus-v2.types';

const MAX_DEREGISTRATION_CANDIDATES = 500;
const REQUIRED_LOCK_NAMES = [
  'production-environment',
  'scheduler',
  'staging-environment'
] as const;
const REQUIRED_CONTROL_SCOPES = ['ALL', 'PRODUCTION', 'STAGING'] as const;

export type ReleaseBusV2DeregistrationStagingRefs = {
  readonly frontend: string;
  readonly backend: string;
};

export type ReleaseBusV2CandidateDeregistrationPlan = {
  readonly phase: 'PREPARE';
  readonly plan_sha256: string;
  readonly inventory_sha256: string;
  readonly candidate_count: number;
  readonly candidates: readonly ReleaseBusV2CandidateVersion[];
  readonly controls: readonly ReleaseBusV2ControlVersion[];
  readonly locks: readonly ReleaseBusV2LockVersion[];
  readonly staging_state_row_version: number;
  readonly staging_refs: ReleaseBusV2DeregistrationStagingRefs;
  readonly mode: ReleaseBusV2Mode;
  readonly executed: false;
  readonly deregistration_id: null;
  readonly physical_staging_presence: 'UNKNOWN_UNCHANGED';
};

export type ReleaseBusV2CandidateDeregistrationExecution = Omit<
  ReleaseBusV2CandidateDeregistrationPlan,
  'phase' | 'executed' | 'deregistration_id' | 'physical_staging_presence'
> & {
  readonly phase: 'EXECUTE';
  readonly executed: true;
  readonly deregistration_id: string;
  readonly physical_staging_presence: 'UNKNOWN_DETACHED';
};

export type ReleaseBusV2CandidateDeregistrationExecuteInput = {
  readonly reason: string;
  readonly expected_plan_sha256: string;
  readonly expected_inventory_sha256: string;
  readonly expected_candidates: readonly ReleaseBusV2CandidateVersion[];
  readonly expected_controls: readonly ReleaseBusV2ControlVersion[];
  readonly expected_locks: readonly ReleaseBusV2LockVersion[];
  readonly expected_staging_state_row_version: number;
  readonly expected_staging_refs: ReleaseBusV2DeregistrationStagingRefs;
};

export class ReleaseBusV2CandidateDeregistrationError extends Error {
  public constructor(
    public readonly code: 'BAD_REQUEST' | 'CONFLICT' | 'UNAVAILABLE',
    message: string,
    public readonly committed: boolean = false,
    public readonly deregistration_id: string | null = null,
    public readonly physical_staging_presence:
      | 'UNKNOWN_UNCHANGED'
      | 'UNKNOWN_DETACHED' = 'UNKNOWN_UNCHANGED'
  ) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = 'ReleaseBusV2CandidateDeregistrationError';
  }
}

export function isReleaseBusV2CandidateDeregistrationError(
  error: unknown
): error is ReleaseBusV2CandidateDeregistrationError {
  if (error instanceof ReleaseBusV2CandidateDeregistrationError) return true;
  if (
    !(error instanceof Error) ||
    error.name !== 'ReleaseBusV2CandidateDeregistrationError'
  )
    return false;
  return ['BAD_REQUEST', 'CONFLICT', 'UNAVAILABLE'].includes(
    String((error as { code?: unknown }).code)
  );
}

type DeregistrationDependencies = {
  readonly getMode: () => ReleaseBusV2Mode;
  readonly resolveStagingRefs: () => Promise<ReleaseBusV2DeregistrationStagingRefs>;
  readonly hasActiveWorkflow: () => Promise<boolean>;
};

type DeregistrationSnapshot = {
  readonly mode: ReleaseBusV2Mode;
  readonly controls: readonly ReleaseBusV2ControlVersion[];
  readonly locks: readonly ReleaseBusV2LockVersion[];
  readonly stagingState: ReleaseBusV2StagingStateRecord;
  readonly stagingRefs: ReleaseBusV2DeregistrationStagingRefs;
  readonly candidates: readonly ReleaseBusV2CandidateRecord[];
};

const dependencies: DeregistrationDependencies = {
  getMode: getReleaseBusV2Mode,
  resolveStagingRefs: async () => {
    const [frontend, backend] = await Promise.all([
      releaseBusGitHubApp.resolveRef('frontend', '1a-staging'),
      releaseBusGitHubApp.resolveRef('backend', '1a-staging')
    ]);
    return { frontend, backend };
  },
  hasActiveWorkflow: async () => {
    const active = await Promise.all([
      releaseBusGitHubApp.hasActiveStagingMutationOrE2ERun('frontend'),
      releaseBusGitHubApp.hasActiveStagingMutationOrE2ERun('backend'),
      releaseBusGitHubApp.hasActiveProductionMutationOrE2ERun('frontend'),
      releaseBusGitHubApp.hasActiveProductionMutationOrE2ERun('backend')
    ]);
    return active.some(Boolean);
  }
};

function booleanControl(control: ReleaseBusV2ControlRecord): boolean {
  if (control.paused === true || control.paused === 1) return true;
  if (control.paused === false || control.paused === 0) return false;
  throw new Error(`Release Bus v2 ${control.scope} control is invalid`);
}

function normalizedControls(
  controls: readonly ReleaseBusV2ControlRecord[]
): ReleaseBusV2ControlVersion[] {
  return controls
    .map((control) => ({
      scope: control.scope,
      paused: booleanControl(control),
      row_version: control.row_version
    }))
    .sort((left, right) => left.scope.localeCompare(right.scope));
}

function normalizedLocks(
  locks: readonly ReleaseBusV2LockRecord[]
): ReleaseBusV2LockVersion[] {
  return locks
    .map((lock) => ({ name: lock.name, row_version: lock.row_version }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

function candidateVersions(
  candidates: readonly ReleaseBusV2CandidateRecord[]
): ReleaseBusV2CandidateVersion[] {
  return candidates
    .map(({ id, row_version }) => ({ id, row_version }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

function sha256(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function planIdentity(
  reason: string,
  snapshot: DeregistrationSnapshot,
  inventorySha256: string
) {
  return {
    contract: 'release-bus-v2-logical-deregistration-v1',
    reason,
    mode: snapshot.mode,
    controls: snapshot.controls,
    locks: snapshot.locks,
    staging_state: {
      status: snapshot.stagingState.status,
      row_version: snapshot.stagingState.row_version,
      current_manifest_id: snapshot.stagingState.current_manifest_id,
      last_validated_manifest_id:
        snapshot.stagingState.last_validated_manifest_id,
      frontend_sha: snapshot.stagingState.frontend_sha,
      backend_sha: snapshot.stagingState.backend_sha,
      frontend_staging_ref_sha: snapshot.stagingState.frontend_staging_ref_sha,
      backend_staging_ref_sha: snapshot.stagingState.backend_staging_ref_sha,
      clean_main: Boolean(snapshot.stagingState.clean_main),
      last_transition_train_id: snapshot.stagingState.last_transition_train_id
    },
    staging_refs: snapshot.stagingRefs,
    candidate_count: snapshot.candidates.length,
    candidates: candidateVersions(snapshot.candidates),
    inventory_sha256: inventorySha256
  };
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sameStagingRefs(
  left: ReleaseBusV2DeregistrationStagingRefs,
  right: ReleaseBusV2DeregistrationStagingRefs
): boolean {
  return left.frontend === right.frontend && left.backend === right.backend;
}

export class ReleaseBusV2CandidateDeregistrationService {
  public constructor(
    private readonly repository: ReleaseBusV2RepositoryClass = releaseBusV2Repository,
    private readonly deps: DeregistrationDependencies = dependencies
  ) {}

  public async prepare(
    reason: string
  ): Promise<ReleaseBusV2CandidateDeregistrationPlan> {
    return this.failClosed(async () => {
      const normalizedReason = this.normalizeReason(reason);
      const snapshot = await this.readReadySnapshot();
      return this.plan(normalizedReason, snapshot);
    });
  }

  public async execute(
    input: ReleaseBusV2CandidateDeregistrationExecuteInput,
    actor: string
  ): Promise<ReleaseBusV2CandidateDeregistrationExecution> {
    return this.failClosed(async () => {
      const reason = this.normalizeReason(input.reason);
      const before = await this.readReadySnapshot();
      const plan = this.plan(reason, before);
      this.assertExpectedPlan(plan, input);
      if (plan.candidate_count === 0)
        throw new ReleaseBusV2CandidateDeregistrationError(
          'CONFLICT',
          'Candidate deregistration preparation is a safe no-op because no active candidate intent exists'
        );
      const leaseOwner = `deregister:${actor}:${randomUUID()}`;
      let leases: readonly ReleaseBusV2MaintenanceLease[] = [];
      let execution: ReleaseBusV2CandidateDeregistrationExecution | null = null;
      let committedDeregistrationId: string | null = null;
      let failure: unknown;
      try {
        leases = await this.repository.acquireExactFreeMaintenanceLocks(
          input.expected_locks,
          leaseOwner,
          RELEASE_BUS_V2_LOCK_TTL_MS
        );
        const [stagingRefs, activeWorkflow] = await Promise.all([
          this.deps.resolveStagingRefs(),
          this.deps.hasActiveWorkflow()
        ]);
        if (activeWorkflow)
          throw new ReleaseBusV2CandidateDeregistrationError(
            'CONFLICT',
            'Candidate deregistration requires every staging and production mutation or E2E workflow to be inactive'
          );
        if (!sameStagingRefs(stagingRefs, input.expected_staging_refs))
          throw new ReleaseBusV2CandidateDeregistrationError(
            'CONFLICT',
            'Staging refs changed after the deregistration plan was prepared'
          );
        if (this.deps.getMode() !== plan.mode)
          throw new ReleaseBusV2CandidateDeregistrationError(
            'CONFLICT',
            'Release Bus mode changed after the deregistration plan was prepared'
          );
        const deregistrationId = randomUUID();
        await this.repository.commitAllCandidateDeregistration({
          deregistrationId,
          actor,
          reason,
          expectedControls: input.expected_controls,
          maintenanceLeases: leases,
          expectedStagingStateRowVersion:
            input.expected_staging_state_row_version,
          expectedCandidates: input.expected_candidates,
          expectedInventorySha256: input.expected_inventory_sha256,
          observedFrontendStagingSha: stagingRefs.frontend,
          observedBackendStagingSha: stagingRefs.backend
        });
        committedDeregistrationId = deregistrationId;
        execution = {
          ...plan,
          phase: 'EXECUTE',
          executed: true,
          deregistration_id: deregistrationId,
          physical_staging_presence: 'UNKNOWN_DETACHED'
        };
        const [postCommitRefs, postCommitActiveWorkflow] = await Promise.all([
          this.deps.resolveStagingRefs(),
          this.deps.hasActiveWorkflow()
        ]);
        const postCommitMode = this.deps.getMode();
        if (
          postCommitActiveWorkflow ||
          !sameStagingRefs(postCommitRefs, stagingRefs) ||
          postCommitMode !== plan.mode
        ) {
          let auditFailure = false;
          try {
            await this.repository.appendEvent(
              {
                eventType: 'CANDIDATE_DEREGISTRATION_POST_FENCE_CHANGED',
                actor,
                payload: {
                  deregistration_id: deregistrationId,
                  workflow_active: postCommitActiveWorkflow,
                  mode_changed: postCommitMode !== plan.mode,
                  expected_staging_refs: stagingRefs,
                  observed_staging_refs: postCommitRefs,
                  staging_state_retained: 'DETACHED_MANUAL_OWNERSHIP'
                }
              },
              {}
            );
          } catch {
            auditFailure = true;
          }
          throw new ReleaseBusV2CandidateDeregistrationError(
            'CONFLICT',
            `Candidate inventory was committed as safely detached (deregistration_id=${deregistrationId}), but the post-commit workflow/ref fence changed${
              auditFailure
                ? ' and the supplemental post-fence audit event failed'
                : ''
            }`,
            true,
            deregistrationId,
            'UNKNOWN_DETACHED'
          );
        }
      } catch (error) {
        failure =
          committedDeregistrationId &&
          !(
            isReleaseBusV2CandidateDeregistrationError(error) && error.committed
          )
            ? new ReleaseBusV2CandidateDeregistrationError(
                'UNAVAILABLE',
                `Candidate inventory was committed as safely detached (deregistration_id=${committedDeregistrationId}), but post-commit verification failed`,
                true,
                committedDeregistrationId,
                'UNKNOWN_DETACHED'
              )
            : error;
      }
      let releaseFailed = false;
      if (leases.length > 0) {
        try {
          await this.repository.releaseExactMaintenanceLocks(leases);
        } catch {
          releaseFailed = true;
        }
      }
      if (releaseFailed) {
        if (committedDeregistrationId)
          throw new ReleaseBusV2CandidateDeregistrationError(
            'UNAVAILABLE',
            `Candidate inventory was committed as safely detached (deregistration_id=${committedDeregistrationId}), but maintenance lock cleanup failed${
              failure instanceof Error
                ? ` after ${failure.message}`
                : failure
                  ? ' after another post-commit failure'
                  : ''
            }`,
            true,
            committedDeregistrationId,
            'UNKNOWN_DETACHED'
          );
        throw new ReleaseBusV2CandidateDeregistrationError(
          'UNAVAILABLE',
          `Candidate deregistration did not commit and maintenance lock cleanup failed${
            failure instanceof Error
              ? ` after ${failure.message}`
              : failure
                ? ' after another pre-commit failure'
                : ''
          }`
        );
      }
      if (failure) throw failure;
      if (!execution)
        throw new Error(
          'Candidate deregistration ended without a committed execution result'
        );
      return execution;
    });
  }

  private async readReadySnapshot(): Promise<DeregistrationSnapshot> {
    const mode = this.deps.getMode();
    const [controls, locks, activeTrains, activeOperations, candidates, state] =
      await Promise.all([
        this.repository.listControls({}),
        this.repository.listLocks({}),
        this.repository.listActiveTrains({}),
        this.repository.listNonterminalOperationsForLanes(
          ['STAGING', 'PRODUCTION', 'PRODUCTION_QUALIFICATION'],
          {}
        ),
        this.repository.listCandidateDeregistrationTargets({}),
        this.repository.getStagingState({})
      ]);
    this.assertControls(mode, controls);
    this.assertLocksWhollyFree(locks);
    if (activeTrains.length > 0)
      throw new ReleaseBusV2CandidateDeregistrationError(
        'CONFLICT',
        'Candidate deregistration requires every Release Bus train to be terminal'
      );
    if (activeOperations.length > 0)
      throw new ReleaseBusV2CandidateDeregistrationError(
        'CONFLICT',
        'Candidate deregistration requires every Release Bus operation to be terminal'
      );
    if (candidates.length > MAX_DEREGISTRATION_CANDIDATES)
      throw new ReleaseBusV2CandidateDeregistrationError(
        'CONFLICT',
        `Candidate deregistration supports at most ${MAX_DEREGISTRATION_CANDIDATES} exact active-intent rows`
      );
    const [stagingRefs, activeWorkflow] = await Promise.all([
      this.deps.resolveStagingRefs(),
      this.deps.hasActiveWorkflow()
    ]);
    if (activeWorkflow)
      throw new ReleaseBusV2CandidateDeregistrationError(
        'CONFLICT',
        'Candidate deregistration requires every staging and production mutation or E2E workflow to be inactive'
      );
    return {
      mode,
      controls: normalizedControls(controls),
      locks: normalizedLocks(locks),
      stagingState: state,
      stagingRefs,
      candidates
    };
  }

  private assertControls(
    mode: ReleaseBusV2Mode,
    controls: readonly ReleaseBusV2ControlRecord[]
  ): void {
    const normalized = normalizedControls(controls);
    if (
      normalized.length !== REQUIRED_CONTROL_SCOPES.length ||
      normalized.some(
        (control, index) => control.scope !== REQUIRED_CONTROL_SCOPES[index]
      )
    )
      throw new ReleaseBusV2CandidateDeregistrationError(
        'UNAVAILABLE',
        'Candidate deregistration requires the exact three Release Bus controls'
      );
    const all = normalized.find(({ scope }) => scope === 'ALL');
    const staging = normalized.find(({ scope }) => scope === 'STAGING');
    const production = normalized.find(({ scope }) => scope === 'PRODUCTION');
    const lanes = deriveReleaseBusV2LaneStates(mode, controls);
    if (
      all?.paused !== false ||
      staging?.paused !== true ||
      production?.paused !== true ||
      lanes.length !== 2 ||
      lanes.some(
        ({ status, changeable }) => status !== 'OFF' || changeable !== true
      )
    )
      throw new ReleaseBusV2CandidateDeregistrationError(
        'CONFLICT',
        'Candidate deregistration requires ALL unpaused and both independently changeable lanes paused OFF'
      );
  }

  private assertLocksWhollyFree(
    locks: readonly ReleaseBusV2LockRecord[]
  ): void {
    const sorted = [...locks].sort((left, right) =>
      left.name.localeCompare(right.name)
    );
    if (
      sorted.length !== REQUIRED_LOCK_NAMES.length ||
      sorted.some(
        (lock, index) =>
          lock.name !== REQUIRED_LOCK_NAMES[index] ||
          lock.owner_train_id !== null ||
          lock.lease_owner !== null ||
          lock.lease_token !== null ||
          lock.heartbeat_at !== null ||
          lock.expires_at !== null
      )
    )
      throw new ReleaseBusV2CandidateDeregistrationError(
        'CONFLICT',
        'Candidate deregistration requires every exact Release Bus lock to be wholly free'
      );
  }

  private plan(
    reason: string,
    snapshot: DeregistrationSnapshot
  ): ReleaseBusV2CandidateDeregistrationPlan {
    const inventorySha256 = releaseBusV2CandidateInventoryDigest(
      snapshot.candidates
    );
    return {
      phase: 'PREPARE',
      plan_sha256: sha256(planIdentity(reason, snapshot, inventorySha256)),
      inventory_sha256: inventorySha256,
      candidate_count: snapshot.candidates.length,
      candidates: candidateVersions(snapshot.candidates),
      controls: snapshot.controls,
      locks: snapshot.locks,
      staging_state_row_version: snapshot.stagingState.row_version,
      staging_refs: snapshot.stagingRefs,
      mode: snapshot.mode,
      executed: false,
      deregistration_id: null,
      physical_staging_presence: 'UNKNOWN_UNCHANGED'
    };
  }

  private assertExpectedPlan(
    plan: ReleaseBusV2CandidateDeregistrationPlan,
    input: ReleaseBusV2CandidateDeregistrationExecuteInput
  ): void {
    if (
      plan.plan_sha256 !== input.expected_plan_sha256 ||
      plan.inventory_sha256 !== input.expected_inventory_sha256 ||
      plan.staging_state_row_version !==
        input.expected_staging_state_row_version ||
      !sameJson(plan.candidates, input.expected_candidates) ||
      !sameJson(plan.controls, input.expected_controls) ||
      !sameJson(plan.locks, input.expected_locks) ||
      !sameStagingRefs(plan.staging_refs, input.expected_staging_refs)
    )
      throw new ReleaseBusV2CandidateDeregistrationError(
        'CONFLICT',
        'Candidate deregistration plan is stale; prepare a new exact inventory'
      );
  }

  private normalizeReason(reason: string): string {
    const normalized = reason.trim();
    if (normalized.length < 3 || normalized.length > 1000)
      throw new ReleaseBusV2CandidateDeregistrationError(
        'BAD_REQUEST',
        'Candidate deregistration reason must be between 3 and 1000 characters'
      );
    return normalized;
  }

  private async failClosed<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (isReleaseBusV2CandidateDeregistrationError(error)) throw error;
      throw new ReleaseBusV2CandidateDeregistrationError(
        'UNAVAILABLE',
        'Candidate deregistration safety could not be proven; no new action is authorized'
      );
    }
  }
}

export const releaseBusV2CandidateDeregistrationService =
  new ReleaseBusV2CandidateDeregistrationService();
