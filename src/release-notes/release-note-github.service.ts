import fetch from 'node-fetch';
import deployConfig from '@/config/deploy-services.json';
import { env } from '@/env';
import { Logger } from '@/logging';
import { ReleaseNoteGenerationRequest } from './release-note-generation-queue';
import {
  NonRetryableReleaseNoteError,
  UntrustedReleaseNoteMetadataError
} from './release-note-errors';
import { isAllowedReleaseNotesPrompt } from './release-note-prompts.config';

interface GitHubWorkflowRun {
  readonly id: number;
  readonly display_title: string;
  readonly path?: string;
  readonly head_branch?: string | null;
  readonly head_sha: string;
  readonly run_number: number;
  readonly workflow_id: number;
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
  readonly parents?: Array<{ readonly sha: string }>;
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
  readonly commit_messages?: string[];
}

interface AggregatedPullRequest {
  readonly pullRequest: GitHubPullRequest;
  readonly commitMessages: Set<string>;
}

interface BoundedGitHubCollection<T> {
  readonly items: T[];
  readonly incomplete: boolean;
}

const MAX_COMPARE_PAGES = 100;
const MAX_PULL_REQUEST_COMMIT_PAGES = 3;
const MAX_FILE_PAGES = 3;
const MAX_WORKFLOW_RUN_PAGES = 10;
const PAGE_SIZE = 100;
const BACKEND_REPO = '6529seize-backend';
const FRONTEND_REPO = '6529seize-frontend';
const CORE_REPO = '6529-core';
const FRONTEND_PRODUCTION_WORKFLOW = 'Web Deploy - PROD';
const FRONTEND_PRODUCTION_WORKFLOW_PATH =
  '.github/workflows/build-upload-deploy-prod.yml';
const CORE_PRODUCTION_WORKFLOW_PATH =
  '.github/workflows/build-all-platforms.yml';
const CORE_PRODUCTION_RUN_PREFIX = 'FLOW: Publish / ENV: Production - v';
const MAX_PROMPT_LENGTH = 20000;
const MAX_GITHUB_RESPONSE_BYTES = 5 * 1024 * 1024;
const GITHUB_REQUEST_TIMEOUT_MS = 15000;
const MAX_GITHUB_ATTEMPTS = 2;
const MAX_GITHUB_CONCURRENCY = 5;
const MAX_LOGGED_PULL_REQUEST_NUMBERS = 100;
const NON_HUMAN_GITHUB_LOGINS = new Set([
  'dependabot',
  'github-actions',
  'renovate',
  'web-flow'
]);

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
    return (
      request.workflow === FRONTEND_PRODUCTION_WORKFLOW &&
      run.path === FRONTEND_PRODUCTION_WORKFLOW_PATH &&
      run.head_branch === normalizeBranch(request.branch)
    );
  }
  if (repoName === CORE_REPO) {
    return (
      request.workflow === 'Publish' &&
      run.path === CORE_PRODUCTION_WORKFLOW_PATH &&
      run.display_title.startsWith(CORE_PRODUCTION_RUN_PREFIX)
    );
  }
  return false;
}

