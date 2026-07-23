import type { Handler } from 'aws-lambda';
import {
  DescribeExecutionCommand,
  SFNClient,
  StartExecutionCommand
} from '@aws-sdk/client-sfn';
import {
  GetFunctionConfigurationCommand,
  LambdaClient,
  ListVersionsByFunctionCommand
} from '@aws-sdk/client-lambda';
import * as sentryContext from '@/sentry.context';
import { doInDbContext } from '@/secrets';
import { Logger } from '@/logging';
import { getReleaseBusMode } from '@/releaseBus/release-bus.config';
import { releaseBusGitHubApp } from '@/releaseBus/release-bus.github-app';
import { releaseBusRepository } from '@/releaseBus/release-bus.repository';
import {
  RECONCILABLE_CANDIDATE_STATUSES,
  releaseBusService
} from '@/releaseBus/release-bus.service';
import { advanceReleaseTrain } from '@/releaseBus/worker';
import { publishReleaseBusMetrics } from '@/releaseBus/release-bus.metrics';
import * as releaseEntities from '@/entities/entities';
import {
  releaseBusV2Branch,
  releaseBusV2Reconciler
} from '@/releaseBusV2/release-bus-v2.reconciler';
import { releaseBusV2Repository } from '@/releaseBusV2/release-bus-v2.repository';

const logger = Logger.get('RELEASE_BUS');
const lambdaClient = new LambdaClient({});
const stepFunctionsClient = new SFNClient({});
const entities = Object.values(releaseEntities).filter(
  (value) => typeof value === 'function'
);

const TERMINAL_TRAIN_STATUSES = new Set([
  'COMPLETED',
  'FAILED',
  'ROLLED_BACK',
  'CANCELLED'
]);
const TERMINAL_V2_TRAIN_STATUSES = new Set([
  'STAGING_VALIDATED',
  'PRODUCTION_DEPLOYED',
  'FAILED',
  'CANCELLED'
]);

async function reconcileQueuedCandidateHeads(): Promise<void> {
  const queued = await releaseBusRepository.listCandidates(
    [...RECONCILABLE_CANDIDATE_STATUSES],
    500,
    {}
  );
  for (const candidate of queued) {
    const remoteHead = await releaseBusGitHubApp.resolveRefIfExists(
      candidate.repository,
      candidate.branch_name
    );
    if (remoteHead === candidate.head_sha) continue;
    await releaseBusService.invalidateBranch(
      candidate.repository,
      candidate.branch_name,
      remoteHead ?? 'deleted',
      'release-bus-reconciler'
    );
  }
}

async function publishStarterSnapshot(
  activeTrain: Awaited<ReturnType<typeof releaseBusRepository.findTrain>>
): Promise<void> {
  const [stagingReady, productionReady, blocked, quarantined] =
    await Promise.all([
      releaseBusRepository.listCandidates(['READY_FOR_STAGING'], 500, {}),
      releaseBusRepository.listCandidates(['READY_FOR_PRODUCTION'], 500, {}),
      releaseBusRepository.listCandidates(['BLOCKED'], 500, {}),
      releaseBusRepository.listCandidates(['QUARANTINED'], 500, {})
    ]);
  const oldestReadyAt = [...stagingReady, ...productionReady]
    .map((candidate) =>
      Number(candidate.production_ready_at ?? candidate.staging_ready_at)
    )
    .filter(Number.isFinite)
    .sort((a, b) => a - b)[0];
  await publishReleaseBusMetrics([
    { MetricName: 'StagingQueueDepth', Value: stagingReady.length },
    { MetricName: 'ProductionQueueDepth', Value: productionReady.length },
    { MetricName: 'BlockedCandidateCount', Value: blocked.length },
    { MetricName: 'QuarantinedCandidateCount', Value: quarantined.length },
    {
      MetricName: 'OldestReadyAgeSeconds',
      Unit: 'Seconds',
      Value: oldestReadyAt ? (Date.now() - oldestReadyAt) / 1000 : 0
    },
    {
      MetricName: 'ActiveTrainAgeSeconds',
      Unit: 'Seconds',
      Value: activeTrain
        ? (Date.now() - Number(activeTrain.started_at)) / 1000
        : 0
    }
  ]);
}

