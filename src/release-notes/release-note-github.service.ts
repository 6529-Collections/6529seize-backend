import fetch from 'node-fetch';
import deployConfig from '@/config/deploy-services.json';
import { env } from '@/env';
import { Logger } from '@/logging';
import { ReleaseNoteGenerationRequest } from './release-note-generation-queue';
import { isAllowedReleaseNotesPrompt } from './release-note-prompts.config';

interface GitHubWorkflowRun {
  readonly id: number;
  readonly name: string;
  readonly display_title: string;
  readonly head_sha: string;
  readonly run_number: number;
  readonly workflow_id: number;
  readonly head_branch?: string | null;
  readonly status?: string;
  readonly conclusion?: string | null;
  readonly created_at?: string;
  readonly path?: string;
}

interface GitHubWorkflowRunsResponse {
  readonly workflow_runs?: GitHubWorkflowRun[];
}

interface GitHubUser {
  readonly login?: string;
  readonly type?: string;
}

interface GitHubCommit {
  readonly sha: string;
  readonly author?: GitHubUser | null;
  readonly committer?: GitHubUser | null;
  readonly commit?: {
    readonly message?: string;
  };
}

interface GitHubCompareResponse {
  readonly commits?: GitHubCommit[];
  readonly total_commits?: number;
  readonly status?: string;
}

interface GitHubContentResponse {
  readonly type?: string;
  readonly encoding?: string;
  readonly content?: string;
}

interface GitHubPullRequest {
  readonly number: number;
  readonly html_url: string;
  readonly title: string;
  readonly body: string | null;
  readonly merged_at: string | null;
  readonly merge_commit_sha?: string | null;
  readonly user?: GitHubUser;
  readonly base?: {
    readonly ref?: string;
  };
}

interface GitHubPullRequestFile {
  readonly filename: string;
  readonly additions: number;
  readonly deletions: number;
  readonly changes: number;
}

export interface ReleasePullRequestContext {
  readonly number: number;
  readonly url: string;
  readonly title: string;
  readonly body: string | null;
  readonly contributors: string[];
  readonly commit_messages: string[];
  readonly changed_files: GitHubPullRequestFile[];
  readonly candidate_services: string[];
  readonly changed_files_incomplete?: boolean;
  readonly commit_contributors_incomplete?: boolean;
}

export interface GitHubReleaseContext {
  readonly previous_sha: string;
  readonly current_sha: string;
  readonly pull_requests: ReleasePullRequestContext[];
}

interface AggregatedPullRequest {
  readonly pullRequest: GitHubPullRequest;
  readonly commitMessages: Set<string>;
}

interface BoundedGitHubCollection<T> {
  readonly items: T[];
  readonly incomplete: boolean;
}

const MAX_COMPARE_PAGES = 3;
const MAX_PULL_REQUEST_COMMIT_PAGES = 3;
const MAX_FILE_PAGES = 3;
const MAX_WORKFLOW_RUN_PAGES = 10;
const PAGE_SIZE = 100;
const BACKEND_REPO = '6529seize-backend';
const FRONTEND_REPO = '6529seize-frontend';
const FRONTEND_MANUAL_PRODUCTION_WORKFLOW = 'Web Deploy - PROD';
const FRONTEND_RELEASE_BUS_PRODUCTION_WORKFLOW =
  'Release Bus - Deploy Frontend Production';
const FRONTEND_PRODUCTION_WORKFLOWS = Object.freeze({
  [FRONTEND_MANUAL_PRODUCTION_WORKFLOW]: 'build-upload-deploy-prod.yml',
  [FRONTEND_RELEASE_BUS_PRODUCTION_WORKFLOW]:
    'release-bus-deploy-production.yml'
});
const MAX_COMMITS = MAX_COMPARE_PAGES * PAGE_SIZE;
const MAX_PULL_REQUESTS = 100;
const MAX_PROMPT_LENGTH = 20000;
const MAX_GITHUB_RESPONSE_BYTES = 5 * 1024 * 1024;
const GITHUB_REQUEST_TIMEOUT_MS = 15000;
const MAX_GITHUB_ATTEMPTS = 2;
const MAX_GITHUB_CONCURRENCY = 5;
const NON_HUMAN_GITHUB_LOGINS = new Set([
  'dependabot',
  'github-actions',
  'renovate',
  'web-flow'
]);

