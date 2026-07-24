import { createSign } from 'node:crypto';
import fetch, { type RequestInit, type Response } from 'node-fetch';
import { Logger } from '@/logging';
import { isReleaseBusGitHubAppActor } from '@/releaseBusV2/release-bus-v2.constants';
import type { ReleaseBusV2Repository } from '@/releaseBusV2/release-bus-v2.types';

type InstallationToken = {
  readonly token: string;
  readonly expires_at: string;
};
type GitHubRef = { readonly object?: { readonly sha?: string } };
type GitHubMatchingRef = {
  readonly ref: string;
  readonly object?: { readonly sha?: string };
};
export type GitHubWorkflowStep = {
  readonly name: string;
  readonly status: string;
  readonly conclusion: string | null;
  readonly started_at: string | null;
  readonly completed_at: string | null;
};

export function workflowRunMatchesOperation(
  displayTitle: string,
  operationKey: string
): boolean {
  return displayTitle.includes(`[${operationKey}]`);
}

export function isValidGitHubWorkflowActor(actor: string): boolean {
  // GitHub App workflow actors use the app slug followed by the literal
  // `[bot]` suffix. Only the Release Bus App may drive automated operations;
  // human logins retain GitHub's 39-character limit for manual attribution.
  return (
    /^[A-Za-z0-9-]{1,39}$/.test(actor) || isReleaseBusGitHubAppActor(actor)
  );
}
export type GitHubWorkflowJob = {
  readonly id: number;
  readonly name: string;
  readonly status: string;
  readonly conclusion: string | null;
  readonly html_url: string;
  readonly started_at: string | null;
  readonly completed_at: string | null;
  readonly steps?: GitHubWorkflowStep[];
};
export type GitHubRun = {
  readonly id: number;
  readonly name: string;
  readonly path?: string;
  readonly display_title: string;
  readonly status: string;
  readonly conclusion: string | null;
  readonly head_sha: string;
  readonly html_url: string;
  readonly created_at?: string;
  readonly updated_at?: string;
  readonly event?: string;
  readonly actor?: { readonly login?: string };
  readonly jobs?: GitHubWorkflowJob[];
};

export type ReleaseBusWorkflowRunIdentity = {
  readonly actor: string;
  readonly event: string;
  readonly headSha: string;
  readonly name: string;
  readonly path: string;
  readonly displayTitle: string;
};
type GitHubMembership = {
  readonly state?: string;
  readonly role?: string;
};
type GitHubCommitStatus = {
  readonly context?: string;
  readonly state?: string;
  readonly description?: string | null;
};
type GitHubPullRequestDetails = {
  readonly number?: number;
  readonly state?: string;
  readonly mergeable?: boolean | null;
  readonly mergeable_state?: string;
  readonly user?: { readonly login?: string } | null;
  readonly head?: { readonly sha?: string; readonly ref?: string };
  readonly base?: { readonly sha?: string; readonly ref?: string };
  readonly merge_commit_sha?: string | null;
};
type GitHubPullRequestCommit = {
  readonly author?: { readonly login?: string } | null;
};
type GitHubCheckRun = {
  readonly id?: number;
  readonly name?: string;
  readonly status?: string;
  readonly conclusion?: string | null;
  readonly details_url?: string | null;
  readonly completed_at?: string | null;
};
type GitHubArtifact = {
  readonly id?: number;
  readonly name?: string;
  readonly digest?: string | null;
  readonly expired?: boolean;
  readonly workflow_run?: { readonly id?: number; readonly head_sha?: string };
};

const REPOSITORIES: Readonly<Record<ReleaseBusV2Repository, string>> = {
  frontend: '6529seize-frontend',
  backend: '6529seize-backend'
};
const MAX_WORKFLOW_JOBS = 100;
const MAX_WORKFLOW_STEPS = 100;
const MAX_WORKFLOW_LABEL_LENGTH = 500;
const MAX_STAGING_FENCE_PAGES = 10;
const MAX_PULL_REQUEST_COMMIT_PAGES = 3;
const GITHUB_PAGE_SIZE = 100;

