import fetch, { Response } from 'node-fetch';
import deployConfig from '@/config/deploy-services.json';
import { env } from '@/env';
import { ReleaseNoteGenerationRequest } from './release-note-generation-queue';

interface GitHubWorkflowRun {
  readonly id: number;
  readonly name: string;
  readonly display_title: string;
  readonly head_sha: string;
  readonly run_number: number;
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

const MAX_COMPARE_PAGES = 10;
const MAX_FILE_PAGES = 3;
const PAGE_SIZE = 100;
const BACKEND_REPO = '6529seize-backend';

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

function isMatchingBackendRun(
  run: GitHubWorkflowRun,
  request: ReleaseNoteGenerationRequest
): boolean {
  if (getRepoName(request.repo) !== BACKEND_REPO) {
    return true;
  }
  return run.display_title.endsWith(' to prod');
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
  const candidates = new Set<string>();
  for (const deployedService of deployedServices) {
    const normalizedDeployedService = deployedService.trim();
    if (knownServices.has(normalizedDeployedService)) {
      candidates.add(normalizedDeployedService);
    }
  }

  for (const file of files) {
    const match = /^src\/([^/]+)\//.exec(file.filename);
    if (!match) {
      continue;
    }
    const directory = match[1];
    if (directory === 'api-serverless') {
      candidates.add('api');
    } else if (knownServices.has(directory)) {
      candidates.add(directory);
    }
  }

  return Array.from(candidates).sort((a, b) => a.localeCompare(b));
}

export class ReleaseNoteGitHubService {
  private readonly apiBaseUrl = 'https://api.github.com';

  private async api(path: string): Promise<Response> {
    const token = env.getStringOrThrow('RELEASE_NOTES_GITHUB_TOKEN');
    const response = await fetch(`${this.apiBaseUrl}${path}`, {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'User-Agent': '6529-release-notes',
        'X-GitHub-Api-Version': '2022-11-28'
      }
    });
    if (!response.ok) {
      throw new Error(
        `GitHub release context request failed: ${response.status} ${response.statusText}`
      );
    }
    return response;
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
    const branch = encodeURIComponent(normalizeBranch(request.branch));
    const response = await this.api(
      `/repos/${repository}/actions/runs?status=success&branch=${branch}&per_page=${PAGE_SIZE}`
    );
    const payload = (await response.json()) as GitHubWorkflowRunsResponse;
    const currentRunNumber = Number(request.run_number);

    return (
      payload.workflow_runs?.find(
        (run) =>
          String(run.id) !== request.run_id &&
          run.head_sha !== request.sha &&
          run.name === request.workflow &&
          (!Number.isFinite(currentRunNumber) ||
            run.run_number < currentRunNumber) &&
          isMatchingBackendRun(run, request)
      ) ?? null
    );
  }

  private async getComparedCommits(
    repository: string,
    previousSha: string,
    currentSha: string
  ): Promise<GitHubCommit[]> {
    const commits: GitHubCommit[] = [];

    for (let page = 1; page <= MAX_COMPARE_PAGES; page++) {
      const response = await this.api(
        `/repos/${repository}/compare/${encodeURIComponent(previousSha)}...${encodeURIComponent(currentSha)}?per_page=${PAGE_SIZE}&page=${page}`
      );
      const payload = (await response.json()) as GitHubCompareResponse;
      const pageCommits = payload.commits ?? [];
      commits.push(...pageCommits);
      if (
        pageCommits.length < PAGE_SIZE ||
        commits.length >= (payload.total_commits ?? 0)
      ) {
        break;
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
    const pullRequests = new Map<
      number,
      {
        pullRequest: GitHubPullRequest;
        commitMessages: Set<string>;
        contributors: Set<string>;
      }
    >();

    for (const commit of commits) {
      const response = await this.api(
        `/repos/${repository}/commits/${encodeURIComponent(commit.sha)}/pulls`
      );
      const associatedPullRequests =
        (await response.json()) as GitHubPullRequest[];
      for (const pullRequest of associatedPullRequests) {
        if (!pullRequest.merged_at || pullRequest.base?.ref !== branch) {
          continue;
        }
        const existing = pullRequests.get(pullRequest.number) ?? {
          pullRequest,
          commitMessages: new Set<string>(),
          contributors: new Set<string>()
        };
        const pullRequestAuthor = pullRequest.user?.login?.trim();
        const commitAuthor = commit.author?.login?.trim();
        if (pullRequestAuthor) {
          existing.contributors.add(pullRequestAuthor);
        }
        if (commitAuthor) {
          existing.contributors.add(commitAuthor);
        }
        const message = commit.commit?.message?.trim();
        if (message) {
          existing.commitMessages.add(message);
        }
        pullRequests.set(pullRequest.number, existing);
      }
    }

    const contexts = await Promise.all(
      Array.from(pullRequests.values()).map(
        async ({ pullRequest, commitMessages, contributors }) => {
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
      )
    );

    return contexts.sort((a, b) => a.number - b.number);
  }

  private async getPullRequestFiles(
    repository: string,
    pullRequestNumber: number
  ): Promise<GitHubPullRequestFile[]> {
    const files: GitHubPullRequestFile[] = [];
    for (let page = 1; page <= MAX_FILE_PAGES; page++) {
      const response = await this.api(
        `/repos/${repository}/pulls/${pullRequestNumber}/files?per_page=${PAGE_SIZE}&page=${page}`
      );
      const pageFiles = (await response.json()) as GitHubPullRequestFile[];
      files.push(...pageFiles);
      if (pageFiles.length < PAGE_SIZE) {
        break;
      }
    }
    return files;
  }
}

export const releaseNoteGitHubService = new ReleaseNoteGitHubService();
