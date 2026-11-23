'use strict';

const DEPLOY_WORKFLOW = 'deploy.yml';
const TRAIN_WORKFLOW = 'deploy-train.yml';
const DAY_MS = 24 * 60 * 60 * 1000;
const WINDOW_DAYS = 30;
const MAX_FILTERED_RESULTS = 1000;
const DEPLOY_TITLE = /^Deploy (\S+) to (prod|staging)$/;

function deployBranch(environment) {
  return environment === 'prod' ? 'main' : '1a-staging';
}

/** Minimal GitHub REST client; `fetchImpl` is injectable for tests. */
function createGitHubClient({
  token,
  repository,
  apiUrl = 'https://api.github.com',
  fetchImpl = globalThis.fetch,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
}) {
  if (!token) throw new Error('A GitHub token (GH_TOKEN) is required');
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository || '')) {
    throw new Error('repository must look like owner/name');
  }
  const base = `${apiUrl.replace(/\/$/, '')}/repos/${repository}`;

  async function send(method, path, body) {
    const response = await fetchImpl(`${base}${path}`, {
      method,
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'x-github-api-version': '2022-11-28',
        ...(body ? { 'content-type': 'application/json' } : {})
      },
      body: body ? JSON.stringify(body) : undefined
    });
    const text = await response.text();
    if (!response.ok) {
      const error = new Error(
        `GitHub ${method} ${path} failed: ${response.status} ${text.slice(0, 200)}`
      );
      error.status = response.status;
      throw error;
    }
    return text ? JSON.parse(text) : null;
  }

  /** Reads retry transient failures; writes never retry. */
  async function request(method, path, body) {
    const attempts = method === 'GET' ? 3 : 1;
    for (let attempt = 1; ; attempt++) {
      try {
        return await send(method, path, body);
      } catch (error) {
        const transient = !error.status || error.status >= 500;
        if (!transient || attempt >= attempts) throw error;
        await sleep(attempt * 10_000);
      }
    }
  }

  return {
    repository,
    request,
    listWorkflowRuns(workflow, params) {
      const query = new URLSearchParams(params).toString();
      return request('GET', `/actions/workflows/${workflow}/runs?${query}`);
    },
    getRun(runId) {
      return request('GET', `/actions/runs/${runId}`);
    },
    async listRunJobs(runId) {
      const result = await request(
        'GET',
        `/actions/runs/${runId}/jobs?per_page=100`
      );
      return result.jobs || [];
    },
    async getBranchSha(branch) {
      const result = await request(
        'GET',
        `/git/ref/heads/${encodeURIComponent(branch)}`
      );
      return result.object.sha;
    },
    /** Dispatches a workflow; returns the run ID when GitHub reports it. */
    async dispatchWorkflow(workflow, ref, inputs) {
      const path = `/actions/workflows/${workflow}/dispatches`;
      try {
        const result = await request('POST', path, {
          ref,
          inputs,
          return_run_details: true
        });
        return (result && result.workflow_run_id) || null;
      } catch (error) {
        if (error.status !== 422) throw error;
        await request('POST', path, { ref, inputs });
        return null;
      }
    },
    async pullRequestsForCommit(sha) {
      const result = await request('GET', `/commits/${sha}/pulls`);
      return (result || []).filter((pull) => pull.merged_at);
    }
  };
}

