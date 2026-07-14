import fetch from 'node-fetch';
import deployConfig from '@/config/deploy-services.json';
import { env } from '@/env';
import { ReleaseNoteGenerationRequest } from './release-note-generation-queue';
import { isAllowedReleaseNotesPrompt } from './release-note-prompts.config';

interface GitHubWorkflowRun {
  readonly id: number;
  readonly name: string;
  readonly display_title: string;
  readonly head_sha: string;
  readonly run_number: number;
  readonly workflow_id: number;
}

interface GitHubWorkflowRunsResponse {
  readonly workflow_runs?: GitHubWorkflowRun[];
}

interface GitHubCommit {
  readonly sha: string;
  readonly author?: {
    readonly login?: string;
  } | null;
  readonly commit?: {
    readonly message?: string;
  };
}

interface GitHubCompareResponse {
  readonly commits?: GitHubCommit[];
  readonly total_commits?: number;
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
  readonly user?: {
    readonly login?: string;
  };
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
}

export interface GitHubReleaseContext {
  readonly previous_sha: string;
  readonly current_sha: string;
  readonly pull_requests: ReleasePullRequestContext[];
}

interface AggregatedPullRequest {
  readonly pullRequest: GitHubPullRequest;
  readonly commitMessages: Set<string>;
  readonly contributors: Set<string>;
}

const MAX_COMPARE_PAGES = 3;
const MAX_FILE_PAGES = 3;
const MAX_WORKFLOW_RUN_PAGES = 10;
const PAGE_SIZE = 100;
const BACKEND_REPO = '6529seize-backend';
const FRONTEND_REPO = '6529seize-frontend';
const FRONTEND_PRODUCTION_WORKFLOW = 'Web Deploy - PROD';
const MAX_COMMITS = MAX_COMPARE_PAGES * PAGE_SIZE;
const MAX_PULL_REQUESTS = 100;
const MAX_TOTAL_CHANGED_FILES = 3000;
const MAX_PROMPT_LENGTH = 20000;
const MAX_GITHUB_RESPONSE_BYTES = 5 * 1024 * 1024;
const GITHUB_REQUEST_TIMEOUT_MS = 15000;
const MAX_GITHUB_ATTEMPTS = 2;
const MAX_GITHUB_CONCURRENCY = 5;

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
      run.name === FRONTEND_PRODUCTION_WORKFLOW
    );
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
      commitMessages: new Set<string>(),
      contributors: new Set<string>()
    };
    const contributors = [
      pullRequest.user?.login?.trim(),
      commit.author?.login?.trim()
    ].filter((login): login is string => Boolean(login));
    contributors.forEach((login) => existing.contributors.add(login));
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

  private async findPreviousSuccessfulRun(
    repository: string,
    request: ReleaseNoteGenerationRequest
  ): Promise<GitHubWorkflowRun | null> {
    const currentRun = await this.api<GitHubWorkflowRun>(
      `/repos/${repository}/actions/runs/${encodeURIComponent(request.run_id)}`
    );
    if (
      String(currentRun.id) !== request.run_id ||
      currentRun.head_sha !== request.sha ||
      !Number.isSafeInteger(currentRun.workflow_id)
    ) {
      throw new Error(
        `GitHub release run ${request.run_id} does not match the queued release metadata`
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
    const totalChangedFiles = contexts.reduce(
      (total, context) => total + context.changed_files.length,
      0
    );
    if (totalChangedFiles > MAX_TOTAL_CHANGED_FILES) {
      throw new Error(
        `Release context exceeds maximum of ${MAX_TOTAL_CHANGED_FILES} changed files`
      );
    }

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
    const { pullRequest, commitMessages, contributors } = aggregate;
    const files = await this.getPullRequestFiles(
      repository,
      pullRequest.number
    );
    return {
      number: pullRequest.number,
      url: pullRequest.html_url,
      title: pullRequest.title,
      body: pullRequest.body,
      contributors: Array.from(contributors),
      commit_messages: Array.from(commitMessages),
      changed_files: files,
      candidate_services: collectCandidateServices(
        repository,
        files,
        deployedServices
      )
    };
  }

  private async getPullRequestFiles(
    repository: string,
    pullRequestNumber: number
  ): Promise<GitHubPullRequestFile[]> {
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
        break;
      }
      if (page === MAX_FILE_PAGES) {
        throw new Error(
          `Pull request ${pullRequestNumber} exceeds maximum of ${MAX_FILE_PAGES * PAGE_SIZE} changed files`
        );
      }
    }
    return files;
  }
}

export const releaseNoteGitHubService = new ReleaseNoteGitHubService();
