const mockResolveRef = jest.fn();
const mockQualification = jest.fn();

jest.mock('@/releaseBus/release-bus.github-app', () => ({
  releaseBusGitHubApp: {
    resolveRef: (...args: unknown[]) => mockResolveRef(...args),
    getPullRequestQualification: (...args: unknown[]) =>
      mockQualification(...args),
    ensureCommitStatus: jest.fn()
  }
}));

import { ReleaseBusV2Service } from '@/releaseBusV2/release-bus-v2.service';
import type { ReleaseBusV2CandidateRecord } from '@/releaseBusV2/release-bus-v2.types';

function candidate(
  status: ReleaseBusV2CandidateRecord['status']
): ReleaseBusV2CandidateRecord {
  return {
    id: 'candidate-id',
    repository: 'frontend',
    pr_number: 42,
    branch_name: 'feature/exact',
    head_sha: 'a'.repeat(40),
    requested_by: 'developer',
    status,
    deploy_plan_json: null,
    pr_evidence_json: null,
    current_train_id: null,
    staging_validated_train_id:
      status === 'STAGING_VALIDATED' ? 'staging-train-id' : null,
    staging_validated_manifest_id:
      status === 'STAGING_VALIDATED' ? 'manifest-id' : null,
    production_requested_at: null,
    production_requested_by: null,
    hold_reason: null,
    superseded_at: null,
    created_at: 1,
    updated_at: 1,
    row_version: 3
  };
}

function repositoryFor(initial: ReleaseBusV2CandidateRecord) {
  let current = initial;
  return {
    current: () => current,
    repository: {
      listControls: jest.fn(async () => []),
      findCandidateById: jest.fn(async () => current),
      executeNativeQueriesInTransaction: jest.fn(
        async (callback: (connection: unknown) => Promise<unknown>) =>
          callback({})
      ),
      updateCandidate: jest.fn(
        async (
          _id: string,
          rowVersion: number,
          fields: {
            status?: ReleaseBusV2CandidateRecord['status'];
            productionRequestedAt?: number;
            productionRequestedBy?: string;
          }
        ) => {
          if (rowVersion !== current.row_version) return false;
          current = {
            ...current,
            status: fields.status ?? current.status,
            production_requested_at:
              fields.productionRequestedAt ?? current.production_requested_at,
            production_requested_by:
              fields.productionRequestedBy ?? current.production_requested_by,
            row_version: current.row_version + 1
          };
          return true;
        }
      ),
      appendEvent: jest.fn(async () => undefined)
    }
  };
}

describe('Release Bus v2 explicit production opt-in', () => {
  const previousMode = process.env.RELEASE_BUS_V2_MODE;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.RELEASE_BUS_V2_MODE = 'PRODUCTION';
  });

  afterAll(() => {
    if (previousMode === undefined) delete process.env.RELEASE_BUS_V2_MODE;
    else process.env.RELEASE_BUS_V2_MODE = previousMode;
  });

  it('does not accept a candidate merely because it is staging-ready', async () => {
    const state = repositoryFor(candidate('READY_FOR_STAGING'));
    const service = new ReleaseBusV2Service(state.repository as never);
    await expect(
      service.markReadyForProduction('candidate-id', 'a'.repeat(40), 3, 'owner')
    ).rejects.toThrow('not staging validated');
    expect(mockResolveRef).not.toHaveBeenCalled();
    expect(state.current().production_requested_at).toBeNull();
  });

  it('requires an unchanged exact branch SHA before recording explicit readiness', async () => {
    const state = repositoryFor(candidate('STAGING_VALIDATED'));
    mockResolveRef.mockResolvedValue('b'.repeat(40));
    const service = new ReleaseBusV2Service(state.repository as never);
    await expect(
      service.markReadyForProduction('candidate-id', 'a'.repeat(40), 3, 'owner')
    ).rejects.toThrow('moved after staging validation');
    expect(state.current().status).toBe('STAGING_VALIDATED');
  });

  it('records production readiness only after the explicit exact-SHA action', async () => {
    const state = repositoryFor(candidate('STAGING_VALIDATED'));
    mockResolveRef.mockResolvedValue('a'.repeat(40));
    const service = new ReleaseBusV2Service(state.repository as never);
    const result = await service.markReadyForProduction(
      'candidate-id',
      'a'.repeat(40),
      3,
      'owner'
    );
    expect(result.status).toBe('READY_FOR_PRODUCTION');
    expect(result.production_requested_by).toBe('owner');
    expect(result.production_requested_at).not.toBeNull();
    expect(state.repository.appendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'CANDIDATE_READY_FOR_PRODUCTION',
        actor: 'owner'
      }),
      expect.anything()
    );
  });
});

