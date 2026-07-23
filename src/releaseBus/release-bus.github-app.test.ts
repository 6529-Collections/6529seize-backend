import fetch, { Response } from 'node-fetch';
import {
  isValidGitHubWorkflowActor,
  ReleaseBusGitHubApp,
  ReleaseBusGitHubInfrastructureError,
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
  it('accepts human and GitHub App workflow actors', () => {
    expect(isValidGitHubWorkflowActor('GelatoGenesis')).toBe(true);
    expect(isValidGitHubWorkflowActor('6529-release-bus[bot]')).toBe(true);
    expect(isValidGitHubWorkflowActor('github-actions[bot]')).toBe(false);
    expect(isValidGitHubWorkflowActor('release-bus[admin]')).toBe(false);
    expect(isValidGitHubWorkflowActor(`${'a'.repeat(40)}`)).toBe(false);
  });

  it('reads the exact Release Bus App actor from a workflow run', async () => {
    const app = new ReleaseBusGitHubApp();
    (
      app as unknown as {
        cachedToken: { value: string; expiresAt: number };
      }
    ).cachedToken = { value: 'test-token', expiresAt: Date.now() + 120_000 };
    const fetchMock = fetch as jest.MockedFunction<typeof fetch>;
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id: 12345,
          name: 'Release Bus v2 - Compose Backend',
          path: '.github/workflows/release-bus-v2-compose.yml',
          display_title: 'Compose backend v2 train beta [rb2:beta:a1]',
          status: 'in_progress',
          conclusion: null,
          head_sha: 'a'.repeat(40),
          html_url: 'https://github.com/example/actions/runs/12345',
          event: 'workflow_dispatch',
          actor: { login: '6529-release-bus[bot]' }
        })
      )
    );

    try {
      await expect(
        app.getWorkflowRunIdentity('backend', '12345')
      ).resolves.toMatchObject({
        actor: '6529-release-bus[bot]',
        event: 'workflow_dispatch',
        headSha: 'a'.repeat(40)
      });
    } finally {
      fetchMock.mockReset();
    }
  });

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

describe('GitHub workflow dispatch failure classification', () => {
  it('treats a secondary-rate-limit 403 as retryable infrastructure', async () => {
    const app = new ReleaseBusGitHubApp();
    (
      app as unknown as {
        cachedToken: { value: string; expiresAt: number };
      }
    ).cachedToken = { value: 'test-token', expiresAt: Date.now() + 120_000 };
    const fetchMock = fetch as jest.MockedFunction<typeof fetch>;
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ message: 'secondary rate limit' }), {
        status: 403,
        headers: { 'Retry-After': '30' }
      })
    );

    try {
      await expect(
        app.dispatchWorkflow('backend', 'deploy.yml', 'main', {})
      ).rejects.toMatchObject({
        name: ReleaseBusGitHubInfrastructureError.name,
        message: expect.stringContaining('secondary rate limit')
      });
    } finally {
      fetchMock.mockReset();
    }
  });
});

