import {
  deriveReleaseBusV2LaneStates,
  getReleaseBusV2Mode
} from '@/releaseBusV2/release-bus-v2.config';
import {
  releaseBusGitHubApp,
  type ReleaseBusWorkflowRunIdentity
} from '@/releaseBusV2/release-bus-v2.github-app';
import {
  releaseBusV2Repository,
  type ReleaseBusV2ControlRecord,
  type ReleaseBusV2LockRecord
} from '@/releaseBusV2/release-bus-v2.repository';
import type {
  ReleaseBusV2AutomationLane,
  ReleaseBusV2Lane,
  ReleaseBusV2Mode,
  ReleaseBusV2OperationRecord,
  ReleaseBusV2Repository,
  ReleaseBusV2TrainRecord
} from '@/releaseBusV2/release-bus-v2.types';

export type ReleaseBusV2ManualDeploymentEnvironment = 'staging' | 'prod';

export type ReleaseBusV2ManualDeploymentAuthorizationInput = {
  readonly repository: ReleaseBusV2Repository;
  readonly environment: ReleaseBusV2ManualDeploymentEnvironment;
  readonly service: string;
  readonly workflow_run_id: string;
  readonly workflow_run_attempt: number;
  readonly source_ref: string;
  readonly source_sha: string;
};

export type ReleaseBusV2ManualDeploymentAuthorization = {
  readonly ready: true;
  readonly mode: 'manual';
  readonly lane: ReleaseBusV2AutomationLane;
  readonly repository: ReleaseBusV2Repository;
  readonly environment: ReleaseBusV2ManualDeploymentEnvironment;
  readonly service: string;
  readonly workflow_run_id: string;
  readonly workflow_run_attempt: number;
  readonly source_ref: string;
  readonly source_sha: string;
};

export class ReleaseBusV2ManualDeploymentError extends Error {
  public constructor(
    public readonly code: 'CONFLICT' | 'UNAVAILABLE',
    message: string
  ) {
    super(message);
    this.name = 'ReleaseBusV2ManualDeploymentError';
  }
}

export function isReleaseBusV2ManualDeploymentError(
  error: unknown
): error is ReleaseBusV2ManualDeploymentError {
  if (error instanceof ReleaseBusV2ManualDeploymentError) return true;
  if (
    !(error instanceof Error) ||
    error.name !== 'ReleaseBusV2ManualDeploymentError'
  )
    return false;
  return ['CONFLICT', 'UNAVAILABLE'].includes(
    String((error as { code?: unknown }).code)
  );
}

export type ReleaseBusV2ManualDeploymentDependencies = {
  readonly getMode: () => ReleaseBusV2Mode;
  readonly listControls: () => Promise<ReleaseBusV2ControlRecord[]>;
  readonly listLocks: () => Promise<ReleaseBusV2LockRecord[]>;
  readonly listActiveTrains: () => Promise<ReleaseBusV2TrainRecord[]>;
  readonly listNonterminalOperationsForLanes: (
    lanes: readonly ReleaseBusV2Lane[]
  ) => Promise<ReleaseBusV2OperationRecord[]>;
  readonly getWorkflowRunIdentity: (
    repository: ReleaseBusV2Repository,
    workflowRunId: string
  ) => Promise<ReleaseBusWorkflowRunIdentity>;
  readonly resolveRef: (
    repository: ReleaseBusV2Repository,
    ref: string
  ) => Promise<string>;
  readonly hasActiveStagingMutationOrE2ERun: (
    repository: ReleaseBusV2Repository,
    ignoredRunIds?: readonly string[],
    ignoreManualBackendDeployments?: boolean
  ) => Promise<boolean>;
  readonly hasActiveProductionMutationOrE2ERun: (
    repository: ReleaseBusV2Repository,
    ignoredRunIds?: readonly string[]
  ) => Promise<boolean>;
};