export class ReleaseBusGitHubInfrastructureError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'ReleaseBusGitHubInfrastructureError';
  }
}

function isInfrastructureStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function isSecondaryRateLimit(response: Response): boolean {
  return (
    response.status === 403 &&
    (response.headers.has('retry-after') ||
      response.headers.get('x-ratelimit-remaining') === '0')
  );
}

export function safeGitHubWorkflowLabel(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const sanitized = Array.from(value)
    .map((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code <= 31 || code === 127 ? ' ' : character;
    })
    .join('')
    .trim();
  return sanitized ? sanitized.slice(0, MAX_WORKFLOW_LABEL_LENGTH) : null;
}

export function sanitizeGitHubWorkflowJobs(
  jobs: readonly GitHubWorkflowJob[]
): GitHubWorkflowJob[] {
  return jobs.slice(0, MAX_WORKFLOW_JOBS).map((job) => ({
    ...job,
    name: safeGitHubWorkflowLabel(job.name) ?? 'Unnamed workflow job',
    steps: job.steps?.slice(0, MAX_WORKFLOW_STEPS).map((step) => ({
      ...step,
      name: safeGitHubWorkflowLabel(step.name) ?? 'Unnamed workflow step'
    }))
  }));
}

export function releaseBusPullRequestMergeStateEligible(
  mergeable: boolean | null | undefined,
  mergeableState: string | undefined
): boolean {
  if (mergeable === false) return false;
  if (['clean', 'unstable', 'behind'].includes(mergeableState ?? ''))
    return true;
  // The Release Bus GitHub App is a ruleset bypass actor. Production v2 also
  // needs `always` bypass mode so it can non-force fast-forward the exact
  // staging-validated commit instead of manufacturing a different PR merge
  // commit. Human/team bypass actors remain pull-request-only.
  // GitHub still reports `blocked` for maintainer-review requirements, so only
  // accept that state when the merge tree itself is explicitly mergeable. The
  // exact merge-tree checks are independently required below.
  return mergeable === true && mergeableState === 'blocked';
}

function base64Url(value: string | Buffer): string {
  return Buffer.from(value).toString('base64url');
}

function appJwt(appId: string, privateKey: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64Url(
    JSON.stringify({ iat: now - 60, exp: now + 540, iss: appId })
  );
  const unsigned = `${header}.${payload}`;
  const signer = createSign('RSA-SHA256');
  signer.update(unsigned);
  signer.end();
  return `${unsigned}.${base64Url(signer.sign(privateKey))}`;
}

function assertAllowedWritableRef(ref: string): void {
  if (
    ref === 'main' ||
    ref === '1a-staging' ||
    /^release-bus-v2\/(staging|production|qualification)-train-[A-Za-z0-9._-]+$/.test(
      ref
    )
  )
    return;
  throw new Error(`Release Bus GitHub App cannot write ref ${ref}`);
}

export class ReleaseBusGitHubApp {
  private readonly logger = Logger.get(this.constructor.name);
  private cachedToken: {
    readonly value: string;
    readonly expiresAt: number;
  } | null = null;

  private get owner(): string {
    return process.env.RELEASE_BUS_GITHUB_ORG ?? '6529-Collections';
  }