function isApprovedFrontendProductionWorkflow(
  workflow: string
): workflow is keyof typeof FRONTEND_PRODUCTION_WORKFLOWS {
  return Object.prototype.hasOwnProperty.call(
    FRONTEND_PRODUCTION_WORKFLOWS,
    workflow
  );
}

function normalizeRepository(repo: string): string {
  return repo.includes('/') ? repo : `6529-Collections/${repo}`;
}

function getRepoName(repo: string): string {
  return repo.split('/').pop() ?? repo;
}

function normalizeBranch(branch: string | null | undefined): string {
  const trimmed = branch?.trim();
  return trimmed || 'main';
}

function isHumanGithubUser(user: GitHubUser | null | undefined): boolean {
  const login = user?.login?.trim();
  if (!login) {
    return false;
  }
  const normalizedLogin = login.toLowerCase();
  const normalizedType = user?.type?.trim().toLowerCase();
  return (
    normalizedType !== 'bot' &&
    normalizedType !== 'app' &&
    !normalizedLogin.endsWith('[bot]') &&
    !NON_HUMAN_GITHUB_LOGINS.has(normalizedLogin)
  );
}

function collectPullRequestContributors(
  pullRequest: GitHubPullRequest,
  commits: readonly GitHubCommit[]
): string[] {
  const contributors: string[] = [];
  const seen = new Set<string>();
  const addLogin = (login: string | null | undefined) => {
    const trimmed = login?.trim();
    const normalized = trimmed?.toLowerCase();
    if (
      !trimmed ||
      !normalized ||
      seen.has(normalized) ||
      normalized.endsWith('[bot]') ||
      NON_HUMAN_GITHUB_LOGINS.has(normalized)
    ) {
      return;
    }
    seen.add(normalized);
    contributors.push(trimmed);
  };

  if (isHumanGithubUser(pullRequest.user)) {
    addLogin(pullRequest.user?.login);
  }
  for (const commit of commits) {
    if (isHumanGithubUser(commit.author)) {
      addLogin(commit.author?.login);
    }
    if (isHumanGithubUser(commit.committer)) {
      addLogin(commit.committer?.login);
    }
  }
  return contributors;
}

function isMatchingProductionRun(
  run: GitHubWorkflowRun,
  request: ReleaseNoteGenerationRequest
): boolean {
  const repoName = getRepoName(request.repo);
  if (repoName === BACKEND_REPO) {
    return run.display_title.endsWith(' to prod');
  }
  if (repoName === FRONTEND_REPO) {
    return isApprovedFrontendProductionWorkflow(run.name);
  }
  return false;
}

function mergeAssociatedPullRequests(
  pullRequests: Map<number, AggregatedPullRequest>,
  branch: string,
  commit: GitHubCommit,
  associatedPullRequests: GitHubPullRequest[]
): void {
  for (const pullRequest of associatedPullRequests) {
    if (!pullRequest.merged_at || pullRequest.base?.ref !== branch) {
      continue;
    }
    const existing = pullRequests.get(pullRequest.number) ?? {
      pullRequest,
      commitMessages: new Set<string>()
    };
    const message = commit.commit?.message?.trim();
    if (message) {
      existing.commitMessages.add(message);
    }
    pullRequests.set(pullRequest.number, existing);
    if (pullRequests.size > MAX_PULL_REQUESTS) {
      throw new Error(
        `Release range exceeds maximum of ${MAX_PULL_REQUESTS} pull requests`
      );
    }
  }
}

function collectCandidateServices(
  repo: string,
  files: GitHubPullRequestFile[],
  deployedServices: string[]
): string[] {
  if (getRepoName(repo) !== BACKEND_REPO) {
    return [];
  }

  const knownServices = new Set(
    deployConfig.services.map((service) => service.name)
  );
  const normalizedDeployedServices = Array.from(
    new Set(
      deployedServices
        .map((service) => service.trim())
        .filter((service) => knownServices.has(service))
    )
  ).sort((a, b) => a.localeCompare(b));
  const deployedServiceSet = new Set(normalizedDeployedServices);
  const candidates = new Set<string>();

  for (const file of files) {
    const match = /^src\/([^/]+)\//.exec(file.filename);
    if (!match) {
      continue;
    }
    const directory = match[1];
    if (directory === 'api-serverless' && deployedServiceSet.has('api')) {
      candidates.add('api');
    } else if (
      knownServices.has(directory) &&
      deployedServiceSet.has(directory)
    ) {
      candidates.add(directory);
    }
  }

  if (candidates.size) {
    return Array.from(candidates).sort((a, b) => a.localeCompare(b));
  }

  return normalizedDeployedServices;
}

