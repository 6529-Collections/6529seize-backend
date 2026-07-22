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

  it('reports whether evidence was inserted or already present', async () => {
    const execute = jest
      .fn()
      .mockResolvedValueOnce({ affectedRows: 1 })
      .mockResolvedValueOnce({ affectedRows: 0 });
    const repository = new ReleaseBusRepository(
      () =>
        ({
          execute,
          getAffectedRows: (result: { affectedRows?: number }) =>
            result.affectedRows ?? 0
        }) as unknown as SqlExecutor
    );
    const evidence = {
      idempotencyKey: 'base-canary-completed:operation-key',
      trainId: 'train-1',
      revision: 1,
      evidenceType: 'BASE_CANARY_COMPLETED',
      status: 'SUCCEEDED',
      sourceSha: 'a'.repeat(40)
    };

    await expect(repository.addEvidence(evidence, {})).resolves.toBe(true);
    await expect(repository.addEvidence(evidence, {})).resolves.toBe(false);

    const [sql, params] = execute.mock.calls[0] as [
      string,
      Record<string, unknown>
    ];
    expect(sql.trim().split(/\s+/).join(' ')).toContain(
      'insert ignore into release_train_evidence'
    );
    expect(params).toMatchObject({
      evidenceKey: 'base-canary-completed:operation-key',
      trainId: 'train-1',
      sourceSha: 'a'.repeat(40)
    });
  });

  it('loads exact-SHA base evidence newest-first with a bounded limit', async () => {
    const rows = [
      { id: 'evidence-newer', created_at: 2 },
      { id: 'evidence-older', created_at: 1 }
    ];
    const execute = jest
      .fn()
      .mockResolvedValueOnce(rows)
      .mockResolvedValueOnce([]);
    const repository = new ReleaseBusRepository(
      () => ({ execute }) as unknown as SqlExecutor
    );
    const sourceSha = 'b'.repeat(40);

    await expect(
      repository.listBaseCanaryEvidenceBySha(sourceSha, {}, 999)
    ).resolves.toEqual(rows);
    await expect(
      repository.listBaseCanaryEvidenceBySha(sourceSha, {}, 20)
    ).resolves.toEqual([]);

    const [sql, params] = execute.mock.calls[0] as [
      string,
      Record<string, unknown>
    ];
    const normalizedSql = sql.trim().split(/\s+/).join(' ');
    expect(normalizedSql).toContain(
      "where evidence_type = 'BASE_CANARY_COMPLETED' and source_sha = :sourceSha"
    );
    expect(normalizedSql).toContain(
      'order by created_at desc, id desc limit 500'
    );
    expect(params).toEqual({ sourceSha });
    expect(execute.mock.calls[1]?.[0]).toContain('limit 20');
  });

  it('rejects malformed base evidence SHAs before querying', async () => {
    const execute = jest.fn();
    const repository = new ReleaseBusRepository(
      () => ({ execute }) as unknown as SqlExecutor
    );

    await expect(
      repository.listBaseCanaryEvidenceBySha('not-a-sha', {})
    ).rejects.toThrow('Invalid frontend base evidence SHA');
    expect(execute).not.toHaveBeenCalled();
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
        7,
        'PRODUCTION_E2E_RUNNING',
        {}
      )
    ).resolves.toBe(true);

    const [sql, params] = execute.mock.calls[0] as [
      string,
      Record<string, unknown>
    ];
    expect(sql.trim().split(/\s+/).join(' ')).toContain(
      'where id = :id and status = :expectedStatus and row_version = :expectedVersion'
    );
    expect(params).toMatchObject({
      id: 'train-1',
      expectedStatus: 'DEPLOYING_FRONTEND_PRODUCTION',
      expectedVersion: 7,
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

  it('deduplicates bulk candidate reads and rejects an impossible train size', async () => {
    const execute = jest.fn().mockResolvedValue([]);
    const repository = new ReleaseBusRepository(
      () => ({ execute }) as unknown as SqlExecutor
    );
    const ids = Array.from({ length: 60 }, (_, index) => `candidate-${index}`);

    await expect(
      repository.findCandidatesByIds([...ids, ids[0]], {})
    ).rejects.toThrow('exceeds the maximum 50');
    expect(execute).not.toHaveBeenCalled();
  });

  it('prunes terminal trains before unreferenced terminal candidates', async () => {
    const execute = jest.fn(async (sql: string) => {
      const normalized = sql.trim().split(/\s+/).join(' ');
      if (normalized.startsWith('select id from release_trains'))
        return [{ id: 'train-old' }];
      if (
        normalized.startsWith(
          'select candidate.id from release_ready_deployments candidate'
        )
      )
        return [{ id: 'candidate-old' }];
      return { affectedRows: 1 };
    });
    const repository = new ReleaseBusRepository(
      () => ({ execute }) as unknown as SqlExecutor
    );

    await expect(
      repository.pruneTerminalHistory(123456, 500, {})
    ).resolves.toEqual({ trains: 1, candidates: 1 });

    const sql = execute.mock.calls.map(([statement]) =>
      statement.trim().split(/\s+/).join(' ')
    );
    const trainItemDelete = sql.findIndex((statement) =>
      statement.startsWith('delete from release_train_items')
    );
    const candidateSelect = sql.findIndex((statement) =>
      statement.startsWith(
        'select candidate.id from release_ready_deployments candidate'
      )
    );
    const candidateDelete = sql.findIndex((statement) =>
      statement.startsWith('delete from release_ready_deployments')
    );
    expect(sql[0]).toContain('limit 100');
    expect(trainItemDelete).toBeGreaterThan(0);
    expect(candidateSelect).toBeGreaterThan(trainItemDelete);
    expect(sql[candidateSelect]).toContain(
      'not exists ( select 1 from release_train_items item where item.candidate_id = candidate.id )'
    );
    expect(candidateDelete).toBeGreaterThan(candidateSelect);
  });

  it('resets experimental rows in dependency-safe order and retains an audit event', async () => {
    const execute = jest.fn().mockResolvedValue({ affectedRows: 1 });
    const repository = new ReleaseBusRepository(
      () => ({ execute }) as unknown as SqlExecutor
    );

    await repository.resetExperimentalHistory(
      'Controlled go-live reset',
      'operator',
      {}
    );

    const sql = execute.mock.calls.map(([statement]) =>
      statement.trim().split(/\s+/).join(' ')
    );
    expect(sql.slice(0, 7)).toEqual([
      'delete from release_train_events',
      'delete from release_train_evidence',
      'delete from release_train_operations',
      'delete from release_train_items',
      'delete from release_candidate_dependencies',
      'delete from release_ready_deployments',
      'delete from release_trains'
    ]);
    expect(sql[7]).toContain(
      'update release_deployment_lanes set train_id = null, lease_owner = null, lease_token = null'
    );
    expect(sql.at(-1)).toContain('insert into release_train_events');
    expect(execute.mock.calls.at(-1)?.[1]).toMatchObject({
      eventType: 'EXPERIMENTAL_HISTORY_RESET',
      githubActor: 'operator'
    });
  });
});