function executionArnForName(stateMachineArn: string, name: string): string {
  return `${stateMachineArn.replace(':stateMachine:', ':execution:')}:${name}`;
}

async function currentPublishedWorker(): Promise<{
  readonly arn: string;
  readonly version: string;
}> {
  const functionName =
    process.env.RELEASE_BUS_WORKER_FUNCTION_NAME ?? 'releaseBusWorker';
  const configuration = await lambdaClient.send(
    new GetFunctionConfigurationCommand({ FunctionName: functionName })
  );
  if (!configuration.CodeSha256)
    throw new Error('Release Bus worker has no deployed code hash');
  let marker: string | undefined;
  const matches: Array<{ arn: string; version: string }> = [];
  do {
    const page = await lambdaClient.send(
      new ListVersionsByFunctionCommand({
        FunctionName: functionName,
        Marker: marker,
        MaxItems: 50
      })
    );
    for (const version of page.Versions ?? []) {
      if (
        version.Version &&
        version.Version !== '$LATEST' &&
        version.FunctionArn &&
        version.CodeSha256 === configuration.CodeSha256
      ) {
        matches.push({ arn: version.FunctionArn, version: version.Version });
      }
    }
    marker = page.NextMarker;
  } while (marker);
  const selected = matches.sort(
    (a, b) => Number(b.version) - Number(a.version)
  )[0];
  if (!selected)
    throw new Error(
      'No published Release Bus worker version matches the deployed code'
    );
  return selected;
}

async function publishedWorkerVersion(version: string): Promise<{
  readonly arn: string;
  readonly version: string;
}> {
  if (!/^[0-9]+$/.test(version)) return currentPublishedWorker();
  const configuration = await lambdaClient.send(
    new GetFunctionConfigurationCommand({
      FunctionName:
        process.env.RELEASE_BUS_WORKER_FUNCTION_NAME ?? 'releaseBusWorker',
      Qualifier: version
    })
  );
  if (!configuration.FunctionArn)
    throw new Error(`Published Release Bus worker ${version} has no ARN`);
  return { arn: configuration.FunctionArn, version };
}

