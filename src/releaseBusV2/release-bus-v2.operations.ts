import { isDeepStrictEqual } from 'node:util';
import {
  releaseBusGitHubApp,
  ReleaseBusGitHubInfrastructureError
} from '@/releaseBus/release-bus.github-app';
import {
  releaseBusV2Repository,
  type ReleaseBusV2Repository as ReleaseBusV2RepositoryClass
} from '@/releaseBusV2/release-bus-v2.repository';
import type {
  ReleaseBusV2FailureClass,
  ReleaseBusV2OperationRecord,
  ReleaseBusV2Repository
} from '@/releaseBusV2/release-bus-v2.types';

export type ReleaseBusV2WorkflowSpec = {
  readonly idempotencyKey: string;
  readonly trainId: string;
  readonly operationType: string;
  readonly repository: ReleaseBusV2Repository;
  readonly workflow: string;
  readonly ref: string;
  readonly environment: string;
  readonly service: string | null;
  readonly expectedSha: string;
  readonly artifactDigest: string | null;
  readonly inputs: Readonly<Record<string, string>>;
  readonly maxAttempts?: number;
  readonly betaInfrastructureFailureInjection?: {
    readonly candidateId: string;
    readonly testId: string;
  };
};

export type ReleaseBusV2Authorization = {
  readonly train_id: string;
  readonly operation_key: string;
  readonly workflow_run_id: string;
  readonly artifact_run_id: string | null;
  readonly repository: ReleaseBusV2Repository;
  readonly environment: string;
  readonly service: string | null;
  readonly expected_sha: string;
  readonly artifact_digest: string | null;
};

export type ReleaseBusV2Progress = {
  readonly train_id: string;
  readonly operation_key: string;
  readonly workflow_run_id: string;
  readonly phase: string;
  readonly status: 'RUNNING' | 'SUCCEEDED' | 'FAILED';
  readonly failure_class?: string | null;
  readonly failure_phase?: string | null;
  readonly retryable?: boolean;
  readonly summary?: unknown;
  readonly backend_evidence?: unknown;
  readonly stages?: unknown;
  readonly jest?: unknown;
  readonly [key: string]: unknown;
};

function classifyFailure(
  value: string | null | undefined
): ReleaseBusV2FailureClass {
  const normalized = value?.toUpperCase() ?? '';
  if (normalized.includes('INFRASTRUCTURE') || normalized.includes('TRANSIENT'))
    return 'INFRASTRUCTURE';
  if (
    normalized.includes('CONTROL') ||
    normalized.includes('PROTOCOL') ||
    normalized.includes('CONFIG')
  )
    return 'CONTROL_PLANE';
  if (normalized.includes('DEPLOY')) return 'DEPLOYMENT';
  if (normalized.includes('E2E')) return 'E2E';
  if (normalized.includes('CANDIDATE')) return 'CANDIDATE';
  return 'INTERACTION';
}

function retryDelayMs(attempt: number): number {
  return Math.min(30_000 * 2 ** Math.max(0, attempt - 1), 5 * 60_000);
}

function isGitHubInfrastructureError(error: unknown): error is Error {
  const infrastructureType: unknown = ReleaseBusGitHubInfrastructureError;
  return (
    error instanceof Error &&
    ((typeof infrastructureType === 'function' &&
      error instanceof infrastructureType) ||
      error.name === 'ReleaseBusGitHubInfrastructureError' ||
      error.constructor.name === 'ReleaseBusGitHubInfrastructureError')
  );
}

function attemptOperationKey(idempotencyKey: string, attempt: number): string {
  return `${idempotencyKey}:a${attempt}`;
}

function parseAttemptOperationKey(value: string): {
  readonly idempotencyKey: string;
  readonly attempt: number;
} {
  const match = /^(.*):a([1-9]\d{0,8})$/.exec(value);
  if (!match?.[1]) throw new Error('Invalid Release Bus v2 attempt key');
  return { idempotencyKey: match[1], attempt: Number(match[2]) };
}

function parseStoredJson<T>(value: unknown): T | null {
  if (value === null) return null;
  return typeof value === 'string' ? (JSON.parse(value) as T) : (value as T);
}

function progressArtifactDigest(progress: ReleaseBusV2Progress): string | null {
  if (!progress.summary || typeof progress.summary !== 'object') return null;
  const digest = (progress.summary as { artifact_digest?: unknown })
    .artifact_digest;
  return typeof digest === 'string' && /^[a-f0-9]{64}$/.test(digest)
    ? digest
    : null;
}