  private async token(): Promise<string> {
    if (this.cachedToken && this.cachedToken.expiresAt > Date.now() + 60_000)
      return this.cachedToken.value;
    const appId = process.env.RELEASE_BUS_GITHUB_APP_ID;
    const installationId = process.env.RELEASE_BUS_GITHUB_INSTALLATION_ID;
    const privateKey = process.env.RELEASE_BUS_GITHUB_PRIVATE_KEY?.replace(
      /\\n/g,
      '\n'
    );
    if (!appId || !installationId || !privateKey)
      throw new Error('GitHub App credentials are not configured');
    let response: Response;
    try {
      response = await fetch(
        `https://api.github.com/app/installations/${installationId}/access_tokens`,
        {
          method: 'POST',
          headers: this.headers(appJwt(appId, privateKey))
        }
      );
    } catch {
      throw new ReleaseBusGitHubInfrastructureError(
        'GitHub App token request failed before a response was received'
      );
    }
    await this.assertOk(response, 'create GitHub App installation token');
    const payload = (await response.json()) as InstallationToken;
    this.cachedToken = {
      value: payload.token,
      expiresAt: Date.parse(payload.expires_at)
    };
    return payload.token;
  }

  private headers(token: string): Record<string, string> {
    return {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'User-Agent': '6529-release-bus',
      'X-GitHub-Api-Version': '2022-11-28'
    };
  }

  private async request(
    repository: ReleaseBusV2Repository,
    path: string,
    options: RequestInit = {}
  ): Promise<Response> {
    const token = await this.token();
    try {
      return await fetch(
        `https://api.github.com/repos/${this.owner}/${REPOSITORIES[repository]}${path}`,
        {
          ...options,
          headers: { ...this.headers(token), ...(options.headers ?? {}) }
        }
      );
    } catch {
      throw new ReleaseBusGitHubInfrastructureError(
        `GitHub ${repository} request failed before a response was received`
      );
    }
  }

  private async organizationRequest(
    path: string,
    options: RequestInit = {}
  ): Promise<Response> {
    const token = await this.token();
    try {
      return await fetch(`https://api.github.com${path}`, {
        ...options,
        headers: { ...this.headers(token), ...(options.headers ?? {}) }
      });
    } catch {
      throw new ReleaseBusGitHubInfrastructureError(
        'GitHub organization request failed before a response was received'
      );
    }
  }

  private async assertOk(response: Response, operation: string): Promise<void> {
    if (response.ok) return;
    let message = `${response.status} ${response.statusText}`;
    try {
      message =
        ((await response.json()) as { message?: string }).message ?? message;
    } catch {
      /* redacted status is enough */
    }
    const errorMessage = `Failed to ${operation}: ${message}`;
    if (
      isInfrastructureStatus(response.status) ||
      isSecondaryRateLimit(response)
    )
      throw new ReleaseBusGitHubInfrastructureError(errorMessage);
    throw new Error(errorMessage);
  }

  public async resolveRef(
    repository: ReleaseBusV2Repository,
    ref: string
  ): Promise<string> {
    const response = await this.request(
      repository,
      `/git/ref/heads/${encodeURIComponent(ref)}`
    );
    await this.assertOk(response, `resolve ${repository} ref ${ref}`);
    const sha = ((await response.json()) as GitHubRef).object?.sha;
    if (!sha || !/^[a-f0-9]{40}$/i.test(sha))
      throw new Error(`Invalid SHA returned for ${repository}:${ref}`);
    return sha.toLowerCase();
  }