const starter: Handler = async () =>
  doInDbContext(
    async () => {
      const mode = getReleaseBusMode();
      if (mode === 'OFF') return { mode, started: false };
      await reconcileQueuedCandidateHeads();
      const activeTrain = (await releaseBusRepository.listTrains(500, {})).find(
        (train) => !TERMINAL_TRAIN_STATUSES.has(train.status)
      );
      await publishStarterSnapshot(activeTrain ?? null);
      let restartReason: string | null = null;
      if (activeTrain?.state_machine_execution_arn) {
        try {
          const execution = await stepFunctionsClient.send(
            new DescribeExecutionCommand({
              executionArn: activeTrain.state_machine_execution_arn
            })
          );
          if (execution.status === 'RUNNING') {
            return {
              mode,
              started: false,
              active_train_id: activeTrain.id,
              execution_arn: activeTrain.state_machine_execution_arn
            };
          }
          restartReason = `Previous Step Functions execution became ${execution.status ?? 'terminal'} before the train reached a terminal state`;
        } catch (error) {
          restartReason = `Previous Step Functions execution could not be reconciled: ${
            error instanceof Error ? error.message : 'unknown error'
          }`;
        }
      }
      let train = activeTrain ?? null;
      if (!train) {
        const [frontendMain, backendMain, frontendStaging, backendStaging] =
          await Promise.all([
            releaseBusGitHubApp.resolveRef('frontend', 'main'),
            releaseBusGitHubApp.resolveRef('backend', 'main'),
            releaseBusGitHubApp.resolveRef('frontend', '1a-staging'),
            releaseBusGitHubApp.resolveRef('backend', '1a-staging')
          ]);
        const productionReady = await releaseBusRepository.listCandidates(
          ['READY_FOR_PRODUCTION'],
          500,
          {}
        );
        const productionShadowed =
          mode === 'SHADOW'
            ? new Set(
                await releaseBusRepository.listCandidateIdsWithEvidence(
                  productionReady.map((candidate) => candidate.id),
                  'CANDIDATE_SHADOW_EVALUATED_PRODUCTION',
                  {}
                )
              )
            : new Set<string>();
        const hasUnshadowedProduction = productionReady.some(
          (candidate) => !productionShadowed.has(candidate.id)
        );
        const lane =
          (mode === 'PRODUCTION' && productionReady.length > 0) ||
          (mode === 'SHADOW' && hasUnshadowedProduction)
            ? 'PRODUCTION'
            : 'STAGING';
        let excludedCandidateIds: string[] = [];
        if (mode === 'SHADOW') {
          const ready =
            lane === 'PRODUCTION'
              ? productionReady
              : await releaseBusRepository.listCandidates(
                  ['READY_FOR_STAGING'],
                  500,
                  {}
                );
          excludedCandidateIds =
            await releaseBusRepository.listCandidateIdsWithEvidence(
              ready.map((candidate) => candidate.id),
              `CANDIDATE_SHADOW_EVALUATED_${lane}`,
              {}
            );
        }
        train = await releaseBusService.freezeNextTrain({
          lane,
          owner: `starter:${process.env.AWS_LAMBDA_LOG_STREAM_NAME ?? 'local'}`,
          frontendBaseSha:
            lane === 'PRODUCTION' ? frontendMain : frontendStaging,
          backendBaseSha: lane === 'PRODUCTION' ? backendMain : backendStaging,
          excludedCandidateIds,
          allowShadowDependencyEvidence: mode === 'SHADOW'
        });
      }
      if (!train) return { mode, started: false };
      const stateMachineArn = process.env.RELEASE_BUS_STATE_MACHINE_ARN;
      if (!stateMachineArn)
        throw new Error('RELEASE_BUS_STATE_MACHINE_ARN is not configured');
      const executionName = restartReason
        ? `release-train-${train.id}-resume-${train.row_version}`
        : `release-train-${train.id}`;
      const executionArn = executionArnForName(stateMachineArn, executionName);
      let worker = train.worker_version
        ? await publishedWorkerVersion(train.worker_version)
        : await currentPublishedWorker();
      if (
        !(await releaseBusRepository.reserveStateMachineExecution(
          train.id,
          train.row_version,
          executionArn,
          worker.version,
          {}
        ))
      ) {
        throw new Error(
          `Release train ${train.id} changed before its execution could be reserved`
        );
      }
      if (restartReason) {
        await releaseBusRepository.appendEvent(
          {
            trainId: train.id,
            eventType: 'STATE_MACHINE_EXECUTION_RESTARTED',
            payload: {
              reason: restartReason,
              execution_arn: executionArn,
              worker_version: worker.version
            }
          },
          {}
        );
      }
      try {
        const response = await stepFunctionsClient.send(
          new StartExecutionCommand({
            stateMachineArn,
            name: executionName,
            input: JSON.stringify({
              train_id: train.id,
              worker_arn: worker.arn
            })
          })
        );
        if (response.executionArn && response.executionArn !== executionArn)
          throw new Error(
            'Step Functions returned an unexpected execution ARN'
          );
      } catch (error) {
        if (
          !error ||
          typeof error !== 'object' ||
          !('name' in error) ||
          error.name !== 'ExecutionAlreadyExists'
        )
          throw error;
        const existing = await stepFunctionsClient.send(
          new DescribeExecutionCommand({ executionArn })
        );
        if (existing.status !== 'RUNNING')
          throw new Error(
            `Reserved Step Functions execution ${executionName} is ${existing.status ?? 'terminal'}`
          );
        const existingInput = JSON.parse(existing.input ?? '{}') as {
          worker_arn?: string;
        };
        if (existingInput.worker_arn) {
          const version = existingInput.worker_arn.split(':').pop();
          if (version && /^[0-9]+$/.test(version))
            worker = { arn: existingInput.worker_arn, version };
        }
      }
      return {
        mode,
        started: true,
        train_id: train.id,
        execution_arn: executionArn
      };
    },
    { logger, entities, skipRedis: true }
  );

