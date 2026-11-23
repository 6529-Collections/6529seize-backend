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
  // The deploy workflow's concurrency group keeps at most one run pending
  // per environment, so an active run is always among the newest 100.
  const result = await client.listWorkflowRuns(DEPLOY_WORKFLOW, {
    per_page: '100'
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
  return {
    run_id: run.id,
    run_url: run.html_url,
    created_at: run.created_at,
    // When the halt was opened: the Ship job's failure.
    failed_at: ship.completed_at || run.updated_at || run.created_at
  };
}

/**
 * Whether `run` is a resume whose Resume job actually completed: a resume
 * dispatch cancelled or failed before clearing anything does not count.
 */
async function isCompletedResume(client, run, resumeJobName) {
  if (!(run.display_title || '').endsWith('(resume)')) return false;
  const jobs = await client.listRunJobs(run.id);
  const resume = jobs.find((job) => job.name === resumeJobName);
  return Boolean(resume) && resume.conclusion === 'success';
}

/**
 * What one past train run, read newest first, says about a halt.
 * `resumedAt` is the dispatch time of the newest completed resume seen so
 * far, or null. Returns `{ done: true, halt }` once the answer is known,
 * else `{ done: false, resumedAt }` to read the next older run.
 */
async function historyVerdict(client, run, resumedAt, jobNames) {
  // This run, and every older one, ended before the resume was dispatched.
  if (resumedAt !== null && Date.parse(run.updated_at) < resumedAt) {
    return { done: true, halt: null };
  }
  const halt = await haltFromRun(client, run, jobNames.shipJobName);
  if (halt) {
    const kept = resumedAt === null || Date.parse(halt.failed_at) >= resumedAt;
    return { done: true, halt: kept ? halt : null };
  }
  const resumed =
    resumedAt === null &&
    (await isCompletedResume(client, run, jobNames.resumeJobName));
  return {
    done: false,
    resumedAt: resumed ? Date.parse(run.created_at) : resumedAt
  };
}

/**
 * Fallback halt detection from run history, for a halt whose issue could
 * not be opened: the most recent completed train run whose Ship job
 * failed or timed out, unless the Resume job of a run dispatched after
 * that failure completed successfully: like the Resume job itself, a resume
 * clears only halts opened before its dispatch, so a train that was still
 * running when the resume was dispatched and failed later stays halted.
 * It pages through the newest HISTORY_FALLBACK_PAGES pages of 100 runs
 * (several days of trains); the halt issue makes a halt persist beyond that.
 */
async function findUnclearedHalt(
  client,
  { currentRunId, shipJobName, resumeJobName = 'Resume', resumedAt = null }
) {
  // In a resume run, its own completed Resume job (resumedAt, its dispatch
  // time) covers the halts opened before it, like a later resume would.
  let clearedBefore = resumedAt;
  for (let page = 1; page <= HISTORY_FALLBACK_PAGES; page++) {
    const result = await client.listWorkflowRuns(TRAIN_WORKFLOW, {
      per_page: '100',
      page: String(page)
    });
    const runs = (result.workflow_runs || [])
      .filter((run) => run.id !== currentRunId && run.status === 'completed')
      .sort((left, right) => right.created_at.localeCompare(left.created_at));
    for (const run of runs) {
      const verdict = await historyVerdict(client, run, clearedBefore, {
        shipJobName,
        resumeJobName
      });
      if (verdict.done) return verdict.halt;
      clearedBefore = verdict.resumedAt;
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
      state: issue.state,
      created_at: issue.created_at
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

/**
 * When a resume was requested: the creation time of its workflow run, which
 * stays the original dispatch time on every re-run attempt.
 */
async function resumeRequestedAt(client, runId) {
  const run = await client.getRun(runId);
  const requestedAt = Date.parse(run?.created_at);
  if (Number.isNaN(requestedAt)) {
    throw new Error(`Cannot tell when resume run ${runId} was dispatched`);
  }
  return requestedAt;
}

/**
 * Clears the halts opened before `requestedBefore` (the resume dispatch):
 * comments on each, labels it resumed and closes it. A halt opened after
 * the dispatch stays, so retrying an old resume run cannot clear it; that
 * needs a fresh resume dispatch. Returns the cleared and kept halts.
 */
async function resumeHalts(client, { by, runUrl, requestedBefore }) {
  if (!Number.isFinite(requestedBefore)) {
    throw new Error('resumeHalts needs the resume dispatch time');
  }
  const uncleared = await findHaltIssues(client);
  const halts = uncleared.filter(
    (halt) => Date.parse(halt.created_at) < requestedBefore
  );
  const kept = uncleared.filter((halt) => !halts.includes(halt));
  if (halts.length === 0) return { cleared: [], kept };
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
  return { cleared: halts, kept };
}

const LEDGER_LABEL = 'deploy-train-ledger';
const LEDGER_TITLE = 'Deploy train release-note groups';
const LEDGER_JSON = /```json\n([\s\S]*?)\n```/;

function validateLedgerGroups(groups, label) {
  if (!groups || typeof groups !== 'object' || Array.isArray(groups)) {
    throw new TypeError(`${label} must hold a "groups" object`);
  }
  for (const [pull, entry] of Object.entries(groups)) {
    const valid =
      /^[1-9]\d*$/.test(pull) &&
      entry &&
      Array.isArray(entry.services) &&
      entry.services.length > 0 &&
      Array.isArray(entry.shipped) &&
      !Number.isNaN(Date.parse(entry.opened_at));
    if (!valid) throw new Error(`${label} has an invalid group for PR ${pull}`);
  }
  return groups;
}

/**
 * The release-note ledger: per pull request, the service set its group was
 * first sent with and the members that shipped. It lives in one open issue
 * labelled deploy-train-ledger, which only the train edits.
 */
async function readLedger(client) {
  const issues = await client.request(
    'GET',
    `/issues?labels=${LEDGER_LABEL}&state=open&sort=created&direction=asc&per_page=10`
  );
  const issue = (issues || []).find((candidate) => !candidate.pull_request);
  if (!issue) return { number: null, groups: {} };
  const match = LEDGER_JSON.exec(issue.body || '');
  if (!match)
    throw new Error(`Ledger issue #${issue.number} has no JSON block`);
  const label = `Ledger issue #${issue.number}`;
  return {
    number: issue.number,
    groups: validateLedgerGroups(JSON.parse(match[1]).groups, label)
  };
}

/** Writes the ledger back, opening its issue on first use. */
async function writeLedger(client, ledger) {
  const body = [
    'The deploy train keeps here the service set of each pull request whose release-note group it has started to send, so the group stays the same across trains. Only the train edits this issue; do not edit or close it.',
    '',
    '```json',
    JSON.stringify({ groups: ledger.groups }, null, 1),
    '```'
  ].join('\n');
  if (ledger.number) {
    await client.request('PATCH', `/issues/${ledger.number}`, { body });
    return ledger;
  }
  await ensureLabel(
    client,
    LEDGER_LABEL,
    'c5def5',
    'Release-note groups the deploy train keeps across trains'
  );
  const issue = await client.request('POST', '/issues', {
    title: LEDGER_TITLE,
    body,
    labels: [LEDGER_LABEL]
  });
  return { ...ledger, number: issue.number };
}

/** The halt blocking the train: an uncleared halt issue, else run history. */
async function currentHalt(
  client,
  { currentRunId, shipJobName, historyFallback = true, resumedAt = null }
) {
  const [issue] = await findHaltIssues(client);
  if (issue) return { url: issue.url, label: `issue #${issue.number}` };
  if (!historyFallback) return null;
  const run = await findUnclearedHalt(client, {
    currentRunId,
    shipJobName,
    resumedAt
  });
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
  readLedger,
  writeLedger,
  LEDGER_LABEL,
  resumeRequestedAt,
  resumeHalts,
  currentHalt
};