function getFirstParentReleaseCommits(
  commits: GitHubCommit[],
  previousSha: string,
  currentSha: string,
  repository: string
): GitHubCommit[] {
  if (!commits.length) {
    return [];
  }
  const commitsBySha = new Map(commits.map((commit) => [commit.sha, commit]));
  const releaseCommits: GitHubCommit[] = [];
  const visited = new Set<string>();
  let cursor = currentSha;

  while (cursor !== previousSha) {
    if (visited.has(cursor)) {
      throw new NonRetryableReleaseNoteError(
        `Release first-parent history for ${repository} contains a cycle`
      );
    }
    visited.add(cursor);
    const commit = commitsBySha.get(cursor);
    if (!commit) {
      throw new NonRetryableReleaseNoteError(
        `Release first-parent commit ${cursor} for ${repository} is missing from the GitHub comparison`
      );
    }
    const parents = commit.parents ?? [];
    if (parents[0]?.sha === previousSha) {
      releaseCommits.push(commit);
      return releaseCommits.reverse();
    }
    if (parents.slice(1).some((parent) => parent.sha === previousSha)) {
      return releaseCommits.reverse();
    }
    releaseCommits.push(commit);
    const firstParent = parents[0]?.sha;
    if (!firstParent) {
      throw new NonRetryableReleaseNoteError(
        `Release history for ${repository} did not reach previous production commit ${previousSha}`
      );
    }
    cursor = firstParent;
  }

  return releaseCommits.reverse();
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
      throw new NonRetryableReleaseNoteError(
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
      throw new NonRetryableReleaseNoteError(
        `Invalid release notes prompt response for ${repository}`
      );
    }
    const prompt = Buffer.from(
      payload.content.replace(/\s+/g, ''),
      'base64'
    ).toString('utf8');
    if (!prompt.trim() || prompt.length > MAX_PROMPT_LENGTH) {
      throw new NonRetryableReleaseNoteError(
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

    const comparedCommits = await this.getComparedCommits(
      repository,
      previousRun.head_sha,
      request.sha
    );
    const repoName = getRepoName(request.repo);
    const desktopRelease = repoName === CORE_REPO;
    const mainlineRelease = desktopRelease || repoName === FRONTEND_REPO;
    const commits = mainlineRelease
      ? getFirstParentReleaseCommits(
          comparedCommits,
          previousRun.head_sha,
          request.sha,
          repository
        )
      : comparedCommits;
    this.logger.info('Resolved GitHub release-note commit range', {
      repository,
      run_id: request.run_id,
      previous_sha: previousRun.head_sha,
      current_sha: request.sha,
      compared_commit_count: comparedCommits.length,
      discovery_commit_count: commits.length,
      mainline_discovery: mainlineRelease
    });
    const pullRequests = await this.getPullRequests(
      repository,
      desktopRelease ? 'main' : normalizeBranch(request.branch),
      commits,
      request.release_group_services
    );
    this.logger.info('Resolved GitHub release-note context', {
      repository,
      run_id: request.run_id,
      pull_request_count: pullRequests.length,
      pull_request_numbers: pullRequests
        .slice(0, MAX_LOGGED_PULL_REQUEST_NUMBERS)
        .map((pullRequest) => pullRequest.number),
      pull_request_numbers_truncated:
        pullRequests.length > MAX_LOGGED_PULL_REQUEST_NUMBERS
    });

    return {
      previous_sha: previousRun.head_sha,
      current_sha: request.sha,
      pull_requests: pullRequests,
      ...(desktopRelease
        ? {
            commit_messages: commits
              .map((commit) => commit.commit?.message?.trim())
              .filter((message): message is string => Boolean(message))
          }
        : {})
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
      throw new NonRetryableReleaseNoteError(
        `Pull request ${pullRequestNumber} is not merged into ${branch}`
      );
    }
    if (mergeCommitSha !== request.sha) {
      const comparison = await this.api<GitHubCompareResponse>(
        `/repos/${repository}/compare/${encodeURIComponent(mergeCommitSha)}...${encodeURIComponent(request.sha)}`
      );
      if (comparison.status !== 'ahead' && comparison.status !== 'identical') {
        throw new NonRetryableReleaseNoteError(
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
    if (
      String(currentRun.id) !== request.run_id ||
      currentRun.head_sha !== request.sha ||
      !Number.isSafeInteger(currentRun.workflow_id) ||
      !Number.isSafeInteger(currentRun.run_number) ||
      (((getRepoName(request.repo) === FRONTEND_REPO &&
        request.workflow === FRONTEND_PRODUCTION_WORKFLOW) ||
        getRepoName(request.repo) === CORE_REPO) &&
        !isMatchingProductionRun(currentRun, request))
    ) {
      throw new UntrustedReleaseNoteMetadataError(
        `GitHub release run ${request.run_id} does not match the queued release metadata`
      );
    }
    return currentRun;
  }

  private async findPreviousSuccessfulRun(
    repository: string,
    request: ReleaseNoteGenerationRequest
  ): Promise<GitHubWorkflowRun | null> {
    const currentRun = await this.getValidatedCurrentRun(repository, request);

    const repoName = getRepoName(request.repo);
    const branchQuery =
      repoName === CORE_REPO
        ? ''
        : `&branch=${encodeURIComponent(normalizeBranch(request.branch))}`;
    for (let page = 1; page <= MAX_WORKFLOW_RUN_PAGES; page++) {
      const payload = await this.api<GitHubWorkflowRunsResponse>(
        `/repos/${repository}/actions/workflows/${currentRun.workflow_id}/runs?status=success${branchQuery}&per_page=${PAGE_SIZE}&page=${page}`
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
    throw new NonRetryableReleaseNoteError(
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
      commits.push(...pageCommits);
      if (
        pageCommits.length < PAGE_SIZE ||
        (typeof totalCommits === 'number' &&
          totalCommits > 0 &&
          commits.length >= totalCommits)
      ) {
        return commits;
      }
    }

    throw new NonRetryableReleaseNoteError(
      `Release comparison did not complete within ${MAX_COMPARE_PAGES * PAGE_SIZE} commits`
    );
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