export class ReleaseNoteGitHubService {
  private readonly apiBaseUrl = 'https://api.github.com';
  private readonly logger = Logger.get(this.constructor.name);

  private async api<T>(path: string): Promise<T> {
    const token = env.getStringOrThrow('RELEASE_NOTES_GITHUB_TOKEN');
    for (let attempt = 1; attempt <= MAX_GITHUB_ATTEMPTS; attempt++) {
      const controller = new AbortController();
      const timeoutId = setTimeout(
        () => controller.abort(),
        GITHUB_REQUEST_TIMEOUT_MS
      );
      try {
        const response = await fetch(`${this.apiBaseUrl}${path}`, {
          headers: {
            Accept: 'application/vnd.github+json',
            Authorization: `Bearer ${token}`,
            'User-Agent': '6529-release-notes',
            'X-GitHub-Api-Version': '2022-11-28'
          },
          redirect: 'error',
          size: MAX_GITHUB_RESPONSE_BYTES,
          signal: controller.signal
        });
        const retryAfter = Number(response.headers.get('retry-after'));
        const isRateLimited =
          response.status === 429 ||
          (response.status === 403 &&
            response.headers.get('x-ratelimit-remaining') === '0');
        if (
          isRateLimited &&
          attempt < MAX_GITHUB_ATTEMPTS &&
          Number.isFinite(retryAfter) &&
          retryAfter > 0 &&
          retryAfter <= 5
        ) {
          await new Promise((resolve) =>
            setTimeout(resolve, retryAfter * 1000)
          );
          continue;
        }
        if (!response.ok) {
          throw new Error(
            `GitHub release context request failed: ${response.status} ${response.statusText}`
          );
        }
        return (await response.json()) as T;
      } finally {
        clearTimeout(timeoutId);
      }
    }
    throw new Error('GitHub release context request exhausted retries');
  }

  public async getReleasePrompt(
    request: ReleaseNoteGenerationRequest
  ): Promise<string> {
    if (!isAllowedReleaseNotesPrompt(request.repo, request.prompt_path)) {
      throw new Error(
        `Unsupported release notes prompt ${request.prompt_path} for ${request.repo}`
      );
    }
    const repository = normalizeRepository(request.repo);
    const promptPath = request.prompt_path
      .split('/')
      .map((segment) => encodeURIComponent(segment))
      .join('/');
    const payload = await this.api<GitHubContentResponse>(
      `/repos/${repository}/contents/${promptPath}?ref=${encodeURIComponent(request.sha)}`
    );
    if (
      payload.type !== 'file' ||
      payload.encoding !== 'base64' ||
      !payload.content
    ) {
      throw new Error(
        `Invalid release notes prompt response for ${repository}`
      );
    }
    const prompt = Buffer.from(
      payload.content.replace(/\s+/g, ''),
      'base64'
    ).toString('utf8');
    if (!prompt.trim() || prompt.length > MAX_PROMPT_LENGTH) {
      throw new Error(
        `Release notes prompt for ${repository} must be 1-${MAX_PROMPT_LENGTH} characters`
      );
    }
    return prompt.trim();
  }

  public async getReleaseContext(
    request: ReleaseNoteGenerationRequest
  ): Promise<GitHubReleaseContext | null> {
    const repository = normalizeRepository(request.repo);
    if (
      getRepoName(request.repo) === BACKEND_REPO &&
      request.pull_request_number
    ) {
      return this.getPullRequestReleaseContext(repository, request);
    }
    const previousRun = await this.findPreviousSuccessfulRun(
      repository,
      request
    );
    if (!previousRun) {
      return null;
    }

    const commits = await this.getComparedCommits(
      repository,
      previousRun.head_sha,
      request.sha
    );
    const pullRequests = await this.getPullRequests(
      repository,
      normalizeBranch(request.branch),
      commits,
      request.release_group_services
    );

    return {
      previous_sha: previousRun.head_sha,
      current_sha: request.sha,
      pull_requests: pullRequests
    };
  }