function isoSecond(time) {
  return new Date(time).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * The newest successful `Deploy <service> to <environment>` run of each
 * service, from the deploy workflow's history. GitHub returns at most 1000
 * filtered results per query, so history is read in created-date windows
 * from newest to oldest, splitting any window that hits the limit.
 */
async function findDeployedCommits({
  client,
  environment,
  services,
  now = Date.now(),
  historyStart = Date.parse('2025-11-01T00:00:00Z')
}) {
  const wanted = new Set(services);
  const found = new Map();
  const branch = deployBranch(environment);

  const consider = (run) => {
    const match = DEPLOY_TITLE.exec(run.display_title || '');
    if (!match || match[2] !== environment || !wanted.has(match[1])) return;
    if (run.head_branch !== branch || run.conclusion !== 'success') return;
    const startedAt = run.run_started_at || run.created_at;
    const current = found.get(match[1]);
    if (current && current.started_at >= startedAt) return;
    found.set(match[1], {
      sha: run.head_sha,
      run_id: run.id,
      run_url: run.html_url,
      started_at: startedAt,
      completed_at: run.updated_at,
      actor: (run.triggering_actor && run.triggering_actor.login) || null
    });
  };

  const scan = async (start, end) => {
    // No `status` filter: GitHub's status index can lag behind a finished
    // run (observed missing a successful run for over 30 minutes), while
    // branch, event and created are fixed when the run is created.
    const params = {
      branch,
      event: 'workflow_dispatch',
      created: `${isoSecond(start)}..${isoSecond(end)}`,
      per_page: '100'
    };
    const first = await client.listWorkflowRuns(DEPLOY_WORKFLOW, {
      ...params,
      page: '1'
    });
    if (first.total_count > MAX_FILTERED_RESULTS && end - start > 60_000) {
      const middle = start + Math.floor((end - start) / 2);
      await scan(middle, end);
      await scan(start, middle);
      return;
    }
    (first.workflow_runs || []).forEach(consider);
    const pages = Math.ceil(
      Math.min(first.total_count, MAX_FILTERED_RESULTS) / 100
    );
    for (let page = 2; page <= pages; page++) {
      const next = await client.listWorkflowRuns(DEPLOY_WORKFLOW, {
        ...params,
        page: String(page)
      });
      (next.workflow_runs || []).forEach(consider);
    }
  };

  let end = now;
  while (end > historyStart && found.size < wanted.size) {
    const start = Math.max(historyStart, end - WINDOW_DAYS * DAY_MS);
    await scan(start, end);
    end = start;
  }
  return found;
}

const ACTIVE_STATUSES = [
  'queued',
  'in_progress',
  'pending',
  'waiting',
  'requested'
];

/** Deploy runs for `environment` that have not completed yet. */
async function activeDeployRuns(client, environment) {
  const result = await client.listWorkflowRuns(DEPLOY_WORKFLOW, {
    per_page: '30'
  });
  return (result.workflow_runs || []).filter((run) => {
    const match = DEPLOY_TITLE.exec(run.display_title || '');
    return (
      ACTIVE_STATUSES.includes(run.status) &&
      (!match || match[2] === environment)
    );
  });
}

/**
 * The most recent train halt that no later `resume` run has cleared. A halt
 * is a completed train run whose `ship` job failed or timed out.
 */
async function findUnclearedHalt(client, { currentRunId, shipJobName }) {
  const result = await client.listWorkflowRuns(TRAIN_WORKFLOW, {
    per_page: '50'
  });
  const runs = (result.workflow_runs || [])
    .filter((run) => run.id !== currentRunId && run.status === 'completed')
    .sort((left, right) => right.created_at.localeCompare(left.created_at));
  for (const run of runs) {
    if (['failure', 'timed_out'].includes(run.conclusion)) {
      const jobs = await client.listRunJobs(run.id);
      const ship = jobs.find((job) => job.name === shipJobName);
      if (ship && ['failure', 'timed_out'].includes(ship.conclusion)) {
        return {
          run_id: run.id,
          run_url: run.html_url,
          created_at: run.created_at
        };
      }
    }
    if (/\(resume\)/.test(run.display_title || '')) return null;
  }
  return null;
}

module.exports = {
  DEPLOY_WORKFLOW,
  TRAIN_WORKFLOW,
  DEPLOY_TITLE,
  deployBranch,
  createGitHubClient,
  findDeployedCommits,
  activeDeployRuns,
  findUnclearedHalt
};
