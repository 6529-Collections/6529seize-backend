'use strict';

const catalogLib = require('./catalog');
const { evaluateBlackout, holdFor } = require('./blackouts');
const { DEPLOY_WORKFLOW, activeDeployRuns, deployBranch } = require('./github');
const { releaseNoteGroups } = require('./plan');

// The ship job has 330 minutes: a new deploy starts only within the
// budget, and a started deploy, its first health check and the trailing
// watch window must still fit after it.
const DEFAULT_OPTIONS = {
  pollSeconds: 30,
  findRunSeconds: 300,
  deployTimeoutMinutes: 60,
  healthTimeoutSeconds: 300,
  watchMinutes: 30,
  watchPollSeconds: 60,
  busyWaitMinutes: 30,
  budgetMinutes: 200
};
// Stops that leave nothing broken: the next train picks up what still differs.
const SOFT_STOPS = new Set([
  'main-moved',
  'busy',
  'time-budget',
  'deploy-cancelled'
]);

// The "Deploy a service" step that refuses a commit other than
// expected_source_sha, before any credentials or deploy step.
const SOURCE_GUARD_STEP = 'Validate dispatch inputs before using credentials';

/** "Deploy a service" steps that change production. */
function isProductionStep(name) {
  return (
    name.startsWith('Deploy ') || name === 'Run lambda and validate result'
  );
}

function deployInputs(plan, item, groups) {
  return {
    environment: plan.environment,
    service: item.service,
    expected_source_sha: plan.target_sha,
    release_note_groups: JSON.stringify(groups)
  };
}