  private async getPullRequestReleaseContext(
    repository: string,
    request: ReleaseNoteGenerationRequest
  ): Promise<GitHubReleaseContext> {
    await this.getValidatedCurrentRun(repository, request);
    const pullRequestNumber = request.pull_request_number!;
    const pullRequest = await this.api<GitHubPullRequest>(
      `/repos/${repository}/pulls/${pullRequestNumber}`
    );
    const branch = normalizeBranch(request.branch);
    const mergeCommitSha = pullRequest.merge_commit_sha?.trim();
    if (
      pullRequest.number !== pullRequestNumber ||
      !pullRequest.merged_at ||
      pullRequest.base?.ref !== branch ||
      !mergeCommitSha
    ) {
      throw new Error(
        `Pull request ${pullRequestNumber} is not merged into ${branch}`
      );
    }
    if (mergeCommitSha !== request.sha) {
      const comparison = await this.api<GitHubCompareResponse>(
        `/repos/${repository}/compare/${encodeURIComponent(mergeCommitSha)}...${encodeURIComponent(request.sha)}`
      );
      if (comparison.status !== 'ahead' && comparison.status !== 'identical') {
        throw new Error(
          `Deployed commit ${request.sha} does not contain pull request ${pullRequestNumber}`
        );
      }
    }
    const [fileResult, commitResult] = await Promise.all([
      this.getPullRequestFilesBestEffort(repository, pullRequestNumber),
      this.getPullRequestCommitsBestEffort(repository, pullRequestNumber)
    ]);
    return {
      previous_sha: mergeCommitSha,
      current_sha: request.sha,
      pull_requests: [
        {
          number: pullRequest.number,
          url: pullRequest.html_url,
          title: pullRequest.title,
          body: pullRequest.body,
          contributors: collectPullRequestContributors(
            pullRequest,
            commitResult.items
          ),
          commit_messages: [pullRequest.title],
          changed_files: fileResult.items,
          candidate_services: Array.from(
            new Set(request.release_group_services)
          ).sort((a, b) => a.localeCompare(b)),
          ...(fileResult.incomplete ? { changed_files_incomplete: true } : {}),
          ...(commitResult.incomplete
            ? { commit_contributors_incomplete: true }
            : {})
        }
      ]
    };
  }

  private async getValidatedCurrentRun(
    repository: string,
    request: ReleaseNoteGenerationRequest
  ): Promise<GitHubWorkflowRun> {
    const currentRun = await this.api<GitHubWorkflowRun>(
      `/repos/${repository}/actions/runs/${encodeURIComponent(request.run_id)}`
    );
    const repoName = getRepoName(request.repo);
    const branch = normalizeBranch(request.branch);
    if (
      String(currentRun.id) !== request.run_id ||
      currentRun.head_sha !== request.sha ||
      !Number.isSafeInteger(currentRun.workflow_id) ||
      (currentRun.head_branch !== undefined &&
        currentRun.head_branch !== null &&
        currentRun.head_branch !== branch)
    ) {
      throw new Error(
        `GitHub release run ${request.run_id} does not match the queued release metadata`
      );
    }
    if (repoName === FRONTEND_REPO) {
      if (!isApprovedFrontendProductionWorkflow(request.workflow)) {
        throw new Error(
          `GitHub release run ${request.run_id} is not an approved successful frontend production workflow`
        );
      }
      const workflowFile = FRONTEND_PRODUCTION_WORKFLOWS[request.workflow];
      const runWorkflowFile =
        currentRun.path?.split('@')[0].split('/').at(-1) ?? null;
      if (
        !workflowFile ||
        currentRun.name !== request.workflow ||
        currentRun.status !== 'completed' ||
        currentRun.conclusion !== 'success' ||
        !currentRun.created_at ||
        Number.isNaN(Date.parse(currentRun.created_at)) ||
        runWorkflowFile !== workflowFile
      ) {
        throw new Error(
          `GitHub release run ${request.run_id} is not an approved successful frontend production workflow`
        );
      }
    }
    return currentRun;
  }

