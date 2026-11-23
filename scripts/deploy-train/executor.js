'use strict';

const catalogLib = require('./catalog');
const { evaluateBlackout } = require('./blackouts');
const { DEPLOY_WORKFLOW, activeDeployRuns, deployBranch } = require('./github');
const { releaseNoteGroups } = require('./plan');

const DEFAULT_OPTIONS = {
  pollSeconds: 30,
  findRunSeconds: 300,
  deployTimeoutMinutes: 90,
  healthTimeoutSeconds: 300,
  watchMinutes: 30,
  finalWatchSeconds: 300,
  busyWaitMinutes: 30,
  budgetMinutes: 300
};
// Stops that leave nothing broken: the next train picks up what still differs.
const SOFT_STOPS = ['main-moved', 'busy', 'time-budget', 'deploy-cancelled'];

function deployInputs(plan, item, groups) {
  return {
    environment: plan.environment,
    service: item.service,
    expected_source_sha: plan.target_sha,
    release_note_groups: JSON.stringify(groups)
  };
}

/**
 * Ships a train plan one service at a time through the existing deploy
 * workflow, pinned to the plan's commit. Before each deploy it confirms the
 * branch has not moved, the service is outside its quiet windows and no
 * other deploy is running. After each deploy it checks the service's
 * health and keeps watching services that have not run yet. It stops at
 * the first failed deploy or unhealthy service (a halt), and stops softly
 * when the branch moves or time runs out.
 */