/** A deployed service still inside its observation window. */
function isWatched(entry) {
  return entry.status === 'pending' || entry.status === 'watching';
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
    holds,
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
    this.holds = holds;
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

  /**
   * Records one health verdict on a watch entry. A healthy verdict does not
   * end the watch: the service stays watched for its whole window, because
   * the health check counts errors since the new build went live and they
   * can cross the threshold after a first clean invocation.
   */
  applyVerdict(entry, verdict) {
    entry.note = verdict.note;
    entry.findings = verdict.findings;
    if (verdict.status === 'healthy') entry.seenHealthy = true;
    if (verdict.status === 'unhealthy') {
      entry.status = 'unhealthy';
      this.stop(
        'unhealthy',
        `${entry.item.service}: ${verdict.findings.join('; ')}`,
        entry.item
      );
    } else if (this.clock() >= entry.until) {
      // The window is over: healthy if the new build was ever seen working.
      entry.status = entry.seenHealthy ? 'healthy' : 'unverified';
    } else {
      entry.status = entry.seenHealthy ? 'watching' : 'pending';
    }
  }

  /** Waits for the first healthy or unhealthy result, up to the health timeout. */
  async waitForFirstResult(entry) {
    const deadline = this.clock() + this.options.healthTimeoutSeconds * 1000;
    for (;;) {
      const verdict = await this.checkHealth(entry.item, entry.deployStartedAt);
      if (verdict.status === 'skipped') return verdict;
      this.applyVerdict(entry, verdict);
      if (entry.status !== 'pending' || this.clock() >= deadline) {
        return verdict;
      }
      await this.sleep(this.options.pollSeconds * 1000);
    }
  }

  /** Re-checks every service still inside its window; halts on a failure. */
  async sweepWatch() {
    for (const entry of this.result.watch) {
      if (!isWatched(entry)) continue;
      const verdict = await this.checkHealth(entry.item, entry.deployStartedAt);
      this.applyVerdict(entry, verdict);
      if (entry.status === 'unhealthy') return;
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
    // Checked before waiting so a held or quiet service does not wait for
    // other deploys, and again right before dispatch (clearToDispatch).
    if (!(await this.clearToDispatch(item))) return 'skip';
    const busy = await this.waitUntilIdle();
    if (busy) {
      const urls = busy.map((run) => run.html_url).join(' ');
      this.stopBefore(item, 'busy', `another deploy is still running: ${urls}`);
      return 'stop';
    }
    return 'go';
  }

  /** Why `item` must not deploy now (a hold or a quiet window), or null. */
  quietReason(item) {
    const service = catalogLib.getService(this.catalog, item.service);
    const held = holdFor(service, this.holds);
    if (held) return held;
    const blackout = evaluateBlackout(service, {
      now: this.clock(),
      teamWindows: this.teamWindows,
      lookaheadMinutes: this.plan.lookahead_minutes
    });
    return blackout.blocked
      ? `quiet window from ${blackout.from}: ${blackout.reasons.join('; ')}`
      : null;
  }

  /**
   * Confirms the branch still points at the train's commit and the service
   * is outside holds and quiet windows. Records a stop or deferral and
   * returns false otherwise.
   */
  async clearToDispatch(item) {
    const head = await this.client.getBranchSha(this.branch);
    if (head !== this.plan.target_sha) {
      this.stopBefore(
        item,
        'main-moved',
        `${this.branch} moved to ${head.slice(0, 10)}; the next train ships what still differs`
      );
      return false;
    }
    const reason = this.quietReason(item);
    if (reason) {
      this.defer(item, reason);
      return false;
    }
    return true;
  }

  /**
   * Dispatches `item` and returns `{ runId }` (null when the run cannot be
   * found), or null when the last check stopped or deferred it.
   */
  async dispatch(item) {
    const groups = this.groupsFor(item);
    const priorIds = new Set(
      (await this.listDispatchedRuns()).map((run) => run.id)
    );
    // Waiting for other deploys can take minutes: check the branch, holds
    // and quiet windows again immediately before dispatching.
    if (!(await this.clearToDispatch(item))) return null;
    const dispatchedAt = this.clock();
    this.log(
      `deploying ${item.service} at ${this.plan.target_sha.slice(0, 10)}`
    );
    const reportedId = await this.client.dispatchWorkflow(
      DEPLOY_WORKFLOW,
      this.branch,
      deployInputs(this.plan, item, groups)
    );
    const runId =
      reportedId ||
      (await this.findDispatchedRun(item, priorIds, dispatchedAt));
    return { runId };
  }

  /**
   * Classifies a deploy run that did not succeed. Only a run whose source
   * guard refused the commit before any deploy step, while main moved, is
   * a soft stop; so is a cancellation before any step changed production.
   * Anything else may have changed production and halts the train.
   */
  async recordFailedRun(item, run, runSummary) {
    this.result.failed_run = runSummary;
    const jobs = await this.client.listRunJobs(runSummary.run_id);
    const steps = jobs.flatMap((job) => job.steps || []);
    const failed = steps
      .filter((step) => step.conclusion === 'failure')
      .map((step) => step.name);
    const changing = steps
      .filter(
        (step) =>
          isProductionStep(step.name) &&
          step.conclusion &&
          step.conclusion !== 'skipped'
      )
      .map((step) => step.name);
    if (failed.includes(SOURCE_GUARD_STEP) && changing.length === 0) {
      const headAfter = await this.client.getBranchSha(this.branch);
      if (headAfter !== this.plan.target_sha) {
        this.stop(
          'main-moved',
          `${this.branch} moved during the deploy of ${item.service}; the deploy workflow refused the stale commit before deploying`,
          item
        );
        return;
      }
    }
    if (run.conclusion === 'cancelled' && changing.length === 0) {
      this.stop(
        'deploy-cancelled',
        `the ${item.service} deploy was cancelled before it changed production`,
        item
      );
      return;
    }
    if (run.conclusion === 'cancelled') {
      this.stop(
        'deploy-cancelled-after-change',
        `the ${item.service} deploy was cancelled after ${changing.join(', ')} started; production may have changed without verification`,
        item
      );
      return;
    }
    const where = failed.length > 0 ? ` at ${failed.join(', ')}` : '';
    this.stop(
      'deploy-failed',
      `${item.service} deploy ${run.conclusion}${where}`,
      item
    );
  }

  async deployAndCheck(item) {
    const dispatched = await this.dispatch(item);
    if (!dispatched) return;
    const { runId } = dispatched;
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
    this.shippedItems.push(item);
    const entry = {
      item,
      deployStartedAt: Date.parse(run.run_started_at || run.created_at),
      until: this.clock() + this.options.watchMinutes * 60_000,
      status: 'pending',
      seenHealthy: false,
      note: null,
      findings: []
    };
    const verdict = await this.waitForFirstResult(entry);
    this.result.shipped.push({
      ...runSummary,
      health: verdict.status === 'skipped' ? 'skipped' : entry.status,
      note: verdict.note
    });
    if (verdict.status === 'skipped' || entry.status === 'unhealthy') return;
    this.result.watch.push(entry);
    await this.sweepWatch();
  }

  /**
   * After the last deploy, keeps watching until every deployed service's
   * window has closed, so a failure late in a window still halts.
   */
  async finalWatch() {
    while (!this.result.stop?.halt && this.result.watch.some(isWatched)) {
      await this.sleep(this.options.watchPollSeconds * 1000);
      await this.sweepWatch();
    }
  }

  finish() {
    for (const entry of this.result.watch) {
      // Reached only when a soft stop or halt ended the watch early.
      if (isWatched(entry)) {
        entry.status = entry.seenHealthy ? 'healthy' : 'unverified';
      }
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
 * other deploy is running. After each deploy it checks the new build's
 * health and keeps every deployed service under watch for its whole
 * observation window while it ships the others, and after the last deploy
 * until the windows close. It stops at the first failed deploy or unhealthy
 * service (a halt), and stops softly when the branch moves or time runs out.
 */
function runTrain({
  plan,
  catalog,
  client,
  health,
  teamWindows = [],
  holds = [],
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
    holds,
    clock,
    sleep,
    log,
    options: { ...DEFAULT_OPTIONS, ...options }
  }).run();
}

module.exports = { DEFAULT_OPTIONS, SOFT_STOPS, deployInputs, runTrain };