const dependencies: ReleaseBusV2ManualDeploymentDependencies = {
  getMode: getReleaseBusV2Mode,
  listControls: () => releaseBusV2Repository.listControls({}),
  listLocks: () => releaseBusV2Repository.listLocks({}),
  listActiveTrains: () => releaseBusV2Repository.listActiveTrains({}),
  listNonterminalOperationsForLanes: (lanes) =>
    releaseBusV2Repository.listNonterminalOperationsForLanes(lanes, {}),
  getWorkflowRunIdentity: (repository, workflowRunId) =>
    releaseBusGitHubApp.getWorkflowRunIdentity(repository, workflowRunId),
  resolveRef: (repository, ref) =>
    releaseBusGitHubApp.resolveRef(repository, ref),
  hasActiveStagingMutationOrE2ERun: (
    repository,
    ignoredRunIds,
    ignoreManualBackendDeployments
  ) =>
    releaseBusGitHubApp.hasActiveStagingMutationOrE2ERun(
      repository,
      ignoredRunIds,
      ignoreManualBackendDeployments
    ),
  hasActiveProductionMutationOrE2ERun: (repository, ignoredRunIds) =>
    releaseBusGitHubApp.hasActiveProductionMutationOrE2ERun(
      repository,
      ignoredRunIds
    )
};

function targetLane(
  environment: ReleaseBusV2ManualDeploymentEnvironment
): ReleaseBusV2AutomationLane {
  return environment === 'staging' ? 'STAGING' : 'PRODUCTION';
}

function targetTrainLanes(
  environment: ReleaseBusV2ManualDeploymentEnvironment
): readonly ReleaseBusV2Lane[] {
  return environment === 'staging'
    ? ['STAGING', 'PRODUCTION_QUALIFICATION']
    : ['PRODUCTION'];
}

function targetLockName(
  environment: ReleaseBusV2ManualDeploymentEnvironment
): string {
  return environment === 'staging'
    ? 'staging-environment'
    : 'production-environment';
}

function conflict(message: string): never {
  throw new ReleaseBusV2ManualDeploymentError('CONFLICT', message);
}

function assertWorkflowIdentity(
  input: ReleaseBusV2ManualDeploymentAuthorizationInput,
  identity: ReleaseBusWorkflowRunIdentity
): void {
  const expectedSourceRef =
    input.environment === 'staging' ? '1a-staging' : 'main';
  if (
    identity.attempt !== input.workflow_run_attempt ||
    identity.status !== 'in_progress' ||
    identity.conclusion !== null ||
    identity.headBranch !== input.source_ref ||
    identity.headSha !== input.source_sha ||
    input.source_ref !== expectedSourceRef
  )
    conflict('Manual deployment workflow identity does not match this run');

  if (input.repository === 'backend') {
    const expectedTitle = `Deploy ${input.service} to ${input.environment} [manual]`;
    if (
      identity.event !== 'workflow_dispatch' ||
      identity.path !== '.github/workflows/deploy.yml' ||
      !['Deploy a service', expectedTitle].includes(identity.name) ||
      identity.displayTitle !== expectedTitle
    )
      conflict('Manual backend deployment workflow identity is invalid');
    return;
  }

  const expected =
    input.environment === 'staging'
      ? {
          path: '.github/workflows/deploy-staging.yml',
          name: 'Web Deploy - STAGING',
          sourceRef: '1a-staging',
          events: ['push', 'workflow_dispatch']
        }
      : {
          path: '.github/workflows/build-upload-deploy-prod.yml',
          name: 'Web Deploy - PROD',
          sourceRef: 'main',
          events: ['workflow_dispatch']
        };
  if (
    identity.path !== expected.path ||
    identity.name !== expected.name ||
    identity.headBranch !== expected.sourceRef ||
    !expected.events.includes(identity.event)
  )
    conflict('Manual frontend deployment workflow identity is invalid');
}

export class ReleaseBusV2ManualDeploymentGuard {
  public constructor(
    private readonly deps: ReleaseBusV2ManualDeploymentDependencies = dependencies
  ) {}