function transportRetryState(result: unknown): {
  readonly retry_same_attempt: true;
  readonly transport_failures: number;
} | null {
  const parsed = parseStoredJson<{
    retry_same_attempt?: unknown;
    transport_failures?: unknown;
  }>(result);
  return parsed?.retry_same_attempt === true &&
    Number.isSafeInteger(parsed.transport_failures) &&
    Number(parsed.transport_failures) > 0
    ? {
        retry_same_attempt: true,
        transport_failures: Number(parsed.transport_failures)
      }
    : null;
}

function unreportedWorkflowFailureClass(
  _operationType: string,
  conclusion: string | null
): ReleaseBusV2FailureClass {
  if (
    ['cancelled', 'timed_out', 'stale', 'startup_failure'].includes(
      conclusion ?? ''
    )
  )
    return 'INFRASTRUCTURE';
  // Every v2 workflow that reaches its trusted authorization boundary emits a
  // structured terminal report. A completed run without one is therefore a
  // protocol/control-plane failure, not evidence against a candidate.
  return 'CONTROL_PLANE';
}

export class ReleaseBusV2Operations {
  public constructor(
    private readonly repository: ReleaseBusV2RepositoryClass = releaseBusV2Repository
  ) {}

  public async reconcileWorkflow(
    spec: ReleaseBusV2WorkflowSpec
  ): Promise<ReleaseBusV2OperationRecord> {
    let operation = await this.repository.getOrCreateOperation(
      {
        idempotencyKey: spec.idempotencyKey,
        trainId: spec.trainId,
        operationType: spec.operationType,
        repository: spec.repository,
        service: spec.service,
        environment: spec.environment,
        expectedSha: spec.expectedSha,
        artifactDigest: spec.artifactDigest,
        request: {
          workflow: spec.workflow,
          ref: spec.ref,
          inputs: spec.inputs,
          beta_infrastructure_failure_injection:
            spec.betaInfrastructureFailureInjection ?? null
        },
        maxAttempts: spec.maxAttempts
      },
      {}
    );
    if (['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(operation.status))
      return operation;
    if (
      operation.status === 'RETRY_WAIT' &&
      Number(operation.next_retry_at) > Date.now()
    )
      return operation;
    if (operation.status === 'RETRY_WAIT') {
      const sameAttempt = transportRetryState(operation.result_json);
      if (!sameAttempt && operation.attempt >= operation.max_attempts) {
        await this.update(operation, {
          status: 'FAILED',
          completedAt: Date.now(),
          failureClass: operation.failure_class ?? 'INFRASTRUCTURE',
          failureMessage:
            operation.failure_message ?? 'Infrastructure retry budget exhausted'
        });
        return (
          (await this.repository.findOperation(spec.idempotencyKey, {})) ??
          operation
        );
      }
      await this.update(operation, {
        status: 'PENDING',
        attempt: sameAttempt ? operation.attempt : operation.attempt + 1,
        externalId: null,
        result: sameAttempt ? undefined : null,
        nextRetryAt: null,
        failureClass: null,
        failureMessage: null,
        completedAt: null
      });
      operation =
        (await this.repository.findOperation(spec.idempotencyKey, {})) ??
        operation;
    }

    if (
      operation.status === 'PENDING' &&
      operation.attempt === 1 &&
      operation.external_id === null &&
      spec.betaInfrastructureFailureInjection
    ) {
      const nextRetryAt = Date.now() + retryDelayMs(operation.attempt);
      await this.update(operation, {
        status: 'RETRY_WAIT',
        nextRetryAt,
        failureClass: 'INFRASTRUCTURE',
        failureMessage:
          'Injected operator beta infrastructure failure before dispatch'
      });
      await this.repository.appendEvent(
        {
          trainId: operation.train_id,
          candidateId: spec.betaInfrastructureFailureInjection.candidateId,
          eventType: 'BETA_INFRASTRUCTURE_FAILURE_INJECTED',
          actor: 'release-bus-v2-beta',
          payload: {
            attempt: operation.attempt,
            next_retry_at: nextRetryAt,
            operation_id: operation.id,
            operation_type: operation.operation_type,
            test_id: spec.betaInfrastructureFailureInjection.testId
          }
        },
        {}
      );
      return (
        (await this.repository.findOperation(spec.idempotencyKey, {})) ??
        operation
      );
    }

    const attemptKey = attemptOperationKey(
      operation.idempotency_key,
      operation.attempt
    );
    const dispatchInputs = {
      ...spec.inputs,
      operation_key: attemptKey
    };
    const recoveringTransport = transportRetryState(operation.result_json);
    let run;
    try {
      run = await releaseBusGitHubApp.findWorkflowRun(
        spec.repository,
        spec.workflow,
        attemptKey,
        operation.external_id
      );
      if (!run && operation.status === 'PENDING' && recoveringTransport) {
        // A dispatch response may have been lost. Require one successful GitHub
        // discovery boundary before permitting another dispatch with the same
        // attempt key, so an eventually indexed run wins over a duplicate.
        await this.update(operation, { status: 'PENDING', result: null });
        return (
          (await this.repository.findOperation(spec.idempotencyKey, {})) ??
          operation
        );
      }
      if (!run && operation.status === 'PENDING') {
        await releaseBusGitHubApp.dispatchWorkflow(
          spec.repository,
          spec.workflow,
          spec.ref,
          dispatchInputs
        );
      }
    } catch (error) {
      if (isGitHubInfrastructureError(error))
        return this.deferTransportRetry(operation, error.message);
      throw error;
    }
    if (!run && operation.status === 'PENDING') {
      await this.update(operation, { status: 'DISPATCHED', result: null });
      return (
        (await this.repository.findOperation(spec.idempotencyKey, {})) ??
        operation
      );
    }
    if (!run) return operation;
    if (
      operation.external_id !== String(run.id) ||
      operation.status === 'DISPATCHED'
    ) {
      await this.update(operation, {
        status: 'RUNNING',
        externalId: String(run.id),
        result: transportRetryState(operation.result_json) ? null : undefined
      });
      operation =
        (await this.repository.findOperation(spec.idempotencyKey, {})) ??
        operation;
    }
    if (run.status !== 'completed') return operation;

    const latest =
      (await this.repository.findOperation(spec.idempotencyKey, {})) ??
      operation;
    if (['SUCCEEDED', 'FAILED', 'RETRY_WAIT'].includes(latest.status))
      return latest;
    const failureClass = unreportedWorkflowFailureClass(
      latest.operation_type,
      run.conclusion
    );
    const retry =
      failureClass === 'INFRASTRUCTURE' && latest.attempt < latest.max_attempts;
    await this.update(latest, {
      status: retry ? 'RETRY_WAIT' : 'FAILED',
      externalId: String(run.id),
      nextRetryAt: retry ? Date.now() + retryDelayMs(latest.attempt) : null,
      failureClass,
      failureMessage: `GitHub workflow concluded ${
        run.conclusion ?? 'without a conclusion'
      } without a structured terminal callback`,
      completedAt: retry ? null : Date.now()
    });
    return (
      (await this.repository.findOperation(spec.idempotencyKey, {})) ?? latest
    );
  }

  public async authorize(
    input: ReleaseBusV2Authorization
  ): Promise<{ authorized: true }> {
    const { idempotencyKey, attempt } = parseAttemptOperationKey(
      input.operation_key
    );
    const operation = await this.repository.findOperation(idempotencyKey, {});
    if (
      !operation ||
      operation.train_id !== input.train_id ||
      operation.attempt !== attempt
    )
      throw new Error('Release Bus v2 operation attempt does not exist');
    if (
      !['PENDING', 'DISPATCHED', 'RUNNING', 'RETRY_WAIT'].includes(
        operation.status
      )
    )
      throw new Error(
        `Release Bus v2 operation cannot authorize while ${operation.status}`
      );
    if (
      operation.repository !== input.repository ||
      operation.environment !== input.environment ||
      operation.service !== input.service ||
      operation.expected_sha !== input.expected_sha ||
      operation.artifact_digest !== input.artifact_digest
    )
      throw new Error(
        'Release Bus v2 operation does not match the authorization request'
      );
    if (
      operation.external_id &&
      operation.external_id !== input.workflow_run_id
    )
      throw new Error(
        'Release Bus v2 operation is already bound to another workflow run'
      );
    const request = parseStoredJson<{
      workflow?: string;
      inputs?: Readonly<Record<string, string>>;
    }>(operation.request_json);
    if (!request?.workflow)
      throw new Error('Release Bus v2 operation has no workflow identity');
    const identity = await releaseBusGitHubApp.getWorkflowRunIdentity(
      input.repository,
      input.workflow_run_id
    );
    const expectedWorkflowPath = `.github/workflows/${request.workflow}`;
    if (
      identity.event !== 'workflow_dispatch' ||
      (identity.path !== expectedWorkflowPath &&
        !identity.path.startsWith(`${expectedWorkflowPath}@`)) ||
      !identity.displayTitle.includes(`[${input.operation_key}]`)
    )
      throw new Error('Workflow run identity does not match the v2 operation');
    if ((request.inputs?.artifact_run_id ?? null) !== input.artifact_run_id)
      throw new Error(
        'Release Bus v2 artifact source does not match the dispatched operation'
      );
    if (!operation.external_id || operation.status === 'DISPATCHED') {
      await this.update(operation, {
        status: 'RUNNING',
        externalId: input.workflow_run_id,
        artifactDigest: input.artifact_digest ?? undefined
      });
    }
    return { authorized: true };
  }

  public async reportProgress(
    input: ReleaseBusV2Progress
  ): Promise<{ accepted: true; reused: boolean }> {
    const { idempotencyKey, attempt } = parseAttemptOperationKey(
      input.operation_key
    );
    const operation = await this.repository.findOperation(idempotencyKey, {});
    if (
      !operation ||
      operation.train_id !== input.train_id ||
      operation.attempt !== attempt
    )
      throw new Error('Release Bus v2 operation attempt does not exist');
    if (operation.external_id !== input.workflow_run_id)
      throw new Error(
        'Release Bus v2 progress run does not match the authorized operation'
      );
    const storedResult = parseStoredJson<ReleaseBusV2Progress>(
      operation.result_json
    );
    if (['SUCCEEDED', 'FAILED'].includes(operation.status)) {
      if (isDeepStrictEqual(storedResult, input))
        return { accepted: true, reused: true };
      throw new Error(
        'A different terminal progress report already exists for this v2 operation'
      );
    }
    const terminal = input.status === 'SUCCEEDED' || input.status === 'FAILED';
    const failureClass =
      input.status === 'FAILED' ? classifyFailure(input.failure_class) : null;
    const shouldRetry =
      input.status === 'FAILED' &&
      (failureClass === 'INFRASTRUCTURE' || failureClass === 'DEPLOYMENT') &&
      Boolean(input.retryable) &&
      operation.attempt < operation.max_attempts;
    const artifactDigest = progressArtifactDigest(input);
    if (
      input.status === 'SUCCEEDED' &&
      operation.operation_type.startsWith('PREPARE_ARTIFACT_') &&
      !artifactDigest
    )
      throw new Error(
        'A successful artifact preparation report requires an exact SHA-256 digest'
      );
    await this.update(operation, {
      status: shouldRetry
        ? 'RETRY_WAIT'
        : input.status === 'RUNNING'
          ? 'RUNNING'
          : input.status,
      result: input,
      artifactDigest: artifactDigest ?? undefined,
      nextRetryAt: shouldRetry
        ? Date.now() + retryDelayMs(operation.attempt)
        : null,
      failureClass,
      failureMessage:
        input.status === 'FAILED'
          ? `${input.failure_phase ?? 'workflow'} failed`
          : null,
      completedAt: terminal && !shouldRetry ? Date.now() : null
    });
    return { accepted: true, reused: false };
  }

  private async update(
    operation: ReleaseBusV2OperationRecord,
    fields: Parameters<ReleaseBusV2RepositoryClass['updateOperation']>[2]
  ): Promise<void> {
    if (
      !(await this.repository.updateOperation(
        operation.id,
        operation.row_version,
        fields,
        {}
      ))
    )
      throw new Error('Release Bus v2 operation changed concurrently');
  }

  private async deferTransportRetry(
    operation: ReleaseBusV2OperationRecord,
    message: string
  ): Promise<ReleaseBusV2OperationRecord> {
    const previous = transportRetryState(operation.result_json);
    const failures = (previous?.transport_failures ?? 0) + 1;
    const exhausted = failures >= operation.max_attempts;
    await this.update(operation, {
      status: exhausted ? 'FAILED' : 'RETRY_WAIT',
      result: { retry_same_attempt: true, transport_failures: failures },
      nextRetryAt: exhausted ? null : Date.now() + retryDelayMs(failures),
      failureClass: 'INFRASTRUCTURE',
      failureMessage: exhausted
        ? `GitHub transport retry budget exhausted: ${message}`
        : `GitHub transport is unavailable; discovering the same attempt before retry: ${message}`,
      completedAt: exhausted ? Date.now() : null
    });
    return (
      (await this.repository.findOperation(operation.idempotency_key, {})) ??
      operation
    );
  }
}

export const releaseBusV2Operations = new ReleaseBusV2Operations();