async function runTrain({
  plan,
  catalog,
  client,
  health,
  teamWindows = [],
  clock = () => Date.now(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  log = () => undefined,
  options: overrides = {}
}) {
  const options = { ...DEFAULT_OPTIONS, ...overrides };
  const branch = deployBranch(plan.environment);
  const startedAt = clock();
  const result = {
    shipped: [],
    deferred: [],
    not_started: [],
    watch: [],
    stop: null
  };
  const heldBack = new Set();
  const queue = plan.ship.slice();
  const shippedItems = [];

  const stop = (reason, detail, item) => {
    result.stop = {
      reason,
      halt: !SOFT_STOPS.includes(reason),
      service: item ? item.service : null,
      detail
    };
  };

  const groupsFor = (item) => {
    const groups = releaseNoteGroups(shippedItems.concat([item], queue));
    return groups.get(item.service);
  };

  async function waitUntilIdle() {
    const deadline = clock() + options.busyWaitMinutes * 60_000;
    for (;;) {
      const active = await activeDeployRuns(client, plan.environment);
      if (active.length === 0) return null;
      if (clock() >= deadline) return active;
      log(
        `waiting for ${active.length} running deploy(s): ${active.map((run) => run.html_url).join(' ')}`
      );
      await sleep(60_000);
    }
  }

  async function findDispatchedRun(item, priorIds, dispatchedAt) {
    const title = `Deploy ${item.service} to ${plan.environment}`;
    const deadline = clock() + options.findRunSeconds * 1000;
    for (;;) {
      const runs = await client.listWorkflowRuns(DEPLOY_WORKFLOW, {
        event: 'workflow_dispatch',
        branch,
        per_page: '30'
      });
      const match = (runs.workflow_runs || []).find(
        (run) =>
          !priorIds.has(run.id) &&
          run.display_title === title &&
          run.head_sha === plan.target_sha &&
          Date.parse(run.created_at) >= dispatchedAt - 60_000
      );
      if (match) return match.id;
      if (clock() >= deadline) return null;
      await sleep(15_000);
    }
  }

  async function waitForRun(runId) {
    const deadline = clock() + options.deployTimeoutMinutes * 60_000;
    for (;;) {
      const run = await client.getRun(runId);
      if (run.status === 'completed') return run;
      if (clock() >= deadline) return { ...run, conclusion: 'timed_out' };
      await sleep(options.pollSeconds * 1000);
    }
  }

  async function failedSteps(runId) {
    const jobs = await client.listRunJobs(runId);
    return jobs.flatMap((job) =>
      (job.steps || [])
        .filter((step) => step.conclusion === 'failure')
        .map((step) => step.name)
    );
  }

  /** A health check that cannot run is itself a failure: fail closed. */
  async function checkHealth(item, deployStartedAt) {
    try {
      return await health.check(item, deployStartedAt);
    } catch (error) {
      return {
        status: 'unhealthy',
        findings: [
          `health check could not run: ${error instanceof Error ? error.message : String(error)}`
        ],
        note: null
      };
    }
  }

  async function waitForHealth(item, deployStartedAt, timeoutSeconds) {
    const deadline = clock() + timeoutSeconds * 1000;
    for (;;) {
      const verdict = await checkHealth(item, deployStartedAt);
      if (verdict.status !== 'pending' || clock() >= deadline) return verdict;
      await sleep(options.pollSeconds * 1000);
    }
  }

  /** Re-checks services that had not run yet; returns an unhealthy one. */
  async function sweepWatch() {
    for (const entry of result.watch) {
      if (entry.status !== 'pending') continue;
      const verdict = await checkHealth(entry.item, entry.deployStartedAt);
      entry.status = verdict.status;
      entry.note = verdict.note;
      entry.findings = verdict.findings;
      if (verdict.status === 'unhealthy') return entry;
      if (verdict.status === 'pending' && clock() >= entry.until) {
        entry.status = 'unverified';
      }
    }
    return null;
  }

  while (queue.length > 0) {
    const item = queue.shift();
    const blockedBy = item.dependencies.find((name) => heldBack.has(name));
    if (blockedBy) {
      result.deferred.push({
        service: item.service,
        reason: `waits for dependency ${blockedBy}`
      });
      heldBack.add(item.service);
      continue;
    }
    if (clock() - startedAt > options.budgetMinutes * 60_000) {
      stop(
        'time-budget',
        `train ran longer than ${options.budgetMinutes} minutes`
      );
      result.not_started.push(
        item.service,
        ...queue.map((next) => next.service)
      );
      break;
    }
    const head = await client.getBranchSha(branch);
    if (head !== plan.target_sha) {
      stop(
        'main-moved',
        `${branch} moved to ${head.slice(0, 10)}; the next train ships what still differs`
      );
      result.not_started.push(
        item.service,
        ...queue.map((next) => next.service)
      );
      break;
    }
    const blackout = evaluateBlackout(
      catalogLib.getService(catalog, item.service),
      {
        now: clock(),
        teamWindows,
        lookaheadMinutes: plan.lookahead_minutes
      }
    );
    if (blackout.blocked) {
      result.deferred.push({
        service: item.service,
        reason: `quiet window from ${blackout.from}: ${blackout.reasons.join('; ')}`
      });
      heldBack.add(item.service);
      continue;
    }
    const busy = await waitUntilIdle();
    if (busy) {
      stop(
        'busy',
        `another deploy is still running: ${busy.map((run) => run.html_url).join(' ')}`
      );
      result.not_started.push(
        item.service,
        ...queue.map((next) => next.service)
      );
      break;
    }
    const groups = groupsFor(item);
    const prior = await client.listWorkflowRuns(DEPLOY_WORKFLOW, {
      event: 'workflow_dispatch',
      branch,
      per_page: '30'
    });
    const priorIds = new Set((prior.workflow_runs || []).map((run) => run.id));
    const dispatchedAt = clock();
    log(`deploying ${item.service} at ${plan.target_sha.slice(0, 10)}`);
    const reportedId = await client.dispatchWorkflow(
      DEPLOY_WORKFLOW,
      branch,
      deployInputs(plan, item, groups)
    );
    const runId =
      reportedId || (await findDispatchedRun(item, priorIds, dispatchedAt));
    if (!runId) {
      stop(
        'deploy-unknown',
        'the deploy was dispatched but its run could not be found',
        item
      );
      break;
    }
    const run = await waitForRun(runId);
    const runSummary = {
      service: item.service,
      run_id: run.id || runId,
      run_url: run.html_url || null,
      conclusion: run.conclusion
    };
    if (run.conclusion !== 'success') {
      const headAfter = await client.getBranchSha(branch);
      if (headAfter !== plan.target_sha) {
        stop(
          'main-moved',
          `${branch} moved during the deploy of ${item.service}; the deploy workflow refused the stale commit`,
          item
        );
      } else if (run.conclusion === 'cancelled') {
        stop(
          'deploy-cancelled',
          `the ${item.service} deploy was cancelled`,
          item
        );
      } else {
        const steps = await failedSteps(runSummary.run_id);
        stop(
          'deploy-failed',
          `${item.service} deploy ${run.conclusion}${steps.length ? ` at ${steps.join(', ')}` : ''}`,
          item
        );
      }
      result.failed_run = runSummary;
      break;
    }
    const deployStartedAt = Date.parse(run.run_started_at || run.created_at);
    shippedItems.push(item);
    const verdict = await waitForHealth(
      item,
      deployStartedAt,
      options.healthTimeoutSeconds
    );
    result.shipped.push({
      ...runSummary,
      health: verdict.status,
      note: verdict.note
    });
    if (verdict.status === 'unhealthy') {
      stop(
        'unhealthy',
        `${item.service}: ${verdict.findings.join('; ')}`,
        item
      );
      break;
    }
    if (verdict.status === 'pending') {
      result.watch.push({
        item,
        deployStartedAt,
        until: clock() + options.watchMinutes * 60_000,
        status: 'pending',
        note: verdict.note,
        findings: []
      });
    }
    const unhealthy = await sweepWatch();
    if (unhealthy) {
      stop(
        'unhealthy',
        `${unhealthy.item.service}: ${unhealthy.findings.join('; ')}`,
        unhealthy.item
      );
      break;
    }
  }

  if (!result.stop || !result.stop.halt) {
    const finalDeadline = clock() + options.finalWatchSeconds * 1000;
    while (result.watch.some((entry) => entry.status === 'pending')) {
      const unhealthy = await sweepWatch();
      if (unhealthy) {
        stop(
          'unhealthy',
          `${unhealthy.item.service}: ${unhealthy.findings.join('; ')}`,
          unhealthy.item
        );
        break;
      }
      if (clock() >= finalDeadline) break;
      await sleep(options.pollSeconds * 1000);
    }
  }
  for (const entry of result.watch) {
    if (entry.status === 'pending') entry.status = 'unverified';
    const shipped = result.shipped.find(
      (item) => item.service === entry.item.service
    );
    if (shipped) {
      shipped.health = entry.status;
      shipped.note = entry.note;
    }
  }
  result.watch = result.watch.map((entry) => ({
    service: entry.item.service,
    status: entry.status,
    note: entry.note
  }));
  return result;
}

module.exports = { DEFAULT_OPTIONS, SOFT_STOPS, deployInputs, runTrain };
