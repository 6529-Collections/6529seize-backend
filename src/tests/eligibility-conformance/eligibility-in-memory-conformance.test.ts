import { UserGroupsService } from '@/api/community-members/user-groups.service';
import { AbusivenessCheckService } from '@/profiles/abusiveness-check.service';
import { MetricsRecorder } from '@/metrics/MetricsRecorder';
import { getRedisClient } from '@/redis';
import * as mcache from 'memory-cache';
import { loadMaterializedVectors } from './vector-loader';
import { buildVectorUserGroupsDbMock } from './in-memory-mock-db';

jest.mock('@/redis', () => ({
  ...jest.requireActual('@/redis'),
  getRedisClient: jest.fn()
}));

/**
 * In-memory conformance harness (docs/eligibility-spec.md, spec_version 1).
 *
 * Runs every golden vector against the real in-memory eligibility engine
 * (`UserGroupsService.getGroupsUserIsEligibleFor` →
 * `whichOfGivenGroupsIsUserEligibleFor`), with the `UserGroupsDb` layer
 * replaced by a per-vector double that serves the vector's profile state
 * (see `in-memory-mock-db.ts`) and Redis disabled. The in-memory engine is
 * the spec-normative one, so every vector's `expected.eligible_group_ids`
 * must match here — including the vectors whose `known_divergence.sql`
 * entries pin the SQL engine to a different outcome.
 */
describe('eligibility conformance: in-memory engine vs golden vectors', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (getRedisClient as jest.Mock).mockReturnValue(null);
    mcache.clear();
  });

  const vectors = loadMaterializedVectors();

  it.each(vectors.map((vector) => [vector.name, vector] as const))(
    '%s',
    async (_name, vector) => {
      const service = new UserGroupsService(
        buildVectorUserGroupsDbMock(vector),
        {} as unknown as AbusivenessCheckService,
        {} as unknown as MetricsRecorder
      );

      const eligibleGroupIds = await service.getGroupsUserIsEligibleFor(
        vector.subjectProfileId
      );

      expect([...eligibleGroupIds].sort((a, b) => a.localeCompare(b))).toEqual(
        [...vector.expectedEligibleGroupIds].sort((a, b) => a.localeCompare(b))
      );
    }
  );
});
