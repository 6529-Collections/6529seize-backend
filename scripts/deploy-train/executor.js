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
const SOFT_STOPS = new Set([
  'main-moved',
  'busy',
  'time-budget',
  'deploy-cancelled'
]);

function deployInputs(plan, item, groups) {
  return {
    environment: plan.environment,
    service: item.service,
    expected_source_sha: plan.target_sha,
    release_note_groups: JSON.stringify(groups)
  };
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

/** One train run; see runTrain. */
class TrainRun {
  constructor({
    plan,
    catalog,
    client,
    health,
    teamWindows,
    clock,
    sleep,
    log,
    options
  }) {
    this.plan = plan;
    this.catalog = catalog;
    this.client = client;
    this.health = health;
    this.teamWindows = teamWindows;
    this.clock = clock;
    this.sleep = sleep;
    this.log = log;
    this.options = options;
    this.branch = deployBranch(plan.environment);
    this.startedAt = clock();
    this.result = {
      shipped: [],
      deferred: [],
      not_started: [],
      watch: [],
      stop: null
    };
    this.heldBack = new Set();
    this.queue = plan.ship.slice();
    this.shippedItems = [];
  }

  stop(reason, detail, item) {
    const halt = !SOFT_STOPS.has(reason);
    this.result.stop = {
      reason,
      halt,
      service: item ? item.service : null,
      detail
    };
    // A halt leaves the rest of the queue undeployed; list it so the alert
    // shows what is still waiting.
    if (halt) {
      this.result.not_started.push(...this.queue.map((next) => next.service));
    }
  }

  /** Stops before `item` deploys, listing it and the rest as not started. */
  stopBefore(item, reason, detail) {
    this.stop(reason, detail);
    this.result.not_started.push(
      item.service,
      ...this.queue.map((next) => next.service)
    );
  }

  defer(item, reason) {
    this.result.deferred.push({ service: item.service, reason });
    this.heldBack.add(item.service);
  }

  groupsFor(item) {
    const records = this.shippedItems.concat([item], this.queue);
    return releaseNoteGroups(records).get(item.service);
  }

  async waitUntilIdle() {
    const deadline = this.clock() + this.options.busyWaitMinutes * 60_000;
    for (;;) {
      const active = await activeDeployRuns(this.client, this.plan.environment);
      if (active.length === 0) return null;
      if (this.clock() >= deadline) return active;
      const urls = active.map((run) => run.html_url).join(' ');
      this.log(`waiting for ${active.length} running deploy(s): ${urls}`);
      await this.sleep(60_000);
    }
  }

  async listDispatchedRuns() {
    const runs = await this.client.listWorkflowRuns(DEPLOY_WORKFLOW, {
      event: 'workflow_dispatch',
      branch: this.branch,
      per_page: '30'
    });
    return runs.workflow_runs || [];
  }

  async findDispatchedRun(item, priorIds, dispatchedAt) {
    const title = `Deploy ${item.service} to ${this.plan.environment}`;
    const deadline = this.clock() + this.options.findRunSeconds * 1000;
    for (;;) {
      const match = (await this.listDispatchedRuns()).find(
        (run) =>
          !priorIds.has(run.id) &&
          run.display_title === title &&
          run.head_sha === this.plan.target_sha &&
          Date.parse(run.created_at) >= dispatchedAt - 60_000
      );
      if (match) return match.id;
      if (this.clock() >= deadline) return null;
      await this.sleep(15_000);
    }
  }

  async waitForRun(runId) {
    const deadline = this.clock() + this.options.deployTimeoutMinutes * 60_000;
    for (;;) {
      const run = await this.client.getRun(runId);
      if (run.status === 'completed') return run;
      if (this.clock() >= deadline) return { ...run, conclusion: 'timed_out' };
      await this.sleep(this.options.pollSeconds * 1000);
    }
  }

  async failedSteps(runId) {
    const jobs = await this.client.listRunJobs(runId);
    return jobs.flatMap((job) =>
      (job.steps || [])
        .filter((step) => step.conclusion === 'failure')
        .map((step) => step.name)
    );
  }

  /** A health check that cannot run is itself a failure: fail closed. */
  async checkHealth(item, deployStartedAt) {
    try {
      return await this.health.check(item, deployStartedAt);
    } catch (error) {
      return {
        status: 'unhealthy',
        findings: [`health check could not run: ${errorMessage(error)}`],
        note: null
      };
    }
  }

  async waitForHealth(item, deployStartedAt) {
    const deadline = this.clock() + this.options.healthTimeoutSeconds * 1000;
    for (;;) {
      const verdict = await this.checkHealth(item, deployStartedAt);
      if (verdict.status !== 'pending' || this.clock() >= deadline) {
        return verdict;
      }
      await this.sleep(this.options.pollSeconds * 1000);
    }
  }

  /** Re-checks services that had not run yet; halts on an unhealthy one. */
  async sweepWatch() {
    for (const entry of this.result.watch) {
      if (entry.status !== 'pending') continue;
      const verdict = await this.checkHealth(entry.item, entry.deployStartedAt);
      Object.assign(entry, {
        status: verdict.status,
        note: verdict.note,
        findings: verdict.findings
      });
      if (verdict.status === 'unhealthy') {
        this.stop(
          'unhealthy',
          `${entry.item.service}: ${verdict.findings.join('; ')}`,
          entry.item
        );
        return;
      }
      if (verdict.status === 'pending' && this.clock() >= entry.until) {
        entry.status = 'unverified';
      }
    }
  }

  /** Whether `item` may deploy now: 'go', 'skip' (deferred) or 'stop'. */
  async gate(item) {
    const blockedBy = item.dependencies.find((name) => this.heldBack.has(name));
    if (blockedBy) {
      this.defer(item, `waits for dependency ${blockedBy}`);
      return 'skip';
    }
    if (this.clock() - this.startedAt > this.options.budgetMinutes * 60_000) {
      this.stopBefore(
        item,
        'time-budget',
        `train ran longer than ${this.options.budgetMinutes} minutes`
      );
      return 'stop';
    }
    const head = await this.client.getBranchSha(this.branch);
    if (head !== this.plan.target_sha) {
      this.stopBefore(
        item,
        'main-moved',
        `${this.branch} moved to ${head.slice(0, 10)}; the next train ships what still differs`
      );
      return 'stop';
    }
    const blackout = evaluateBlackout(
      catalogLib.getService(this.catalog, item.service),
      {
        now: this.clock(),
        teamWindows: this.teamWindows,
        lookaheadMinutes: this.plan.lookahead_minutes
      }
    );
    if (blackout.blocked) {
      this.defer(
        item,
        `quiet window from ${blackout.from}: ${blackout.reasons.join('; ')}`
      );
      return 'skip';
    }
    const busy = await this.waitUntilIdle();
    if (busy) {
      const urls = busy.map((run) => run.html_url).join(' ');
      this.stopBefore(item, 'busy', `another deploy is still running: ${urls}`);
      return 'stop';
    }
    return 'go';
  }

  async dispatch(item) {
    const groups = this.groupsFor(item);
    const priorIds = new Set(
      (await this.listDispatchedRuns()).map((run) => run.id)
    );
    const dispatchedAt = this.clock();
    this.log(
      `deploying ${item.service} at ${this.plan.target_sha.slice(0, 10)}`
    );
    const reportedId = await this.client.dispatchWorkflow(
      DEPLOY_WORKFLOW,
      this.branch,
      deployInputs(this.plan, item, groups)
    );
    return reportedId || this.findDispatchedRun(item, priorIds, dispatchedAt);
  }

  async recordFailedRun(item, run, runSummary) {
    this.result.failed_run = runSummary;
    const headAfter = await this.client.getBranchSha(this.branch);
    if (headAfter !== this.plan.target_sha) {
      this.stop(
        'main-moved',
        `${this.branch} moved during the deploy of ${item.service}; the deploy workflow refused the stale commit`,
        item
      );
      return;
    }
    if (run.conclusion === 'cancelled') {
      this.stop(
        'deploy-cancelled',
        `the ${item.service} deploy was cancelled`,
        item
      );
      return;
    }
    const steps = await this.failedSteps(runSummary.run_id);
    const where = steps.length > 0 ? ` at ${steps.join(', ')}` : '';
    this.stop(
      'deploy-failed',
      `${item.service} deploy ${run.conclusion}${where}`,
      item
    );
  }

  async deployAndCheck(item) {
    const runId = await this.dispatch(item);
    if (!runId) {
      this.stop(
        'deploy-unknown',
        'the deploy was dispatched but its run could not be found',
        item
      );
      return;
    }
    const run = await this.waitForRun(runId);
    const runSummary = {
      service: item.service,
      run_id: run.id || runId,
      run_url: run.html_url || null,
      conclusion: run.conclusion
    };
    if (run.conclusion !== 'success') {
      await this.recordFailedRun(item, run, runSummary);
      return;
    }
    const deployStartedAt = Date.parse(run.run_started_at || run.created_at);
    this.shippedItems.push(item);
    const verdict = await this.waitForHealth(item, deployStartedAt);
    this.result.shipped.push({
      ...runSummary,
      health: verdict.status,
      note: verdict.note
    });
    if (verdict.status === 'unhealthy') {
      this.stop(
        'unhealthy',
        `${item.service}: ${verdict.findings.join('; ')}`,
        item
      );
      return;
    }
    if (verdict.status === 'pending') {
      this.result.watch.push({
        item,
        deployStartedAt,
        until: this.clock() + this.options.watchMinutes * 60_000,
        status: 'pending',
        note: verdict.note,
        findings: []
      });
    }
    await this.sweepWatch();
  }

  /** After the last deploy, watch pending services a little longer. */
  async finalWatch() {
    if (this.result.stop?.halt) return;
    const deadline = this.clock() + this.options.finalWatchSeconds * 1000;
    const pending = () =>
      this.result.watch.some((entry) => entry.status === 'pending');
    while (pending() && !this.result.stop?.halt) {
      await this.sweepWatch();
      if (this.clock() >= deadline) return;
      if (pending()) await this.sleep(this.options.pollSeconds * 1000);
    }
  }

  finish() {
    for (const entry of this.result.watch) {
      if (entry.status === 'pending') entry.status = 'unverified';
      const shipped = this.result.shipped.find(
        (item) => item.service === entry.item.service
      );
      if (shipped) {
        shipped.health = entry.status;
        shipped.note = entry.note;
      }
    }
    this.result.watch = this.result.watch.map((entry) => ({
      service: entry.item.service,
      status: entry.status,
      note: entry.note
    }));
    return this.result;
  }

  async run() {
    while (this.queue.length > 0 && !this.result.stop) {
      const item = this.queue.shift();
      if ((await this.gate(item)) === 'go') await this.deployAndCheck(item);
    }
    await this.finalWatch();
    return this.finish();
  }
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
function runTrain({
  plan,
  catalog,
  client,
  health,
  teamWindows = [],
  clock = () => Date.now(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  log = () => undefined,
  options = {}
}) {
  return new TrainRun({
    plan,
    catalog,
    client,
    health,
    teamWindows,
    clock,
    sleep,
    log,
    options: { ...DEFAULT_OPTIONS, ...options }
  }).run();
}

module.exports = { DEFAULT_OPTIONS, SOFT_STOPS, deployInputs, runTrain };