describe('GitHub staging idle handshake', () => {
  it('treats an active staging E2E run as shared staging ownership', async () => {
    const app = new ReleaseBusGitHubApp();
    (
      app as unknown as {
        cachedToken: { value: string; expiresAt: number };
      }
    ).cachedToken = { value: 'test-token', expiresAt: Date.now() + 120_000 };
    const fetchMock = fetch as jest.MockedFunction<typeof fetch>;
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          workflow_runs: [
            {
              id: 12345,
              name: 'Staging E2E',
              display_title: 'Guarded staging E2E',
              status: 'in_progress'
            }
          ]
        })
      )
    );

    try {
      await expect(
        app.hasActiveStagingMutationOrE2ERun('frontend')
      ).resolves.toBe(true);
    } finally {
      fetchMock.mockReset();
    }
  });

  it('detects a completed staging deploy after the handshake and ignores exact train runs', async () => {
    const app = new ReleaseBusGitHubApp();
    (
      app as unknown as {
        cachedToken: { value: string; expiresAt: number };
      }
    ).cachedToken = { value: 'test-token', expiresAt: Date.now() + 120_000 };
    const fetchMock = fetch as jest.MockedFunction<typeof fetch>;
    const since = Date.parse('2026-07-23T13:22:00Z');
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          workflow_runs: [
            {
              id: 100,
              name: 'Deploy api to staging train exact [rb2:exact]',
              path: '.github/workflows/deploy.yml',
              display_title: 'Deploy api to staging train exact [rb2:exact]',
              created_at: '2026-07-23T13:22:10Z'
            },
            {
              id: 101,
              name: 'Deploy api to staging [manual]',
              path: '.github/workflows/deploy.yml',
              display_title: 'Deploy api to staging [manual]',
              created_at: '2026-07-23T13:23:22Z'
            }
          ]
        })
      )
    );

    try {
      await expect(
        app.hasStagingMutationOrE2ERunSince('backend', since, ['100'])
      ).resolves.toBe(true);
      expect(String(fetchMock.mock.calls[0]?.[0])).toContain(
        'created=%3E%3D2026-07-23T13%3A22%3A00.000Z'
      );
    } finally {
      fetchMock.mockReset();
    }
  });

  it('does not treat ignored exact train workflows as external mutation', async () => {
    const app = new ReleaseBusGitHubApp();
    (
      app as unknown as {
        cachedToken: { value: string; expiresAt: number };
      }
    ).cachedToken = { value: 'test-token', expiresAt: Date.now() + 120_000 };
    const fetchMock = fetch as jest.MockedFunction<typeof fetch>;
    const since = Date.parse('2026-07-23T13:22:00Z');
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          workflow_runs: [
            {
              id: 100,
              name: 'Release Bus - Staging E2E exact train',
              path: '.github/workflows/staging-e2e.yml',
              display_title: 'Exact train E2E',
              created_at: '2026-07-23T13:22:20Z'
            }
          ]
        })
      )
    );

    try {
      await expect(
        app.hasStagingMutationOrE2ERunSince('frontend', since, ['100'])
      ).resolves.toBe(false);
    } finally {
      fetchMock.mockReset();
    }
  });

  it('excludes a date-filter result created before the fence window', async () => {
    const app = new ReleaseBusGitHubApp();
    (
      app as unknown as {
        cachedToken: { value: string; expiresAt: number };
      }
    ).cachedToken = { value: 'test-token', expiresAt: Date.now() + 120_000 };
    const fetchMock = fetch as jest.MockedFunction<typeof fetch>;
    const since = Date.parse('2026-07-23T13:22:00Z');
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          workflow_runs: [
            {
              id: 99,
              name: 'Deploy api to staging [manual]',
              path: '.github/workflows/deploy.yml',
              display_title: 'Deploy api to staging [manual]',
              created_at: '2026-07-23T13:21:59Z'
            }
          ]
        })
      )
    );

    try {
      await expect(
        app.hasStagingMutationOrE2ERunSince('backend', since)
      ).resolves.toBe(false);
    } finally {
      fetchMock.mockReset();
    }
  });

  it('paginates the beta fence history before accepting an idle result', async () => {
    const app = new ReleaseBusGitHubApp();
    (
      app as unknown as {
        cachedToken: { value: string; expiresAt: number };
      }
    ).cachedToken = { value: 'test-token', expiresAt: Date.now() + 120_000 };
    const fetchMock = fetch as jest.MockedFunction<typeof fetch>;
    const since = Date.parse('2026-07-23T13:22:00Z');
    fetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            workflow_runs: Array.from({ length: 100 }, (_, index) => ({
              id: index + 1,
              name: 'Unrelated CI',
              path: '.github/workflows/ci.yml',
              display_title: 'Unrelated CI',
              created_at: '2026-07-23T13:23:00Z'
            }))
          })
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            workflow_runs: [
              {
                id: 101,
                name: 'Web Deploy - STAGING',
                path: '.github/workflows/deploy-staging.yml',
                display_title: 'Web Deploy - STAGING',
                created_at: '2026-07-23T13:22:30Z'
              }
            ]
          })
        )
      );

    try {
      await expect(
        app.hasStagingMutationOrE2ERunSince('frontend', since)
      ).resolves.toBe(true);
      expect(String(fetchMock.mock.calls[1]?.[0])).toContain('page=2');
    } finally {
      fetchMock.mockReset();
    }
  });

  it('does not confuse a staging-canary title with shared staging', async () => {
    const app = new ReleaseBusGitHubApp();
    (
      app as unknown as {
        cachedToken: { value: string; expiresAt: number };
      }
    ).cachedToken = { value: 'test-token', expiresAt: Date.now() + 120_000 };
    const fetchMock = fetch as jest.MockedFunction<typeof fetch>;
    const since = Date.parse('2026-07-23T13:22:00Z');
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          workflow_runs: [
            {
              id: 101,
              name: 'Deploy api to staging-canary [manual]',
              path: '.github/workflows/deploy.yml',
              display_title: 'Deploy api to staging-canary [manual]',
              created_at: '2026-07-23T13:22:30Z'
            }
          ]
        })
      )
    );

    try {
      await expect(
        app.hasStagingMutationOrE2ERunSince('backend', since)
      ).resolves.toBe(false);
    } finally {
      fetchMock.mockReset();
    }
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