describe('Release Bus v2 STAGING-mode production beta opt-in', () => {
  const previousMode = process.env.RELEASE_BUS_V2_MODE;
  const previousAllowlist = process.env.RELEASE_BUS_V2_BETA_ALLOWLIST;
  const betaId = '11111111-1111-4111-8111-111111111111';

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.RELEASE_BUS_V2_MODE = 'STAGING';
    process.env.RELEASE_BUS_V2_BETA_ALLOWLIST = JSON.stringify([
      {
        test_id: 'production-subset-1',
        candidate_id: betaId,
        repository: 'frontend',
        branch_name: 'feature/exact',
        operator: 'beta-operator',
        lanes: ['PRODUCTION']
      }
    ]);
  });

  afterAll(() => {
    if (previousMode === undefined) delete process.env.RELEASE_BUS_V2_MODE;
    else process.env.RELEASE_BUS_V2_MODE = previousMode;
    if (previousAllowlist === undefined)
      delete process.env.RELEASE_BUS_V2_BETA_ALLOWLIST;
    else process.env.RELEASE_BUS_V2_BETA_ALLOWLIST = previousAllowlist;
  });

  it('allows only the exact validated allowlisted operator candidate', async () => {
    const exact = {
      ...candidate('STAGING_VALIDATED'),
      id: betaId,
      requested_by: 'beta-operator'
    };
    const state = repositoryFor(exact);
    mockResolveRef.mockResolvedValue(exact.head_sha);
    const service = new ReleaseBusV2Service(state.repository as never);

    await expect(
      service.markReadyForProduction(
        betaId,
        exact.head_sha,
        exact.row_version,
        'beta-operator'
      )
    ).resolves.toEqual(
      expect.objectContaining({ status: 'READY_FOR_PRODUCTION' })
    );
  });

  it('does not broaden production readiness to another actor', async () => {
    const exact = {
      ...candidate('STAGING_VALIDATED'),
      id: betaId,
      requested_by: 'beta-operator'
    };
    const state = repositoryFor(exact);
    const service = new ReleaseBusV2Service(state.repository as never);

    await expect(
      service.markReadyForProduction(
        betaId,
        exact.head_sha,
        exact.row_version,
        'another-actor'
      )
    ).rejects.toThrow('production readiness is disabled');
    expect(mockResolveRef).not.toHaveBeenCalled();
  });
});