  private async listPreviousFrontendProductionRuns(
    repository: string,
    request: ReleaseNoteGenerationRequest,
    currentRun: GitHubWorkflowRun,
    workflowName: keyof typeof FRONTEND_PRODUCTION_WORKFLOWS
  ): Promise<GitHubWorkflowRun[]> {
    const workflowFile = FRONTEND_PRODUCTION_WORKFLOWS[workflowName];
    const branch = encodeURIComponent(normalizeBranch(request.branch));
    const currentCreatedAt = Date.parse(currentRun.created_at!);
    const matches: GitHubWorkflowRun[] = [];
    for (let page = 1; page <= MAX_WORKFLOW_RUN_PAGES; page++) {
      const payload = await this.api<GitHubWorkflowRunsResponse>(
        `/repos/${repository}/actions/workflows/${encodeURIComponent(workflowFile)}/runs?status=success&branch=${branch}&per_page=${PAGE_SIZE}&page=${page}`
      );
      const runs = payload.workflow_runs ?? [];
      for (const run of runs) {
        const runWorkflowFile =
          run.path?.split('@')[0].split('/').at(-1) ?? null;
        const createdAt = Date.parse(run.created_at ?? '');
        if (
          String(run.id) === request.run_id ||
          run.head_sha === request.sha ||
          run.name !== workflowName ||
          run.status !== 'completed' ||
          run.conclusion !== 'success' ||
          (run.head_branch !== undefined &&
            run.head_branch !== null &&
            run.head_branch !== normalizeBranch(request.branch)) ||
          runWorkflowFile !== workflowFile ||
          !Number.isFinite(createdAt) ||
          createdAt >= currentCreatedAt
        )
          continue;
        matches.push(run);
      }
      if (matches.length) break;
      if (runs.length < PAGE_SIZE) break;
      if (page === MAX_WORKFLOW_RUN_PAGES)
        throw new Error(
          `Frontend production history exceeds ${MAX_WORKFLOW_RUN_PAGES * PAGE_SIZE} runs for ${workflowName}`
        );
    }
    return matches.sort(
      (left, right) =>
        Date.parse(right.created_at!) - Date.parse(left.created_at!)
    );
  }

  private async findPreviousFrontendSuccessfulRun(
    repository: string,
    request: ReleaseNoteGenerationRequest,
    currentRun: GitHubWorkflowRun
  ): Promise<GitHubWorkflowRun | null> {
    if (request.workflow === FRONTEND_RELEASE_BUS_PRODUCTION_WORKFLOW) {
      const releaseBusRuns = await this.listPreviousFrontendProductionRuns(
        repository,
        request,
        currentRun,
        FRONTEND_RELEASE_BUS_PRODUCTION_WORKFLOW
      );
      if (releaseBusRuns.length) return releaseBusRuns[0];
      const manualRuns = await this.listPreviousFrontendProductionRuns(
        repository,
        request,
        currentRun,
        FRONTEND_MANUAL_PRODUCTION_WORKFLOW
      );
      return manualRuns[0] ?? null;
    }
    const [manualRuns, releaseBusRuns] = await Promise.all([
      this.listPreviousFrontendProductionRuns(
        repository,
        request,
        currentRun,
        FRONTEND_MANUAL_PRODUCTION_WORKFLOW
      ),
      this.listPreviousFrontendProductionRuns(
        repository,
        request,
        currentRun,
        FRONTEND_RELEASE_BUS_PRODUCTION_WORKFLOW
      )
    ]);
    return (
      [...manualRuns, ...releaseBusRuns].sort(
        (left, right) =>
          Date.parse(right.created_at!) - Date.parse(left.created_at!)
      )[0] ?? null
    );
  }

