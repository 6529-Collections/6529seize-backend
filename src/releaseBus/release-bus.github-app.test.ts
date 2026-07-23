import {
  releaseBusPullRequestMergeStateEligible,
  safeGitHubWorkflowLabel,
  sanitizeGitHubWorkflowJobs,
  workflowRunMatchesOperation,
  type GitHubWorkflowJob
} from '@/releaseBus/release-bus.github-app';

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
