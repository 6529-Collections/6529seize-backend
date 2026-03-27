import fetch, {
  RequestInit as NodeFetchRequestInit,
  Response
} from 'node-fetch';
import { BadRequestException, CustomApiCompliantException } from '@/exceptions';
import { Logger } from '@/logging';
import {
  DEPLOY_ENVIRONMENTS,
  DEPLOY_REPO_NAME,
  DEPLOY_REPO_OWNER,
  DEPLOY_WORKFLOW_FILE,
  DeployEnvironment,
  isDeployEnvironment
} from '@/api/deploy/deploy.config';

type GitHubApiError = {
  message?: string;
};

type GitHubViewer = {
  login: string;
};

type GitHubBranch = {
  name: string;
};

type GitHubTag = {
  name: string;
};

type GitHubWorkflowRun = {
  id: number;
  html_url: string;
  status: string;
  conclusion: string | null;
  created_at: string;
  updated_at: string;
  run_started_at: string | null;
  head_branch: string;
  display_title: string;
  actor?: {
    login?: string;
  };
};

type GitHubWorkflowRunsResponse = {
  total_count?: number;
  workflow_runs: GitHubWorkflowRun[];
};

export type DeployWorkflowRun = {
  id: number;
  url: string;
  status: string;
  conclusion: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  ref: string;
  title: string;
  service: string | null;
  environment: DeployEnvironment | null;
  actor: string | null;
};

export type DeployWorkflowRunsPage = {
  runs: DeployWorkflowRun[];
  page: number;
  page_size: number;
  total_count: number | null;
  has_previous_page: boolean;
  has_next_page: boolean;
};

export type DeployRefOption = {
  name: string;
  type: 'branch' | 'tag';
};

export class GitHubDeployService {
  private readonly logger = Logger.get(this.constructor.name);
  private readonly apiBase = `https://api.github.com/repos/${DEPLOY_REPO_OWNER}/${DEPLOY_REPO_NAME}`;
  private readonly requestTimeoutMs = 15000;

  private buildGitHubHeaders(
    token: string,
    extraHeaders?: NodeFetchRequestInit['headers']
  ) {
    const baseHeaders = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': '6529-seize-deploy-ui',
      'X-GitHub-Api-Version': '2022-11-28'
    };

    if (!extraHeaders) {
      return baseHeaders;
    }

