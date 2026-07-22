import { createSign } from 'node:crypto';
import fetch, { type RequestInit, type Response } from 'node-fetch';
import type { ReleaseRepository } from '@/releaseBus/release-bus.types';

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
type GitHubFileContent = {
  readonly type?: string;
  readonly encoding?: string;
  readonly content?: string;
  readonly size?: number;
};
type GitHubActionsVariable = { readonly value?: string };

const REPOSITORIES: Readonly<Record<ReleaseRepository, string>> = {
  frontend: '6529seize-frontend',
  backend: '6529seize-backend'
};
const MAX_WORKFLOW_JOBS = 100;
const MAX_WORKFLOW_STEPS = 100;
const MAX_WORKFLOW_LABEL_LENGTH = 500;

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
    /^release-bus\/(staging|production)-train-[A-Za-z0-9._-]+$/.test(ref)
  )
    return;
  throw new Error(`Release Bus GitHub App cannot write ref ${ref}`);
}

export class ReleaseBusGitHubApp {
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
    const response = await fetch(
      `https://api.github.com/app/installations/${installationId}/access_tokens`,
      {
        method: 'POST',
        headers: this.headers(appJwt(appId, privateKey))
      }
    );
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
    repository: ReleaseRepository,
    path: string,
    options: RequestInit = {}
  ): Promise<Response> {
    const token = await this.token();
    return fetch(
      `https://api.github.com/repos/${this.owner}/${REPOSITORIES[repository]}${path}`,
      {
        ...options,
        headers: { ...this.headers(token), ...(options.headers ?? {}) }
      }
    );
  }

  private async organizationRequest(
    path: string,
    options: RequestInit = {}
  ): Promise<Response> {
    const token = await this.token();
    return fetch(`https://api.github.com${path}`, {
      ...options,
      headers: { ...this.headers(token), ...(options.headers ?? {}) }
    });
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
    throw new Error(`Failed to ${operation}: ${message}`);
  }

  public async resolveRef(
    repository: ReleaseRepository,
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

  public async getFileContent(
    repository: ReleaseRepository,
    file: string,
    ref: string
  ): Promise<string> {
    if (
      !/^[A-Za-z0-9._/-]{1,500}$/.test(file) ||
      file.startsWith('/') ||
      file.split('/').includes('..')
    )
      throw new Error('Invalid repository file path');
    if (!/^[a-f0-9]{40}$/.test(ref)) throw new Error('Invalid file ref SHA');
    const response = await this.request(
      repository,
      `/contents/${file.split('/').map(encodeURIComponent).join('/')}?ref=${ref}`
    );
    await this.assertOk(response, `read ${repository} file ${file}`);
    const payload = (await response.json()) as GitHubFileContent;
    if (
      payload.type !== 'file' ||
      payload.encoding !== 'base64' ||
      typeof payload.content !== 'string' ||
      !Number.isInteger(payload.size) ||
      Number(payload.size) < 0 ||
      Number(payload.size) > 1_000_000
    )
      throw new Error(`Invalid GitHub file response for ${repository}:${file}`);
    const content = Buffer.from(
      payload.content.replace(/\s/g, ''),
      'base64'
    ).toString('utf8');
    if (Buffer.byteLength(content) !== payload.size)
      throw new Error(`GitHub file size mismatch for ${repository}:${file}`);
    return content;
  }

  public async getActionsVariable(
    repository: ReleaseRepository,
    name: string
  ): Promise<string | null> {
    if (!/^[A-Z][A-Z0-9_]{0,99}$/.test(name))
      throw new Error('Invalid GitHub Actions variable name');
    const response = await this.request(
      repository,
      `/actions/variables/${encodeURIComponent(name)}`
    );
    if (response.status === 404) return null;
    await this.assertOk(
      response,
      `read ${repository} Actions variable ${name}`
    );
    const value = ((await response.json()) as GitHubActionsVariable).value;
    if (typeof value !== 'string' || value.length > 500)
      throw new Error(`Invalid ${repository} Actions variable ${name}`);
    return value;
  }

  public async resolveRefIfExists(
    repository: ReleaseRepository,
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

  public async createRef(
    repository: ReleaseRepository,
    ref: string,
    sha: string
  ): Promise<void> {
    assertAllowedWritableRef(ref);
    const response = await this.request(repository, '/git/refs', {
      method: 'POST',
      body: JSON.stringify({ ref: `refs/heads/${ref}`, sha })
    });
    if (
      response.status === 422 &&
      (await this.resolveRef(repository, ref)) === sha
    )
      return;
    await this.assertOk(response, `create ${repository} ref ${ref}`);
  }

  public async updateRef(
    repository: ReleaseRepository,
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

  public async listReleaseBusRefs(
    repository: ReleaseRepository
  ): Promise<Array<{ ref: string; sha: string }>> {
    const response = await this.request(
      repository,
      '/git/matching-refs/heads/release-bus/'
    );
    await this.assertOk(response, `list ${repository} release-bus refs`);
    return ((await response.json()) as GitHubMatchingRef[])
      .map((item) => ({
        ref: item.ref.replace(/^refs\/heads\//, ''),
        sha: item.object?.sha ?? ''
      }))
      .filter((item) => item.sha.length > 0);
  }

  public async commitTimestamp(
    repository: ReleaseRepository,
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

  public async deleteReleaseBusRef(
    repository: ReleaseRepository,
    ref: string
  ): Promise<void> {
    assertAllowedWritableRef(ref);
    if (!ref.startsWith('release-bus/'))
      throw new Error(`Ref ${ref} is not a temporary release-bus branch`);
    const response = await this.request(
      repository,
      `/git/refs/heads/${encodeURIComponent(ref)}`,
      { method: 'DELETE' }
    );
    if (response.status === 404) return;
    await this.assertOk(response, `delete ${repository} ref ${ref}`);
  }

  public async dispatchWorkflow(
    repository: ReleaseRepository,
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
    repository: ReleaseRepository,
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
      if (!run.display_title.includes(operationKey))
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
        candidate.display_title.includes(operationKey)
      ) ?? null;
    return run ? this.withWorkflowJobs(repository, run) : null;
  }

  private async withWorkflowJobs(
    repository: ReleaseRepository,
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
    repository: ReleaseRepository,
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
    if (!/^[A-Za-z0-9-]{1,39}$/.test(actor))
      throw new Error('GitHub workflow run has no valid actor');
    if (!/^[a-f0-9]{40}$/i.test(run.head_sha))
      throw new Error('GitHub workflow run has no valid head SHA');
    return {
      actor,
      event: run.event ?? '',
      headSha: run.head_sha.toLowerCase(),
      name: run.name,
      displayTitle: run.display_title
    };
  }

  public async hasActiveDeploymentRun(
    repository: ReleaseRepository,
    environment: 'staging' | 'prod'
  ): Promise<boolean> {
    for (const status of ['queued', 'in_progress']) {
      const response = await this.request(
        repository,
        `/actions/runs?status=${status}&per_page=100`
      );
      await this.assertOk(
        response,
        `list active ${repository} ${environment} workflow runs`
      );
      const runs =
        ((await response.json()) as { workflow_runs?: GitHubRun[] })
          .workflow_runs ?? [];
      if (
        runs.some((run) => {
          if (repository === 'backend') {
            return (
              run.name === 'Deploy a service' &&
              run.display_title.includes(` to ${environment}`)
            );
          }
          const names =
            environment === 'prod'
              ? [
                  'Web Deploy - PROD',
                  'Release Bus - Deploy Frontend Production'
                ]
              : [
                  'Web Deploy - STAGING',
                  'Release Bus - Deploy Frontend Staging'
                ];
          return names.includes(run.name);
        })
      )
        return true;
    }
    return false;
  }

  public async createReleasePullRequest(
    repository: ReleaseRepository,
    head: string,
    title: string,
    body: string
  ): Promise<{ readonly number: number; readonly html_url: string }> {
    assertAllowedWritableRef(head);
    const response = await this.request(repository, '/pulls', {
      method: 'POST',
      body: JSON.stringify({ title, head, base: 'main', body })
    });
    if (response.status === 422) {
      const existing = await this.request(
        repository,
        `/pulls?state=open&head=${encodeURIComponent(`${this.owner}:${head}`)}&base=main&per_page=1`
      );
      await this.assertOk(existing, `find existing ${repository} release PR`);
      const pull = (
        (await existing.json()) as Array<{ number: number; html_url: string }>
      )[0];
      if (pull) return pull;
    }
    await this.assertOk(response, `create ${repository} release PR`);
    return (await response.json()) as { number: number; html_url: string };
  }

  public async commentOnPullRequest(
    repository: ReleaseRepository,
    pullNumber: number,
    body: string
  ): Promise<void> {
    const response = await this.request(
      repository,
      `/issues/${pullNumber}/comments`,
      { method: 'POST', body: JSON.stringify({ body }) }
    );
    await this.assertOk(
      response,
      `comment on ${repository} pull request ${pullNumber}`
    );
  }

  public async ensureCommitStatus(
    repository: ReleaseRepository,
    sha: string,
    state: 'error' | 'failure' | 'pending' | 'success',
    description: string
  ): Promise<void> {
    const normalizedDescription = description.slice(0, 140);
    const existing = await this.request(
      repository,
      `/commits/${sha}/statuses?per_page=100`
    );
    await this.assertOk(existing, `read ${repository} commit statuses`);
    const latest = ((await existing.json()) as GitHubCommitStatus[]).find(
      (status) => status.context === 'Release Bus'
    );
    if (latest?.state === state && latest.description === normalizedDescription)
      return;
    const response = await this.request(repository, `/statuses/${sha}`, {
      method: 'POST',
      body: JSON.stringify({
        state,
        context: 'Release Bus',
        description: normalizedDescription,
        target_url: process.env.RELEASE_BUS_UI_URL
      })
    });
    await this.assertOk(response, `update ${repository} Release Bus status`);
  }

  public async closePullRequest(
    repository: ReleaseRepository,
    pullNumber: number
  ): Promise<void> {
    const response = await this.request(repository, `/pulls/${pullNumber}`, {
      method: 'PATCH',
      body: JSON.stringify({ state: 'closed' })
    });
    await this.assertOk(
      response,
      `close ${repository} pull request ${pullNumber}`
    );
  }

  public async mergePullRequest(
    repository: ReleaseRepository,
    pullNumber: number,
    expectedHeadSha: string,
    message: string
  ): Promise<string> {
    const response = await this.request(
      repository,
      `/pulls/${pullNumber}/merge`,
      {
        method: 'PUT',
        body: JSON.stringify({
          sha: expectedHeadSha,
          merge_method: 'merge',
          commit_title: message
        })
      }
    );
    await this.assertOk(
      response,
      `merge ${repository} release PR ${pullNumber}`
    );
    const sha = ((await response.json()) as { sha?: string }).sha;
    if (!sha)
      throw new Error(
        `GitHub did not return merge SHA for ${repository} PR ${pullNumber}`
      );
    return sha;
  }

  public async refContainsCommit(
    repository: ReleaseRepository,
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