describe('Release Bus v2 globally-OFF operator beta registration', () => {
  const previousMode = process.env.RELEASE_BUS_V2_MODE;
  const previousAllowlist = process.env.RELEASE_BUS_V2_BETA_ALLOWLIST;
  const betaId = '11111111-1111-4111-8111-111111111111';
  const headSha = 'b'.repeat(40);

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.RELEASE_BUS_V2_MODE = 'OFF';
    process.env.RELEASE_BUS_V2_BETA_ALLOWLIST = JSON.stringify([
      {
        test_id: 'backend-only-1',
        candidate_id: betaId,
        repository: 'backend',
        branch_name: 'agent/rb2-beta-backend-one',
        operator: 'beta-operator',
        lanes: ['STAGING']
      }
    ]);
    mockResolveRef.mockResolvedValue(headSha);
    mockQualification.mockResolvedValue({
      baseSha: 'c'.repeat(40),
      mergeSha: 'd'.repeat(40),
      checksRunId: '100',
      checksCompletedAt: 1,
      artifactRunId: null,
      artifactName: null,
      artifactDigest: null
    });
  });

  afterAll(() => {
    if (previousMode === undefined) delete process.env.RELEASE_BUS_V2_MODE;
    else process.env.RELEASE_BUS_V2_MODE = previousMode;
    if (previousAllowlist === undefined)
      delete process.env.RELEASE_BUS_V2_BETA_ALLOWLIST;
    else process.env.RELEASE_BUS_V2_BETA_ALLOWLIST = previousAllowlist;
  });

  function input() {
    return {
      candidate_id: betaId,
      repository: 'backend' as const,
      pr_number: 1801,
      branch_name: 'agent/rb2-beta-backend-one',
      expected_head_sha: headSha,
      deploy_plan: { units: ['api'], edges: [] },
      dependencies: []
    };
  }

  function betaRepository() {
    const createCandidate = jest.fn(async (value) => ({
      ...candidate('READY_FOR_STAGING'),
      id: value.candidateId,
      repository: value.repository,
      pr_number: value.prNumber,
      branch_name: value.branchName,
      head_sha: value.headSha,
      requested_by: value.requestedBy,
      deploy_plan_json: value.deployPlan,
      pr_evidence_json: value.prEvidence
    }));
    return {
      createCandidate,
      listControls: jest.fn(async () => []),
      executeNativeQueriesInTransaction: jest.fn(async (callback) =>
        callback({})
      ),
      supersedeOtherPrHeads: jest.fn(async () => []),
      findCandidateById: jest.fn(async () => null),
      findCandidateByIdentity: jest.fn(async () => null),
      listDependencies: jest.fn(async () => []),
      addDependency: jest.fn(async () => undefined),
      listCandidates: jest.fn(async () => []),
      appendEvent: jest.fn(async () => undefined)
    };
  }

  it('creates only the exact configured synthetic candidate id', async () => {
    const repository = betaRepository();
    const service = new ReleaseBusV2Service(repository as never);

    await expect(service.register(input(), 'BETA-OPERATOR')).resolves.toEqual(
      expect.objectContaining({
        id: betaId,
        branch_name: 'agent/rb2-beta-backend-one',
        requested_by: 'BETA-OPERATOR'
      })
    );
    expect(repository.createCandidate).toHaveBeenCalledWith(
      expect.objectContaining({ candidateId: betaId }),
      expect.anything()
    );
    expect(repository.supersedeOtherPrHeads).not.toHaveBeenCalled();
  });

  it('rejects an unlisted actor without resolving or mutating the candidate', async () => {
    const repository = betaRepository();
    const service = new ReleaseBusV2Service(repository as never);

    await expect(service.register(input(), 'ordinary-agent')).rejects.toThrow(
      'staging readiness is disabled'
    );
    expect(mockResolveRef).not.toHaveBeenCalled();
    expect(repository.createCandidate).not.toHaveBeenCalled();
  });

  it('rejects reusing the one-shot beta id after the branch head moves', async () => {
    const repository = betaRepository();
    repository.findCandidateById.mockResolvedValue({
      ...candidate('READY_FOR_STAGING'),
      id: betaId,
      repository: 'backend',
      pr_number: 1801,
      branch_name: 'agent/rb2-beta-backend-one',
      head_sha: 'a'.repeat(40),
      requested_by: 'BETA-OPERATOR'
    } as never);
    const service = new ReleaseBusV2Service(repository as never);

    await expect(service.register(input(), 'BETA-OPERATOR')).rejects.toThrow(
      'beta candidate id is immutable'
    );
    expect(repository.findCandidateByIdentity).not.toHaveBeenCalled();
    expect(repository.createCandidate).not.toHaveBeenCalled();
  });

  it('rejects a beta id when the exact identity already belongs to another candidate', async () => {
    const repository = betaRepository();
    repository.findCandidateByIdentity.mockResolvedValue({
      ...candidate('READY_FOR_STAGING'),
      id: '22222222-2222-4222-8222-222222222222',
      repository: 'backend',
      pr_number: 1801,
      branch_name: 'agent/rb2-beta-backend-one',
      head_sha: headSha,
      requested_by: 'ordinary-registration'
    } as never);
    const service = new ReleaseBusV2Service(repository as never);

    await expect(service.register(input(), 'BETA-OPERATOR')).rejects.toThrow(
      'exact beta identity already has a different candidate id'
    );
    expect(repository.createCandidate).not.toHaveBeenCalled();
  });
});
