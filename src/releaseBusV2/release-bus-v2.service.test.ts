const mockResolveRef = jest.fn();

jest.mock('@/releaseBus/release-bus.github-app', () => ({
  releaseBusGitHubApp: {
    resolveRef: (...args: unknown[]) => mockResolveRef(...args),
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
