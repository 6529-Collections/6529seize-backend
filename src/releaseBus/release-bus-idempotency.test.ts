import { buildReleaseOperationKey } from '@/releaseBus/release-bus.idempotency';
import { ReleaseBusRepository } from '@/releaseBus/release-bus.repository';
import type { SqlExecutor } from '@/sql-executor';

describe('release operation idempotency', () => {
  it('builds stable keys for retries', () => {
    const input = {
      trainId: 'train-1',
      revision: 2,
      operation: 'deploy',
      repository: 'backend',
      environment: 'prod',
      service: 'api',
      expectedSha: 'a'.repeat(40)
    };
    expect(buildReleaseOperationKey(input)).toBe(
      buildReleaseOperationKey(input)
    );
    expect(buildReleaseOperationKey(input).length).toBeLessThan(180);
    expect(
      buildReleaseOperationKey({ ...input, expectedSha: 'b'.repeat(40) })
    ).not.toBe(buildReleaseOperationKey(input));
  });

  it('rejects unsafe components', () => {
    expect(() =>
      buildReleaseOperationKey({
        trainId: 'train:bad',
        revision: 1,
        operation: 'deploy'
      })
    ).toThrow('Unsafe');
  });

  it('claims the workflow run and first artifact digest in one conditional write', async () => {
    const execute = jest.fn().mockResolvedValue({ affectedRows: 1 });
    const repository = new ReleaseBusRepository(
      () =>
        ({
          execute,
          getAffectedRows: (result: { affectedRows?: number }) =>
            result.affectedRows ?? 0
        }) as unknown as SqlExecutor
    );

    await expect(
      repository.bindOperationAuthorization(
        'operation-key',
        'workflow-run-1',
        'a'.repeat(64),
        {}
      )
    ).resolves.toBe(true);

    const [sql, params] = execute.mock.calls[0] as [
      string,
      Record<string, unknown>
    ];
    const normalizedSql = sql.trim().split(/\s+/).join(' ');
    expect(normalizedSql).toContain(
      'set external_id = coalesce(external_id, :executionId), artifact_digest = coalesce(artifact_digest, :artifactDigest)'
    );
    expect(normalizedSql).toContain(
      'and (external_id is null or external_id = :executionId)'
    );
    expect(normalizedSql).toContain(
      'and (:artifactDigest is null or artifact_digest is null or artifact_digest = :artifactDigest)'
    );
    expect(params).toMatchObject({
      executionId: 'workflow-run-1',
      artifactDigest: 'a'.repeat(64)
    });
  });

  it('updates workflow progress only from the expected operation version', async () => {
    const execute = jest.fn().mockResolvedValue({ affectedRows: 1 });
    const repository = new ReleaseBusRepository(
      () =>
        ({
          execute,
          getAffectedRows: (result: { affectedRows?: number }) =>
            result.affectedRows ?? 0
        }) as unknown as SqlExecutor
    );

    await expect(
      repository.updateOperationIfVersion(
        'operation-key',
        7,
        {
          status: 'RUNNING',
          resultMetadata: { gate_report: { phase: 'lint' } }
        },
        {}
      )
    ).resolves.toBe(true);

    const [sql, params] = execute.mock.calls[0] as [
      string,
      Record<string, unknown>
    ];
    expect(sql.trim().split(/\s+/).join(' ')).toContain(
      'where operation_key = :operationKey and (:expectedVersion is null or row_version = :expectedVersion)'
    );
    expect(params).toMatchObject({
      operationKey: 'operation-key',
      expectedVersion: 7
    });
  });

  it('advances a train phase only from the expected status', async () => {
    const execute = jest.fn().mockResolvedValue({ affectedRows: 1 });
    const repository = new ReleaseBusRepository(
      () =>
        ({
          execute,
          getAffectedRows: (result: { affectedRows?: number }) =>
            result.affectedRows ?? 0
        }) as unknown as SqlExecutor
    );

    await expect(
      repository.advanceTrainPhase(
        'train-1',
        'DEPLOYING_FRONTEND_PRODUCTION',
        'PRODUCTION_E2E_RUNNING',
        {}
      )
    ).resolves.toBe(true);

    const [sql, params] = execute.mock.calls[0] as [
      string,
      Record<string, unknown>
    ];
    expect(sql.trim().split(/\s+/).join(' ')).toContain(
      'where id = :id and status = :expectedStatus'
    );
    expect(params).toMatchObject({
      id: 'train-1',
      expectedStatus: 'DEPLOYING_FRONTEND_PRODUCTION',
      nextStatus: 'PRODUCTION_E2E_RUNNING'
    });
  });

  it('loads a train candidate set in one bounded query', async () => {
    const execute = jest.fn().mockResolvedValue([]);
    const repository = new ReleaseBusRepository(
      () => ({ execute }) as unknown as SqlExecutor
    );

    await expect(
      repository.findCandidatesByIds(['candidate-1', 'candidate-2'], {})
    ).resolves.toEqual([]);

    const [sql, params] = execute.mock.calls[0] as [
      string,
      Record<string, unknown>
    ];
    expect(sql.trim().split(/\s+/).join(' ')).toContain('where id in (:ids)');
    expect(params).toEqual({ ids: ['candidate-1', 'candidate-2'] });
  });

  it('deduplicates and caps bulk candidate reads at the train limit', async () => {
    const execute = jest.fn().mockResolvedValue([]);
    const repository = new ReleaseBusRepository(
      () => ({ execute }) as unknown as SqlExecutor
    );
    const ids = Array.from({ length: 60 }, (_, index) => `candidate-${index}`);

    await repository.findCandidatesByIds([...ids, ids[0]], {});

    const [, params] = execute.mock.calls[0] as [
      string,
      Record<string, unknown>
    ];
    expect(params.ids).toEqual(ids.slice(0, 50));
  });
});