const worker: Handler<{ train_id: string; worker_arn: string }> = async (
  event
) => {
  const result = await doInDbContext(
    () => advanceReleaseTrain(event.train_id),
    {
      logger,
      entities,
      skipRedis: true
    }
  );
  return { ...result, worker_arn: event.worker_arn };
};

const cleaner: Handler = async () =>
  doInDbContext(
    async () => {
      const branchRetentionDays = Number(
        process.env.RELEASE_BUS_BRANCH_RETENTION_DAYS ?? '7'
      );
      if (
        !Number.isSafeInteger(branchRetentionDays) ||
        branchRetentionDays < 1 ||
        branchRetentionDays > 365
      )
        throw new Error('Invalid release-bus branch retention');
      const retentionMs = branchRetentionDays * 24 * 60 * 60 * 1000;
      const historyRetentionDays = Number(
        process.env.RELEASE_BUS_HISTORY_RETENTION_DAYS ?? '30'
      );
      if (
        !Number.isSafeInteger(historyRetentionDays) ||
        historyRetentionDays < 1 ||
        historyRetentionDays > 365
      )
        throw new Error('Invalid release-bus history retention');
      const historyRetentionMs = historyRetentionDays * 24 * 60 * 60 * 1000;
      const trains = await releaseBusRepository.listTrains(500, {});
      const v2Trains = await releaseBusV2Repository.listTrains(500, {});
      const protectedRefs = new Set(
        trains
          .filter((train) => !TERMINAL_TRAIN_STATUSES.has(train.status))
          .flatMap((train) => [
            train.frontend_release_branch,
            train.backend_release_branch
          ])
          .filter((ref): ref is string => Boolean(ref))
      );
      const deleted: string[] = [];
      for (const repository of ['frontend', 'backend'] as const) {
        const refs = await releaseBusGitHubApp.listReleaseBusRefs(repository);
        for (const ref of refs) {
          if (protectedRefs.has(ref.ref)) continue;
          const committedAt = await releaseBusGitHubApp.commitTimestamp(
            repository,
            ref.sha
          );
          if (Date.now() - committedAt < retentionMs) continue;
          await releaseBusGitHubApp.deleteReleaseBusRef(repository, ref.ref);
          deleted.push(`${repository}:${ref.ref}`);
        }
        const protectedV2Refs = new Set(
          v2Trains
            .filter((train) => !TERMINAL_V2_TRAIN_STATUSES.has(train.status))
            .map((train) => releaseBusV2Branch(train, repository))
        );
        const v2Refs =
          await releaseBusGitHubApp.listReleaseBusV2Refs(repository);
        for (const ref of v2Refs) {
          if (protectedV2Refs.has(ref.ref)) continue;
          const committedAt = await releaseBusGitHubApp.commitTimestamp(
            repository,
            ref.sha
          );
          if (Date.now() - committedAt < retentionMs) continue;
          await releaseBusGitHubApp.deleteReleaseBusV2Ref(repository, ref.ref);
          deleted.push(`${repository}:${ref.ref}`);
        }
      }
      const history = await releaseBusService.pruneTerminalHistory(
        Date.now() - historyRetentionMs
      );
      return { deleted, history };
    },
    { logger, entities, skipRedis: true }
  );

const v2Reconciler: Handler = async (_event, context) =>
  doInDbContext(() => releaseBusV2Reconciler.runOnce(context.awsRequestId), {
    logger,
    entities,
    skipRedis: true
  });

export const starterHandler = sentryContext.wrapLambdaHandler(starter);
export const workerHandler = sentryContext.wrapLambdaHandler(worker);
export const cleanerHandler = sentryContext.wrapLambdaHandler(cleaner);
export const v2ReconcilerHandler =
  sentryContext.wrapLambdaHandler(v2Reconciler);