  public async authorizeWorkflow(
    input: ReleaseBusV2ManualDeploymentAuthorizationInput
  ): Promise<ReleaseBusV2ManualDeploymentAuthorization> {
    return this.failClosed(async () => {
      const identity = await this.deps.getWorkflowRunIdentity(
        input.repository,
        input.workflow_run_id
      );
      assertWorkflowIdentity(input, identity);
      const currentHead = await this.deps.resolveRef(
        input.repository,
        input.source_ref
      );
      if (currentHead !== input.source_sha)
        conflict(
          `Manual ${input.environment} deployment source is not the exact current ${input.source_ref} head`
        );
      await this.assertLaneReady(input.environment, {
        repository: input.repository,
        workflowRunId: input.workflow_run_id
      });
      return {
        ready: true,
        mode: 'manual',
        lane: targetLane(input.environment),
        ...input
      };
    });
  }

  public async assertDispatchReady(
    environment: ReleaseBusV2ManualDeploymentEnvironment,
    repository: ReleaseBusV2Repository
  ): Promise<void> {
    return this.failClosed(() =>
      this.assertLaneReady(environment, { repository })
    );
  }

  private async assertLaneReady(
    environment: ReleaseBusV2ManualDeploymentEnvironment,
    currentRun?: {
      readonly repository: ReleaseBusV2Repository;
      readonly workflowRunId?: string;
    }
  ): Promise<void> {
    const mode = this.deps.getMode();
    const controls = await this.deps.listControls();
    const lane = targetLane(environment);
    const laneState = deriveReleaseBusV2LaneStates(mode, controls).find(
      (state) => state.lane === lane
    );
    if (laneState?.status !== 'OFF' || laneState.changeable !== true)
      conflict(
        `Manual ${environment} deployment requires the independently paused ${lane} lane with no hidden hard stop`
      );

    const lanes = targetTrainLanes(environment);
    const ignoredRunIds = (repository: ReleaseBusV2Repository) =>
      currentRun?.repository === repository && currentRun.workflowRunId
        ? [currentRun.workflowRunId]
        : [];
    const activeWorkflow = (
      repository: ReleaseBusV2Repository
    ): Promise<boolean> => {
      if (environment !== 'staging')
        return this.deps.hasActiveProductionMutationOrE2ERun(
          repository,
          ignoredRunIds(repository)
        );
      const ignored = ignoredRunIds(repository);
      if (repository === 'backend' && currentRun?.repository === 'backend')
        return this.deps.hasActiveStagingMutationOrE2ERun(
          repository,
          ignored,
          true
        );
      return this.deps.hasActiveStagingMutationOrE2ERun(repository, ignored);
    };
    const [
      locks,
      activeTrains,
      activeOperations,
      backendActive,
      frontendActive
    ] = await Promise.all([
      this.deps.listLocks(),
      this.deps.listActiveTrains(),
      this.deps.listNonterminalOperationsForLanes(lanes),
      activeWorkflow('backend'),
      activeWorkflow('frontend')
    ]);

    const lockName = targetLockName(environment);
    const targetLocks = locks.filter((lock) => lock.name === lockName);
    if (targetLocks.length !== 1)
      throw new Error(`Release Bus v2 ${lockName} lock is unavailable`);
    const lock = targetLocks[0];
    if (
      lock.owner_train_id !== null ||
      lock.lease_owner !== null ||
      lock.lease_token !== null
    )
      conflict(`Manual ${environment} deployment environment lock is held`);
    if (activeTrains.some((train) => lanes.includes(train.lane)))
      conflict(`Manual ${environment} deployment has an active train`);
    if (activeOperations.length > 0)
      conflict(`Manual ${environment} deployment has a nonterminal operation`);
    if (backendActive || frontendActive)
      conflict(
        `Manual ${environment} deployment has an active mutation or E2E workflow`
      );
  }

  private async failClosed<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (isReleaseBusV2ManualDeploymentError(error)) throw error;
      throw new ReleaseBusV2ManualDeploymentError(
        'UNAVAILABLE',
        'Manual deployment readiness could not be proven; deployment remains blocked'
      );
    }
  }
}

export const releaseBusV2ManualDeploymentGuard =
  new ReleaseBusV2ManualDeploymentGuard();