  private async findPreviousSuccessfulRun(
    repository: string,
    request: ReleaseNoteGenerationRequest
  ): Promise<GitHubWorkflowRun | null> {
    const currentRun = await this.getValidatedCurrentRun(repository, request);
    if (getRepoName(request.repo) === FRONTEND_REPO) {
      return this.findPreviousFrontendSuccessfulRun(
        repository,
        request,
        currentRun
      );
    }

    const branch = encodeURIComponent(normalizeBranch(request.branch));
    for (let page = 1; page <= MAX_WORKFLOW_RUN_PAGES; page++) {
      const payload = await this.api<GitHubWorkflowRunsResponse>(
        `/repos/${repository}/actions/workflows/${currentRun.workflow_id}/runs?status=success&branch=${branch}&per_page=${PAGE_SIZE}&page=${page}`
      );
      const runs = payload.workflow_runs ?? [];
      const previousRun = runs.find(
        (run) =>
          String(run.id) !== request.run_id &&
          run.head_sha !== request.sha &&
          run.workflow_id === currentRun.workflow_id &&
          run.run_number < currentRun.run_number &&
          isMatchingProductionRun(run, request)
      );
      if (previousRun) {
        return previousRun;
      }
      if (runs.length < PAGE_SIZE) {
        return null;
      }
    }
    throw new Error(
      `Previous successful production run was not found within ${MAX_WORKFLOW_RUN_PAGES * PAGE_SIZE} workflow runs`
    );
  }

  private async getComparedCommits(
    repository: string,
    previousSha: string,
    currentSha: string
  ): Promise<GitHubCommit[]> {
    const commits: GitHubCommit[] = [];

    for (let page = 1; page <= MAX_COMPARE_PAGES; page++) {
      const payload = await this.api<GitHubCompareResponse>(
        `/repos/${repository}/compare/${encodeURIComponent(previousSha)}...${encodeURIComponent(currentSha)}?per_page=${PAGE_SIZE}&page=${page}`
      );
      const pageCommits = payload.commits ?? [];
      const totalCommits = payload.total_commits;
      if (typeof totalCommits === 'number' && totalCommits > MAX_COMMITS) {
        throw new Error(
          `Release range contains ${totalCommits} commits; maximum is ${MAX_COMMITS}`
        );
      }
      commits.push(...pageCommits);
      if (commits.length > MAX_COMMITS) {
        throw new Error(
          `Release range exceeds maximum of ${MAX_COMMITS} commits`
        );
      }
      if (
        pageCommits.length < PAGE_SIZE ||
        (typeof totalCommits === 'number' &&
          totalCommits > 0 &&
          commits.length >= totalCommits)
      ) {
        return commits;
      }
      if (page === MAX_COMPARE_PAGES) {
        throw new Error(
          `Release range exceeds pagination maximum of ${MAX_COMMITS} commits`
        );
      }
    }

    return commits;
  }

  private async getPullRequests(
    repository: string,
    branch: string,
    commits: GitHubCommit[],
    deployedServices: string[]
  ): Promise<ReleasePullRequestContext[]> {
    const pullRequests = await this.collectPullRequests(
      repository,
      branch,
      commits
    );
    const contexts = await this.buildPullRequestContexts(
      repository,
      Array.from(pullRequests.values()),
      deployedServices
    );
    return contexts.sort((a, b) => a.number - b.number);
  }

  private async collectPullRequests(
    repository: string,
    branch: string,
    commits: GitHubCommit[]
  ): Promise<Map<number, AggregatedPullRequest>> {
    const pullRequests = new Map<number, AggregatedPullRequest>();

    for (
      let index = 0;
      index < commits.length;
      index += MAX_GITHUB_CONCURRENCY
    ) {
      const commitBatch = commits.slice(index, index + MAX_GITHUB_CONCURRENCY);
      const associatedBatch = await Promise.all(
        commitBatch.map((commit) =>
          this.api<GitHubPullRequest[]>(
            `/repos/${repository}/commits/${encodeURIComponent(commit.sha)}/pulls`
          )
        )
      );
      for (let batchIndex = 0; batchIndex < commitBatch.length; batchIndex++) {
        mergeAssociatedPullRequests(
          pullRequests,
          branch,
          commitBatch[batchIndex],
          associatedBatch[batchIndex]
        );
      }
    }

    return pullRequests;
  }

  private async buildPullRequestContexts(
    repository: string,
    pullRequests: AggregatedPullRequest[],
    deployedServices: string[]
  ): Promise<ReleasePullRequestContext[]> {
    const contexts: ReleasePullRequestContext[] = [];
    for (
      let index = 0;
      index < pullRequests.length;
      index += MAX_GITHUB_CONCURRENCY
    ) {
      const contextBatch = await Promise.all(
        pullRequests
          .slice(index, index + MAX_GITHUB_CONCURRENCY)
          .map((pullRequest) =>
            this.buildPullRequestContext(
              repository,
              pullRequest,
              deployedServices
            )
          )
      );
      contexts.push(...contextBatch);
    }
    return contexts;
  }

