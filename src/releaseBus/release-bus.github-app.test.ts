import fetch, { Response } from 'node-fetch';
import {
  ReleaseBusGitHubApp,
  releaseBusPullRequestMergeStateEligible,
  safeGitHubWorkflowLabel,
  sanitizeGitHubWorkflowJobs,
  workflowRunMatchesOperation,
  type GitHubWorkflowJob
} from '@/releaseBus/release-bus.github-app';

jest.mock('node-fetch', () => {
  const actual = jest.requireActual('node-fetch');
  return { ...actual, __esModule: true, default: jest.fn() };
});

describe('GitHub pull request qualification evidence', () => {
  it('reads checks from the PR head and binds the artifact to its merge tree', async () => {
    const headSha = 'a'.repeat(40);
    const baseSha = 'b'.repeat(40);
    const mergeSha = 'c'.repeat(40);
    const runId = 12345;
    const app = new ReleaseBusGitHubApp();
    (
      app as unknown as {
        cachedToken: { value: string; expiresAt: number };
      }
    ).cachedToken = { value: 'test-token', expiresAt: Date.now() + 120_000 };
    const fetchMock = fetch as jest.MockedFunction<typeof fetch>;
    fetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            number: 42,
            state: 'open',
            mergeable: true,
            mergeable_state: 'blocked',
            head: { sha: headSha, ref: 'agent/test' },
            base: { sha: baseSha, ref: 'main' },
            merge_commit_sha: mergeSha
          })
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            check_runs: [
              {
                id: 99,
                name: 'Build backend and API',
                status: 'completed',
                conclusion: 'success',
                completed_at: '2026-07-23T04:00:00Z',
                details_url: `https://github.com/6529-Collections/6529seize-backend/actions/runs/${runId}/job/7`
              }
            ]
          })
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            artifacts: [
              {
                id: 100,
                name: `release-bus-v2-pr-${mergeSha}`,
                digest: `sha256:${'d'.repeat(64)}`,
                expired: false,
                workflow_run: { id: runId, head_sha: headSha }
              }
            ]
          })
        )
      );

    try {
      const qualification = await app.getPullRequestQualification(
        'backend',
        42,
        headSha
      );

      expect(String(fetchMock.mock.calls[1]?.[0])).toContain(
        `/commits/${headSha}/check-runs`
      );
      expect(String(fetchMock.mock.calls[1]?.[0])).not.toContain(mergeSha);
      expect(qualification).toMatchObject({
        baseSha,
        mergeSha,
        checksRunId: String(runId),
        artifactRunId: String(runId),
        artifactName: `release-bus-v2-pr-${mergeSha}`,
        artifactDigest: 'd'.repeat(64)
      });
    } finally {
      fetchMock.mockReset();
    }
  });
});

describe('GitHub pull request release eligibility', () => {
  it('accepts a ruleset-blocked but explicitly mergeable exact tree', () => {
    expect(releaseBusPullRequestMergeStateEligible(true, 'blocked')).toBe(true);
  });

  it.each(['dirty', 'draft', 'unknown', undefined])(
    'rejects an unresolved %s merge state',
    (state) => {
      expect(releaseBusPullRequestMergeStateEligible(true, state)).toBe(false);
    }
  );

  it('rejects a known merge conflict regardless of state label', () => {
    expect(releaseBusPullRequestMergeStateEligible(false, 'blocked')).toBe(
      false
    );
  });
});

describe('GitHub workflow operation identity', () => {
  it('matches only the exact bracketed operation key', () => {
    const operationKey = 'rb:train-1:r1:preflight:aabbcc:a2';

    expect(
      workflowRunMatchesOperation(
        `Preflight backend train train-1 [${operationKey}]`,
        operationKey
      )
    ).toBe(true);
    expect(
      workflowRunMatchesOperation(
        `Preflight backend train train-1 [prefix-${operationKey}]`,
        operationKey
      )
    ).toBe(false);
    expect(
      workflowRunMatchesOperation(
        `Preflight backend train train-1 [${operationKey}-suffix]`,
        operationKey
      )
    ).toBe(false);
  });
});

function job(index: number): GitHubWorkflowJob {
  return {
    id: index,
    name: ` Job ${index}\u0000 `,
    status: 'completed',
    conclusion: 'success',
    html_url: `https://github.com/example/actions/jobs/${index}`,
    started_at: null,
    completed_at: null,
    steps: Array.from({ length: 101 }, (_, stepIndex) => ({
      name: ` Step ${stepIndex}\u0007 `,
      status: 'completed',
      conclusion: 'success',
      started_at: null,
      completed_at: null
    }))
  };
}

describe('GitHub workflow progress sanitization', () => {
  it('bounds job and step counts and strips control characters', () => {
    const jobs = sanitizeGitHubWorkflowJobs(
      Array.from({ length: 101 }, (_, index) => job(index))
    );

    expect(jobs).toHaveLength(100);
    expect(jobs[0].name).toBe('Job 0');
    expect(jobs[0].steps).toHaveLength(100);
    expect(jobs[0].steps?.[0].name).toBe('Step 0');
  });

  it('bounds persisted labels and drops empty values', () => {
    expect(safeGitHubWorkflowLabel('x'.repeat(501))).toHaveLength(500);
    expect(safeGitHubWorkflowLabel('\u0000\u0007')).toBeNull();
  });
});
