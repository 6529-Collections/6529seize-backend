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
        return result?.workflow_run_id || null;
      } catch (error) {
        // Retry only when GitHub rejected the run-details flag itself; a
        // 422 creates no run, so the plain dispatch cannot duplicate one.
        if (error.status !== 422 || !/return_run_details/.test(error.message)) {
          throw error;
        }
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
      actor: run.triggering_actor?.login || null
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

const ACTIVE_STATUSES = new Set([
  'queued',
  'in_progress',
  'pending',
  'waiting',
  'requested'
]);

/** Deploy runs for `environment` that have not completed yet. */
async function activeDeployRuns(client, environment) {
  const result = await client.listWorkflowRuns(DEPLOY_WORKFLOW, {
    per_page: '30'
  });
  return (result.workflow_runs || []).filter((run) => {
    const match = DEPLOY_TITLE.exec(run.display_title || '');
    return (
      ACTIVE_STATUSES.has(run.status) && (!match || match[2] === environment)
    );
  });
}

const HISTORY_FALLBACK_PAGES = 5;

function isFailed(conclusion) {
  return conclusion === 'failure' || conclusion === 'timed_out';
}

/** A halt recorded by `run`, or null when its Ship job did not fail. */
async function haltFromRun(client, run, shipJobName) {
  if (!isFailed(run.conclusion)) return null;
  const jobs = await client.listRunJobs(run.id);
  const ship = jobs.find((job) => job.name === shipJobName);
  if (!ship || !isFailed(ship.conclusion)) return null;
  return { run_id: run.id, run_url: run.html_url, created_at: run.created_at };
}

/**
 * Fallback halt detection from run history, for a halt whose issue could
 * not be opened: the most recent completed train run whose Ship job
 * failed or timed out, unless a later resume run cleared it. It pages
 * through the newest HISTORY_FALLBACK_PAGES pages of 100 runs (several
 * days of trains); the halt issue is what makes a halt persist beyond that.
 */
async function findUnclearedHalt(client, { currentRunId, shipJobName }) {
  for (let page = 1; page <= HISTORY_FALLBACK_PAGES; page++) {
    const result = await client.listWorkflowRuns(TRAIN_WORKFLOW, {
      per_page: '100',
      page: String(page)
    });
    const runs = (result.workflow_runs || [])
      .filter((run) => run.id !== currentRunId && run.status === 'completed')
      .sort((left, right) => right.created_at.localeCompare(left.created_at));
    for (const run of runs) {
      const halt = await haltFromRun(client, run, shipJobName);
      if (halt) return halt;
      if ((run.display_title || '').endsWith('(resume)')) return null;
    }
    if ((result.workflow_runs || []).length < 100) return null;
  }
  return null;
}

const HALT_LABEL = 'deploy-train-halt';
const RESUMED_LABEL = 'deploy-train-resumed';

async function ensureLabel(client, name, color, description) {
  try {
    await client.request('POST', '/labels', { name, color, description });
  } catch (error) {
    if (error.status !== 422) throw error; // 422: the label already exists
  }
}

function hasLabel(issue, name) {
  return (issue.labels || []).some((label) => (label.name || label) === name);
}

/**
 * Halt issues that no resume has cleared, newest first. A halt stays until
 * a `resume=true` run labels its issue; closing the issue by hand does not
 * clear it.
 */
async function findHaltIssues(client) {
  const issues = await client.request(
    'GET',
    `/issues?labels=${HALT_LABEL}&state=all&sort=created&direction=desc&per_page=100`
  );
  return (issues || [])
    .filter((issue) => !issue.pull_request && !hasLabel(issue, RESUMED_LABEL))
    .map((issue) => ({
      number: issue.number,
      url: issue.html_url,
      title: issue.title,
      state: issue.state
    }));
}

/** Opens the issue that keeps the train halted until a resume. */
async function recordHalt(client, { title, body }) {
  await ensureLabel(
    client,
    HALT_LABEL,
    'b60205',
    'The deploy train is halted until a resume dispatch'
  );
  const issue = await client.request('POST', '/issues', {
    title,
    body,
    labels: [HALT_LABEL]
  });
  return { number: issue.number, url: issue.html_url };
}

/** Clears every uncleared halt: comments, labels it resumed and closes it. */
async function resumeHalts(client, { by, runUrl }) {
  const halts = await findHaltIssues(client);
  if (halts.length === 0) return [];
  await ensureLabel(
    client,
    RESUMED_LABEL,
    '0e8a16',
    'Cleared by a Deploy train resume dispatch'
  );
  for (const halt of halts) {
    await client.request('POST', `/issues/${halt.number}/comments`, {
      body: `Resumed by ${by} in ${runUrl}.`
    });
    await client.request('POST', `/issues/${halt.number}/labels`, {
      labels: [RESUMED_LABEL]
    });
    if (halt.state !== 'closed') {
      await client.request('PATCH', `/issues/${halt.number}`, {
        state: 'closed',
        state_reason: 'completed'
      });
    }
  }
  return halts;
}

/** The halt blocking the train: an uncleared halt issue, else run history. */
async function currentHalt(client, { currentRunId, shipJobName }) {
  const [issue] = await findHaltIssues(client);
  if (issue) return { url: issue.url, label: `issue #${issue.number}` };
  const run = await findUnclearedHalt(client, { currentRunId, shipJobName });
  return run ? { url: run.run_url, label: `run ${run.run_id}` } : null;
}

module.exports = {
  HALT_LABEL,
  RESUMED_LABEL,
  DEPLOY_WORKFLOW,
  TRAIN_WORKFLOW,
  DEPLOY_TITLE,
  deployBranch,
  createGitHubClient,
  findDeployedCommits,
  activeDeployRuns,
  findUnclearedHalt,
  findHaltIssues,
  recordHalt,
  resumeHalts,
  currentHalt
};