  public async getPullRequestQualification(
    repository: ReleaseBusV2Repository,
    pullNumber: number,
    expectedHeadSha: string
  ): Promise<{
    readonly baseSha: string;
    readonly mergeSha: string;
    readonly checksRunId: string;
    readonly checksCompletedAt: number;
    readonly artifactRunId: string | null;
    readonly artifactName: string | null;
    readonly artifactDigest: string | null;
    readonly contributorGithubLogins: readonly string[];
  }> {
    if (!Number.isSafeInteger(pullNumber) || pullNumber < 1)
      throw new Error('Invalid pull request number');
    const response = await this.request(repository, `/pulls/${pullNumber}`);
    await this.assertOk(
      response,
      `read ${repository} pull request ${pullNumber}`
    );
    const pull = (await response.json()) as GitHubPullRequestDetails;
    const headSha = pull.head?.sha?.toLowerCase();
    const baseSha = pull.base?.sha?.toLowerCase();
    const mergeSha = pull.merge_commit_sha?.toLowerCase();
    if (pull.state !== 'open' || headSha !== expectedHeadSha.toLowerCase())
      throw new Error(
        'Pull request is not open at the exact requested head SHA'
      );
    if (!baseSha || !/^[a-f0-9]{40}$/.test(baseSha))
      throw new Error('Pull request has no valid base SHA');
    if (!mergeSha || !/^[a-f0-9]{40}$/.test(mergeSha))
      throw new Error('Pull request has no exact merge-tree SHA');
    if (
      !releaseBusPullRequestMergeStateEligible(
        pull.mergeable,
        pull.mergeable_state
      )
    )
      throw new Error(
        `Pull request is not eligible against its current base (${pull.mergeable_state ?? 'unknown'}); required checks or mergeability are unresolved`
      );

    const checksResponse = await this.request(
      repository,
      `/commits/${headSha}/check-runs?per_page=100`
    );
    await this.assertOk(
      checksResponse,
      `read ${repository} pull request checks`
    );
    const checks =
      ((await checksResponse.json()) as { check_runs?: GitHubCheckRun[] })
        .check_runs ?? [];
    if (checks.length === 0)
      throw new Error('Pull request head has no check evidence');
    const incomplete = checks.filter((check) => check.status !== 'completed');
    if (incomplete.length > 0)
      throw new Error(
        `Pull request checks are still running: ${incomplete.map((check) => check.name ?? 'unnamed').join(', ')}`
      );
    const allowedConclusions = new Set(['success', 'neutral', 'skipped']);
    const failed = checks.filter(
      (check) => !check.conclusion || !allowedConclusions.has(check.conclusion)
    );
    if (failed.length > 0)
      throw new Error(
        `Pull request checks are not green: ${failed.map((check) => check.name ?? 'unnamed').join(', ')}`
      );
    const completedAt = Math.max(
      ...checks
        .map((check) => Date.parse(check.completed_at ?? ''))
        .filter(Number.isFinite)
    );
    const checksRunId =
      checks
        .map((check) => check.details_url ?? '')
        .map((url) => /\/actions\/runs\/(\d+)/.exec(url)?.[1])
        .find((id): id is string => Boolean(id)) ??
      String(checks[0]?.id ?? '0');
    const greenWorkflowRunIds = new Set(
      checks
        .map((check) => check.details_url ?? '')
        .map((url) => /\/actions\/runs\/(\d+)/.exec(url)?.[1])
        .filter((id): id is string => Boolean(id))
    );

    const artifactsResponse = await this.request(
      repository,
      `/actions/artifacts?name=${encodeURIComponent(`release-bus-v2-pr-${mergeSha}`)}&per_page=100`
    );
    await this.assertOk(
      artifactsResponse,
      `read ${repository} pull request artifacts`
    );
    const artifact = (
      ((await artifactsResponse.json()) as { artifacts?: GitHubArtifact[] })
        .artifacts ?? []
    )
      .filter(
        (item) =>
          !item.expired &&
          item.name === `release-bus-v2-pr-${mergeSha}` &&
          item.workflow_run?.head_sha?.toLowerCase() ===
            expectedHeadSha.toLowerCase() &&
          Boolean(
            item.workflow_run?.id &&
            greenWorkflowRunIds.has(String(item.workflow_run.id))
          ) &&
          /^sha256:[a-f0-9]{64}$/.test(item.digest ?? '')
      )
      .sort((left, right) => Number(right.id ?? 0) - Number(left.id ?? 0))[0];
    const contributorGithubLogins =
      await this.getPullRequestContributorGithubLogins(
        repository,
        pullNumber,
        pull
      );
    return {
      baseSha,
      mergeSha,
      checksRunId,
      checksCompletedAt: Number.isFinite(completedAt)
        ? completedAt
        : Date.now(),
      artifactRunId: artifact?.workflow_run?.id
        ? String(artifact.workflow_run.id)
        : null,
      artifactName: artifact?.name ?? null,
      artifactDigest: artifact?.digest?.replace(/^sha256:/, '') ?? null,
      contributorGithubLogins
    };
  }