    return {
      ...baseHeaders,
      ...extraHeaders
    };
  }

  private async getErrorMessage(response: Response): Promise<string> {
    try {
      const payload = (await response.json()) as GitHubApiError;
      return payload.message ?? `${response.status} ${response.statusText}`;
    } catch {
      return `${response.status} ${response.statusText}`;
    }
  }

  private async api(
    token: string,
    path: string,
    options: NodeFetchRequestInit = {}
  ) {
    const response = await this.fetchWithTimeout(`${this.apiBase}${path}`, {
      ...options,
      headers: this.buildGitHubHeaders(token, {
        'Content-Type': 'application/json',
        ...(options.headers ?? undefined)
      })
    });

    return response;
  }

  private async fetchWithTimeout(
    url: string,
    options: NodeFetchRequestInit = {}
  ): Promise<Response> {
    const controller = new AbortController();
    const outerSignal = options.signal;
    let timedOut = false;
    const timeoutId = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.requestTimeoutMs);

    const onOuterAbort = () => controller.abort();
    if (outerSignal) {
      if (outerSignal.aborted) {
        clearTimeout(timeoutId);
        controller.abort();
      } else {
        outerSignal.addEventListener('abort', onOuterAbort, {
          once: true
        });
      }
    }

    try {
      const signal = controller.signal as NodeFetchRequestInit['signal'];

      return await fetch(url, {
        ...options,
        signal
      });
    } catch (error) {
      if (error instanceof CustomApiCompliantException) {
        throw error;
      }

      if (error instanceof Error && error.name === 'AbortError') {
        if (timedOut) {
          throw new CustomApiCompliantException(
            504,
            `GitHub request timed out after ${this.requestTimeoutMs}ms`
          );
        }

        throw new CustomApiCompliantException(
          502,
          'GitHub request was aborted'
        );
      }

      throw new CustomApiCompliantException(
        502,
        `GitHub request failed: ${
          error instanceof Error ? error.message : 'Unknown fetch error'
        }`
      );
    } finally {
      clearTimeout(timeoutId);
      outerSignal?.removeEventListener('abort', onOuterAbort);
    }
  }

  private parseDeployTitle(title: string): {
    service: string | null;
    environment: DeployEnvironment | null;
  } {
    const match = new RegExp(
      `^Deploy (.+) to (${DEPLOY_ENVIRONMENTS.join('|')})$`
    ).exec(title);
    if (!match) {
      return {
        service: null,
        environment: null
      };
    }

    const environment = match[2];
    if (!isDeployEnvironment(environment)) {
      return {
        service: null,
        environment: null
      };
    }

    return {
      service: match[1],
      environment
    };
  }

  private hasLinkRelation(response: Response, relation: string): boolean {
    const linkHeader = response.headers.get('link');
    if (!linkHeader) {
      return false;
    }

    return linkHeader.includes(`rel="${relation}"`);
  }

  private async listBranches(token: string, limit: number): Promise<string[]> {
    const response = await this.api(
      token,
      `/branches?per_page=${Math.max(1, Math.min(limit, 100))}`,
      {
        method: 'GET'
      }
    );

    if (!response.ok) {
      const message = await this.getErrorMessage(response);
      if (response.status === 401 || response.status === 403) {
        throw new CustomApiCompliantException(
          response.status,
          `Failed to load branches from GitHub: ${message}`
        );
      }
      throw new CustomApiCompliantException(
        502,
        `Failed to load branches from GitHub: ${message}`
      );
    }

    const payload = (await response.json()) as GitHubBranch[];
    return payload.map((branch) => branch.name);
  }

  private async listTags(token: string, limit: number): Promise<string[]> {
    const response = await this.api(
      token,
      `/tags?per_page=${Math.max(1, Math.min(limit, 100))}`,
      {
        method: 'GET'
      }
    );

    if (!response.ok) {
      const message = await this.getErrorMessage(response);
      if (response.status === 401 || response.status === 403) {
        throw new CustomApiCompliantException(
          response.status,
          `Failed to load tags from GitHub: ${message}`
        );
      }
      throw new CustomApiCompliantException(
        502,
        `Failed to load tags from GitHub: ${message}`
      );
    }

    const payload = (await response.json()) as GitHubTag[];
    return payload.map((tag) => tag.name);
  }

  private scoreRefMatch(name: string, query: string): number {
    if (!query) {
      return 0;
    }

    const lowerName = name.toLowerCase();
    const lowerQuery = query.toLowerCase();
    if (lowerName === lowerQuery) {
      return 0;
    }
    if (lowerName.startsWith(lowerQuery)) {
      return 1;
    }
    if (lowerName.includes(`/${lowerQuery}`)) {
      return 2;
    }
    if (lowerName.includes(lowerQuery)) {
      return 3;
    }
    return 4;
  }

  public async dispatchDeploy(params: {
    token: string;
    ref: string;
    service: string;
    environment: DeployEnvironment;
  }): Promise<void> {
    const response = await this.api(
      params.token,
      `/actions/workflows/${DEPLOY_WORKFLOW_FILE}/dispatches`,
      {
        method: 'POST',
        body: JSON.stringify({
          ref: params.ref,
          inputs: {
            environment: params.environment,
            service: params.service
          }
        })
      }
    );

    if (response.ok) {
      this.logger.info(
        `GitHub deploy dispatch accepted [service ${params.service}] [environment ${params.environment}] [ref ${params.ref}]`
      );
      return;
    }

    const message = await this.getErrorMessage(response);
    if (response.status === 401 || response.status === 403) {
      throw new CustomApiCompliantException(
        response.status,
        `GitHub token cannot dispatch workflows: ${message}`
      );
    }
    if (response.status === 404) {
      throw new CustomApiCompliantException(
        503,
        `Deploy workflow ${DEPLOY_WORKFLOW_FILE} is not reachable: ${message}`
      );
    }
    if (response.status === 422) {
      throw new BadRequestException(
        `GitHub rejected deploy request for ${params.service} on ref ${params.ref}: ${message}`
      );
    }

    throw new CustomApiCompliantException(
      502,
      `GitHub deploy dispatch failed: ${message}`
    );
  }

  public async listRecentRuns(params: {
    token: string;
    page?: number;
    pageSize?: number;
  }): Promise<DeployWorkflowRunsPage> {
    const page = Math.max(1, Math.floor(params.page ?? 1));
    const perPage = Math.max(1, Math.min(Math.floor(params.pageSize ?? 8), 50));
    const response = await this.api(
      params.token,
      `/actions/workflows/${DEPLOY_WORKFLOW_FILE}/runs?event=workflow_dispatch&per_page=${perPage}&page=${page}`,
      {
        method: 'GET'
      }
    );

    if (!response.ok) {
      const message = await this.getErrorMessage(response);
      if (response.status === 401 || response.status === 403) {
        throw new CustomApiCompliantException(
          response.status,
          `GitHub token cannot list workflow runs: ${message}`
        );
      }
      throw new CustomApiCompliantException(
        502,
        `Failed to load deploy workflow runs: ${message}`
      );
    }

    const payload = (await response.json()) as GitHubWorkflowRunsResponse;
    const runs = payload.workflow_runs.map((run) => {
      const parsedTitle = this.parseDeployTitle(run.display_title);
      return {
        id: run.id,
        url: run.html_url,
        status: run.status,
        conclusion: run.conclusion,
        created_at: run.created_at,
        updated_at: run.updated_at,
        started_at: run.run_started_at,
        ref: run.head_branch,
        title: run.display_title,
        service: parsedTitle.service,
        environment: parsedTitle.environment,
        actor: run.actor?.login ?? null
      };
    });

    const totalCount =
      typeof payload.total_count === 'number' ? payload.total_count : null;

    return {
      runs,
      page,
      page_size: perPage,
      total_count: totalCount,
      has_previous_page: page > 1,
      has_next_page:
        totalCount === null
          ? this.hasLinkRelation(response, 'next')
          : page * perPage < totalCount
    };
  }

  public async getViewer(token: string): Promise<GitHubViewer> {
    const response = await this.fetchWithTimeout(
      'https://api.github.com/user',
      {
        method: 'GET',
        headers: this.buildGitHubHeaders(token)
      }
    );

    if (!response.ok) {
      const message = await this.getErrorMessage(response);
      if (response.status === 401 || response.status === 403) {
        throw new CustomApiCompliantException(
          401,
          `GitHub token is invalid or lacks repo access: ${message}`
        );
      }
      throw new CustomApiCompliantException(
        502,
        `Failed to validate GitHub token: ${message}`
      );
    }

    return (await response.json()) as GitHubViewer;
  }

  public async listRefs(
    token: string,
    query: string,
    limit = 20
  ): Promise<DeployRefOption[]> {
    const trimmedQuery = query.trim().toLowerCase();
    const [branchesResult, tagsResult] = await Promise.allSettled([
      this.listBranches(token, 100),
      this.listTags(token, 100)
    ]);

    const branches =
      branchesResult.status === 'fulfilled' ? branchesResult.value : [];
    const tags = tagsResult.status === 'fulfilled' ? tagsResult.value : [];

    if (branchesResult.status === 'rejected') {
      this.logger.warn(
        `Failed to load deploy branches from GitHub: ${branchesResult.reason}`
      );
    }

    if (tagsResult.status === 'rejected') {
      this.logger.warn(
        `Failed to load deploy tags from GitHub: ${tagsResult.reason}`
      );
    }

    if (
      branchesResult.status === 'rejected' &&
      tagsResult.status === 'rejected'
    ) {
      const firstError = branchesResult.reason ?? tagsResult.reason;
      throw firstError instanceof Error
        ? firstError
        : new CustomApiCompliantException(
            502,
            'Failed to load refs from GitHub'
          );
    }

    const refs = [
      ...branches.map<DeployRefOption>((name) => ({
        name,
        type: 'branch'
      })),
      ...tags.map<DeployRefOption>((name) => ({
        name,
        type: 'tag'
      }))
    ].filter((ref) =>
      trimmedQuery ? ref.name.toLowerCase().includes(trimmedQuery) : true
    );

    refs.sort((a, b) => {
      const scoreDifference =
        this.scoreRefMatch(a.name, trimmedQuery) -
        this.scoreRefMatch(b.name, trimmedQuery);
      if (scoreDifference !== 0) {
        return scoreDifference;
      }
      if (a.type !== b.type) {
        return a.type === 'branch' ? -1 : 1;
      }
      return a.name.localeCompare(b.name);
    });

    return refs.slice(0, Math.max(1, Math.min(limit, 50)));
  }
}

export const gitHubDeployService = new GitHubDeployService();