  private async buildPullRequestContext(
    repository: string,
    aggregate: AggregatedPullRequest,
    deployedServices: string[]
  ): Promise<ReleasePullRequestContext> {
    const { pullRequest, commitMessages } = aggregate;
    const [fileResult, commitResult] = await Promise.all([
      this.getPullRequestFilesBestEffort(repository, pullRequest.number),
      this.getPullRequestCommitsBestEffort(repository, pullRequest.number)
    ]);
    return {
      number: pullRequest.number,
      url: pullRequest.html_url,
      title: pullRequest.title,
      body: pullRequest.body,
      contributors: collectPullRequestContributors(
        pullRequest,
        commitResult.items
      ),
      commit_messages: Array.from(commitMessages),
      changed_files: fileResult.items,
      candidate_services: collectCandidateServices(
        repository,
        fileResult.items,
        deployedServices
      ),
      ...(fileResult.incomplete ? { changed_files_incomplete: true } : {}),
      ...(commitResult.incomplete
        ? { commit_contributors_incomplete: true }
        : {})
    };
  }

  private async getPullRequestCommits(
    repository: string,
    pullRequestNumber: number
  ): Promise<BoundedGitHubCollection<GitHubCommit>> {
    const commits: GitHubCommit[] = [];
    for (let page = 1; page <= MAX_PULL_REQUEST_COMMIT_PAGES; page++) {
      const pageCommits = await this.api<GitHubCommit[]>(
        `/repos/${repository}/pulls/${pullRequestNumber}/commits?per_page=${PAGE_SIZE}&page=${page}`
      );
      commits.push(...pageCommits);
      if (pageCommits.length < PAGE_SIZE) {
        return { items: commits, incomplete: false };
      }
    }
    return { items: commits, incomplete: true };
  }

  private async getPullRequestCommitsBestEffort(
    repository: string,
    pullRequestNumber: number
  ): Promise<BoundedGitHubCollection<GitHubCommit>> {
    try {
      const result = await this.getPullRequestCommits(
        repository,
        pullRequestNumber
      );
      if (result.incomplete) {
        this.logger.warn(
          `Using the first ${result.items.length} commits for release-note contributors from pull request ${pullRequestNumber}`
        );
      }
      return result;
    } catch (error) {
      this.logger.warn(
        `Generating release-note context for pull request ${pullRequestNumber} without commit contributor enrichment: ${error}`
      );
      return { items: [], incomplete: true };
    }
  }

  private async getPullRequestFiles(
    repository: string,
    pullRequestNumber: number
  ): Promise<BoundedGitHubCollection<GitHubPullRequestFile>> {
    const files: GitHubPullRequestFile[] = [];
    for (let page = 1; page <= MAX_FILE_PAGES; page++) {
      const pageFiles = await this.api<GitHubPullRequestFile[]>(
        `/repos/${repository}/pulls/${pullRequestNumber}/files?per_page=${PAGE_SIZE}&page=${page}`
      );
      files.push(
        ...pageFiles.map(({ filename, additions, deletions, changes }) => ({
          filename,
          additions,
          deletions,
          changes
        }))
      );
      if (pageFiles.length < PAGE_SIZE) {
        return { items: files, incomplete: false };
      }
    }
    return { items: files, incomplete: true };
  }

  private async getPullRequestFilesBestEffort(
    repository: string,
    pullRequestNumber: number
  ): Promise<BoundedGitHubCollection<GitHubPullRequestFile>> {
    try {
      const result = await this.getPullRequestFiles(
        repository,
        pullRequestNumber
      );
      if (result.incomplete) {
        this.logger.warn(
          `Using the first ${result.items.length} changed files for release-note context from pull request ${pullRequestNumber}`
        );
      }
      return result;
    } catch (error) {
      this.logger.warn(
        `Generating release-note context for pull request ${pullRequestNumber} without changed-file enrichment: ${error}`
      );
      return { items: [], incomplete: true };
    }
  }
}

export const releaseNoteGitHubService = new ReleaseNoteGitHubService();