  private async getPullRequestContributorGithubLogins(
    repository: ReleaseBusV2Repository,
    pullNumber: number,
    pull: GitHubPullRequestDetails
  ): Promise<readonly string[]> {
    const logins: string[] = [];
    const addLogin = (value: string | undefined) => {
      const login = value?.trim();
      if (!login || isReleaseBusGitHubAppActor(login)) return;
      if (
        logins.some(
          (candidate) => candidate.toLowerCase() === login.toLowerCase()
        )
      )
        return;
      logins.push(login);
    };
    addLogin(pull.user?.login);
    try {
      for (let page = 1; page <= MAX_PULL_REQUEST_COMMIT_PAGES; page += 1) {
        const response = await this.request(
          repository,
          `/pulls/${pullNumber}/commits?per_page=${GITHUB_PAGE_SIZE}&page=${page}`
        );
        await this.assertOk(
          response,
          `read ${repository} pull request ${pullNumber} commits`
        );
        const commits = (await response.json()) as GitHubPullRequestCommit[];
        if (!Array.isArray(commits))
          throw new Error(
            `Invalid ${repository} pull request ${pullNumber} commits response`
          );
        for (const commit of commits) {
          addLogin(commit.author?.login);
        }
        if (commits.length < GITHUB_PAGE_SIZE) break;
        if (page === MAX_PULL_REQUEST_COMMIT_PAGES) {
          this.logger.warn(
            `Contributor scan for ${repository} pull request ${pullNumber} reached ${MAX_PULL_REQUEST_COMMIT_PAGES * GITHUB_PAGE_SIZE} commits; using the contributors collected so far`
          );
        }
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'unknown error';
      this.logger.warn(
        `Contributor scan for ${repository} pull request ${pullNumber} failed; using the contributors collected so far: ${reason}`
      );
    }
    return logins;
  }

  public async resolveRefIfExists(
    repository: ReleaseBusV2Repository,
    ref: string
  ): Promise<string | null> {
    const response = await this.request(
      repository,
      `/git/ref/heads/${encodeURIComponent(ref)}`
    );
    if (response.status === 404) return null;
    await this.assertOk(response, `resolve ${repository} ref ${ref}`);
    const sha = ((await response.json()) as GitHubRef).object?.sha;
    if (!sha || !/^[a-f0-9]{40}$/i.test(sha))
      throw new Error(`Invalid SHA returned for ${repository}:${ref}`);
    return sha.toLowerCase();
  }

  public async updateRef(
    repository: ReleaseBusV2Repository,
    ref: string,
    expectedOldSha: string,
    newSha: string
  ): Promise<void> {
    assertAllowedWritableRef(ref);
    const current = await this.resolveRef(repository, ref);
    if (current === newSha) return;
    if (current !== expectedOldSha)
      throw new Error(
        `${repository}:${ref} moved from expected ${expectedOldSha} to ${current}`
      );
    const response = await this.request(
      repository,
      `/git/refs/heads/${encodeURIComponent(ref)}`,
      {
        method: 'PATCH',
        body: JSON.stringify({ sha: newSha, force: false })
      }
    );
    await this.assertOk(response, `fast-forward ${repository}:${ref}`);
  }

  public async listReleaseBusV2Refs(
    repository: ReleaseBusV2Repository
  ): Promise<Array<{ ref: string; sha: string }>> {
    const response = await this.request(
      repository,
      '/git/matching-refs/heads/release-bus-v2/'
    );
    await this.assertOk(response, `list ${repository} release-bus-v2 refs`);
    return ((await response.json()) as GitHubMatchingRef[])
      .map((item) => ({
        ref: item.ref.replace(/^refs\/heads\//, ''),
        sha: item.object?.sha ?? ''
      }))
      .filter((item) => item.sha.length > 0);
  }

  public async commitTimestamp(
    repository: ReleaseBusV2Repository,
    sha: string
  ): Promise<number> {
    const response = await this.request(repository, `/commits/${sha}`);
    await this.assertOk(response, `read ${repository} commit ${sha}`);
    const payload = (await response.json()) as {
      commit?: { committer?: { date?: string }; author?: { date?: string } };
    };
    const value =
      payload.commit?.committer?.date ?? payload.commit?.author?.date ?? '';
    const timestamp = Date.parse(value);
    if (!Number.isFinite(timestamp))
      throw new Error(`GitHub commit ${sha} has no valid timestamp`);
    return timestamp;
  }

  public async deleteReleaseBusV2Ref(
    repository: ReleaseBusV2Repository,
    ref: string
  ): Promise<void> {
    assertAllowedWritableRef(ref);
    if (!ref.startsWith('release-bus-v2/'))
      throw new Error(`Ref ${ref} is not a temporary release-bus-v2 branch`);
    const response = await this.request(
      repository,
      `/git/refs/heads/${encodeURIComponent(ref)}`,
      { method: 'DELETE' }
    );
    if (response.status === 404) return;
    await this.assertOk(response, `delete ${repository} ref ${ref}`);
  }

  public async dispatchWorkflow(
    repository: ReleaseBusV2Repository,
    workflow: string,
    ref: string,
    inputs: Readonly<Record<string, string>>
  ): Promise<void> {
    const response = await this.request(
      repository,
      `/actions/workflows/${encodeURIComponent(workflow)}/dispatches`,
      {
        method: 'POST',
        body: JSON.stringify({ ref, inputs })
      }
    );
    await this.assertOk(
      response,
      `dispatch ${repository} workflow ${workflow}`
    );
  }

  public async findWorkflowRun(
    repository: ReleaseBusV2Repository,
    workflow: string,
    operationKey: string,
    externalId?: string | null
  ): Promise<GitHubRun | null> {
    if (externalId) {
      if (!/^[0-9]+$/.test(externalId))
        throw new Error('Invalid GitHub workflow run id');
      const response = await this.request(
        repository,
        `/actions/runs/${externalId}`
      );
      if (response.status === 404) return null;
      await this.assertOk(response, `read ${repository} workflow run`);
      const run = (await response.json()) as GitHubRun;
      if (!workflowRunMatchesOperation(run.display_title, operationKey))
        throw new Error(
          `GitHub workflow run ${externalId} does not match operation ${operationKey}`
        );
      return this.withWorkflowJobs(repository, run);
    }
    const response = await this.request(
      repository,
      `/actions/workflows/${encodeURIComponent(workflow)}/runs?event=workflow_dispatch&per_page=100`
    );
    await this.assertOk(response, `list ${repository} workflow runs`);
    const runs =
      ((await response.json()) as { workflow_runs?: GitHubRun[] })
        .workflow_runs ?? [];
    const run =
      runs.find((candidate) =>
        workflowRunMatchesOperation(candidate.display_title, operationKey)
      ) ?? null;
    return run ? this.withWorkflowJobs(repository, run) : null;
  }

  private async withWorkflowJobs(
    repository: ReleaseBusV2Repository,
    run: GitHubRun
  ): Promise<GitHubRun> {
    const response = await this.request(
      repository,
      `/actions/runs/${run.id}/jobs?filter=latest&per_page=100`
    );
    await this.assertOk(response, `read ${repository} workflow jobs`);
    const jobs =
      ((await response.json()) as { jobs?: GitHubWorkflowJob[] }).jobs ?? [];
    return { ...run, jobs: sanitizeGitHubWorkflowJobs(jobs) };
  }

  public async getWorkflowRunIdentity(
    repository: ReleaseBusV2Repository,
    workflowRunId: string
  ): Promise<ReleaseBusWorkflowRunIdentity> {
    if (!/^\d+$/.test(workflowRunId))
      throw new Error('Invalid GitHub workflow run id');
    const response = await this.request(
      repository,
      `/actions/runs/${workflowRunId}`
    );
    await this.assertOk(response, `read ${repository} workflow run`);
    const run = (await response.json()) as GitHubRun;
    const actor = run.actor?.login ?? '';
    if (!isValidGitHubWorkflowActor(actor))
      throw new Error('GitHub workflow run has no valid actor');
    if (!/^[a-f0-9]{40}$/i.test(run.head_sha))
      throw new Error('GitHub workflow run has no valid head SHA');
    return {
      actor,
      event: run.event ?? '',
      headSha: run.head_sha.toLowerCase(),
      name: run.name,
      path: run.path ?? '',
      displayTitle: run.display_title
    };
  }

  public async hasActiveStagingMutationOrE2ERun(
    repository: ReleaseBusV2Repository
  ): Promise<boolean> {
    return this.hasActiveWorkflowRun(
      repository,
      'staging mutation or E2E',
      (run) => this.isStagingMutationOrE2ERun(repository, run)
    );
  }

  public async hasStagingMutationOrE2ERunSince(
    repository: ReleaseBusV2Repository,
    since: number,
    ignoredRunIds: readonly string[] = []
  ): Promise<boolean> {
    if (!Number.isInteger(since) || since < 1)
      throw new Error('Invalid staging workflow fence timestamp');
    if (ignoredRunIds.some((runId) => !/^\d+$/.test(runId)))
      throw new Error('Invalid staging workflow fence run id');
    const ignored = new Set(ignoredRunIds.map(Number));
    const created = encodeURIComponent(`>=${new Date(since).toISOString()}`);
    for (let page = 1; page <= MAX_STAGING_FENCE_PAGES; page += 1) {
      const response = await this.request(
        repository,
        `/actions/runs?created=${created}&per_page=100&page=${page}`
      );
      await this.assertOk(
        response,
        `list ${repository} staging workflow runs since the beta handshake`
      );
      const runs =
        ((await response.json()) as { workflow_runs?: GitHubRun[] })
          .workflow_runs ?? [];
      if (
        runs.some(
          (run) =>
            !ignored.has(run.id) &&
            typeof run.created_at === 'string' &&
            Date.parse(run.created_at) >= since &&
            this.isStagingMutationOrE2ERun(repository, run)
        )
      )
        return true;
      if (runs.length < 100) return false;
    }
    // A bounded beta cannot safely prove the environment idle when more than
    // 1,000 workflow runs fit inside its fence window. Fail closed rather than
    // silently ignoring an older mutation.
    return true;
  }

  private isStagingMutationOrE2ERun(
    repository: ReleaseBusV2Repository,
    run: GitHubRun
  ): boolean {
    if (repository === 'backend') {
      return this.isBackendDeploymentRun(run, 'staging');
    }
    const paths = [
      '.github/workflows/deploy-staging.yml',
      '.github/workflows/release-bus-deploy-staging.yml',
      '.github/workflows/staging-e2e.yml'
    ];
    const legacyNames = [
      'Web Deploy - STAGING',
      'Release Bus - Deploy Frontend Staging',
      'Staging E2E'
    ];
    return paths.includes(run.path ?? '') || legacyNames.includes(run.name);
  }

  public async hasActiveProductionMutationOrE2ERun(
    repository: ReleaseBusV2Repository
  ): Promise<boolean> {
    return this.hasActiveWorkflowRun(
      repository,
      'production mutation or E2E',
      (run) => {
        if (repository === 'backend') {
          return this.isBackendDeploymentRun(run, 'prod');
        }
        const paths = [
          '.github/workflows/build-upload-deploy-prod.yml',
          '.github/workflows/release-bus-deploy-production.yml',
          '.github/workflows/production-e2e.yml'
        ];
        const legacyNames = [
          'Web Deploy - PROD',
          'Release Bus - Deploy Frontend Production',
          'Production E2E'
        ];
        return paths.includes(run.path ?? '') || legacyNames.includes(run.name);
      }
    );
  }

  private isBackendDeploymentRun(
    run: GitHubRun,
    environment: 'staging' | 'prod'
  ): boolean {
    return (
      (run.path === '.github/workflows/deploy.yml' ||
        run.name === 'Deploy a service') &&
      new RegExp(` to ${environment}(?:\\s|$)`).test(run.display_title)
    );
  }

  private async hasActiveWorkflowRun(
    repository: ReleaseBusV2Repository,
    description: string,
    matches: (run: GitHubRun) => boolean
  ): Promise<boolean> {
    for (const status of ['queued', 'in_progress']) {
      const response = await this.request(
        repository,
        `/actions/runs?status=${status}&per_page=100`
      );
      await this.assertOk(
        response,
        `list active ${repository} ${description} workflow runs`
      );
      const runs =
        ((await response.json()) as { workflow_runs?: GitHubRun[] })
          .workflow_runs ?? [];
      if (runs.some(matches)) return true;
    }
    return false;
  }

  public async ensureCommitStatus(
    repository: ReleaseBusV2Repository,
    sha: string,
    state: 'error' | 'failure' | 'pending' | 'success',
    description: string,
    context = 'Release Bus'
  ): Promise<void> {
    const normalizedDescription = description.slice(0, 140);
    const existing = await this.request(
      repository,
      `/commits/${sha}/statuses?per_page=100`
    );
    await this.assertOk(existing, `read ${repository} commit statuses`);
    const latest = ((await existing.json()) as GitHubCommitStatus[]).find(
      (status) => status.context === context
    );
    if (latest?.state === state && latest.description === normalizedDescription)
      return;
    const response = await this.request(repository, `/statuses/${sha}`, {
      method: 'POST',
      body: JSON.stringify({
        state,
        context,
        description: normalizedDescription,
        target_url: process.env.RELEASE_BUS_UI_URL
      })
    });
    await this.assertOk(response, `update ${repository} Release Bus status`);
  }

  public async refContainsCommit(
    repository: ReleaseBusV2Repository,
    ref: string,
    commitSha: string
  ): Promise<boolean> {
    const response = await this.request(
      repository,
      `/compare/${encodeURIComponent(commitSha)}...${encodeURIComponent(ref)}`
    );
    if (response.status === 404) return false;
    await this.assertOk(
      response,
      `compare ${repository} ${commitSha} with ${ref}`
    );
    const status = ((await response.json()) as { status?: string }).status;
    return status === 'ahead' || status === 'identical';
  }

  public async isOrganizationOperator(
    login: string,
    teamSlug: string
  ): Promise<boolean> {
    const teamMembership = await this.organizationRequest(
      `/orgs/${encodeURIComponent(this.owner)}/teams/${encodeURIComponent(
        teamSlug
      )}/memberships/${encodeURIComponent(login)}`
    );
    if (teamMembership.ok) {
      const membership = (await teamMembership.json()) as GitHubMembership;
      if (membership.state === 'active') return true;
    } else if (teamMembership.status !== 404) {
      await this.assertOk(teamMembership, 'verify release-bus operator team');
    }

    const organizationMembership = await this.organizationRequest(
      `/orgs/${encodeURIComponent(this.owner)}/memberships/${encodeURIComponent(
        login
      )}`
    );
    if (organizationMembership.status === 404) return false;
    await this.assertOk(
      organizationMembership,
      'verify release-bus organization owner'
    );
    const membership =
      (await organizationMembership.json()) as GitHubMembership;
    return membership.state === 'active' && membership.role === 'admin';
  }
}

export const releaseBusGitHubApp = new ReleaseBusGitHubApp();
