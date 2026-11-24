'use strict';

const catalogLib = require('./catalog');
const { evaluateBlackout, holdFor } = require('./blackouts');
const { DEPLOY_WORKFLOW, activeDeployRuns, deployBranch } = require('./github');
const { LEDGER_KEEP_DAYS, ledgerStage } = require('./plan');

const DAY_MS = 86_400_000;
// The service whose log shows a release-note event reached the receiver.
const RELEASE_NOTES_SERVICE = 'releaseNotesGenerationLoop';

// The ship job has 330 minutes: a new deploy starts only within the
// budget, and a started deploy, its first health check, the trailing watch
// window and the log-ingestion margin after it must still fit.
const DEFAULT_OPTIONS = {
  pollSeconds: 30,
  findRunSeconds: 300,
  deployTimeoutMinutes: 60,
  healthTimeoutSeconds: 300,
  watchMinutes: 30,
  // CloudWatch can show a log line or metric some minutes after it
  // happened: a window is judged this long after it closes, counting only
  // what happened inside it.
  ingestionLagMinutes: 5,
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
    ledger,
    saveLedger,
    onDispatch,
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
    this.ledger = ledger;
    this.saveLedger = saveLedger;
    this.onDispatch = onDispatch;
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
      warnings: [],
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

  /**
   * The release-note groups to send with `item`: the plan's stable groups,
   * asking to publish only when this deploy completes the group, that is
   * when every member still behind at planning time has now shipped.
   */
  groupsFor(item) {
    const shipped = new Set(this.shippedItems.map((done) => done.service));
    const outstanding = item.release_note_outstanding || {};
    return (item.release_note_groups || []).map((group) => {
      const left = (outstanding[group.pull_request_number] || []).filter(
        (service) => service !== item.service && !shipped.has(service)
      );
      return { ...group, publish_release_note: left.length === 0 };
    });
  }

  /** Drops the groups the receiver has certainly forgotten (see plan.js). */
  dropExpiredGroups() {
    const expiry = this.clock() - LEDGER_KEEP_DAYS * DAY_MS;
    for (const [key, entry] of Object.entries(this.ledger)) {
      if (Date.parse(entry.opened_at) <= expiry) delete this.ledger[key];
    }
  }

  /**
   * Saves, before `item` deploys, the service set of every group it is
   * about to send without completing, unless the ledger already holds that
   * group: the receiver keeps the first set it sees, so the set must be on
   * record before any deploy sends it. Returns the keys it recorded, or the
   * reason to defer `item` when it cannot save them.
   */
  async reserveGroups(item, groups) {
    if (!this.saveLedger) return { opened: [] };
    this.dropExpiredGroups();
    const opening = groups.filter(
      (group) =>
        !group.publish_release_note &&
        !this.ledger[String(group.pull_request_number)]
    );
    if (opening.length === 0) return { opened: [] };
    const opened = opening.map((group) => String(group.pull_request_number));
    const opened_at = new Date(this.clock()).toISOString();
    for (const group of opening) {
      this.ledger[String(group.pull_request_number)] = {
        services: group.release_group_services,
        shipped: [],
        opened_at
      };
    }
    try {
      await this.saveLedger(this.ledger);
      return { opened };
    } catch (error) {
      for (const key of opened) delete this.ledger[key];
      const ids = opening.map((group) => group.release_group_id).join(', ');
      return {
        opened: [],
        error: `release-note group ${ids} could not be recorded before its first deploy: ${errorMessage(error)}`
      };
    }
  }

  /**
   * Withdraws groups recorded for a deploy that was then not dispatched, so
   * their timer starts with the deploy that first sends them. If that save
   * also fails, the entry keeps the earlier start and the train warns: a
   * group first sent more than a day later could then leave the ledger
   * while the receiver still holds it.
   */
  async releaseGroups(item, opened) {
    if (opened.length === 0) return;
    for (const key of opened) delete this.ledger[key];
    try {
      await this.saveLedger(this.ledger);
    } catch (error) {
      this.result.warnings.push(
        `release-note ledger not saved after ${item.service} was not deployed: ${errorMessage(error)}`
      );
    }
  }

  /**
   * Why `item` must wait because one of its groups is in the receiver's
   * grace day (see plan.js), or null. The plan checked this when it was
   * made; the Ship job can start later, so it is checked again here, from
   * the ledger as read now or, if that lacks the group, the plan's record.
   */
  graceReason(item, groups) {
    for (const group of groups) {
      const pull = group.pull_request_number;
      const openedAt = Date.parse(
        this.ledger[String(pull)]?.opened_at ??
          item.release_note_opened_at?.[pull]
      );
      if (!Number.isFinite(openedAt)) continue;
      const { stage, until } = ledgerStage(openedAt, this.clock());
      if (stage === 'wait') {
        return `release-note group pr-${pull} may still be held by the receiver until ${until}; the train ships it after that`;
      }
      if (stage === 'forgotten') {
        return `release-note group pr-${pull} expired after planning; the next train plans it afresh`;
      }
    }
    return null;
  }

  /**
   * Remembers, for each group a deploy carried, which members shipped and
   * the deploy run that sent each one's release-note event. A group stays
   * in the ledger after its publishing deploy, until the receiver has
   * certainly forgotten it, so a member whose event never reached the
   * receiver can still be sent again with the same set (see
   * confirmReleaseNotes). The service set was recorded before the deploy
   * (see reserveGroups), so a failed save here loses only progress the next
   * plan reads again from what is still behind.
   */
  async recordGroups(item, groups, runId) {
    if (!this.saveLedger || groups.length === 0) return;
    this.dropExpiredGroups();
    for (const group of groups) {
      const key = String(group.pull_request_number);
      const entry = this.ledger[key] || {
        services: group.release_group_services,
        shipped: [],
        opened_at: new Date(this.clock()).toISOString()
      };
      if (!entry.shipped.includes(item.service)) {
        entry.shipped.push(item.service);
      }
      entry.runs = { ...entry.runs, [item.service]: runId };
      entry.unconfirmed = [
        ...new Set([...(entry.unconfirmed || []), item.service])
      ];
      if (group.publish_release_note) {
        entry.publish_requested_at = new Date(this.clock()).toISOString();
      }
      this.ledger[key] = entry;
    }
    try {
      await this.saveLedger(this.ledger);
    } catch (error) {
      this.result.warnings.push(
        `release-note ledger not saved after ${item.service}: ${errorMessage(error)}`
      );
    }
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
  async checkHealth(entry) {
    try {
      return await this.health.check(
        entry.item,
        entry.deployStartedAt,
        entry.until
      );
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
    } else if (
      this.clock() >=
      entry.until + this.options.ingestionLagMinutes * 60_000
    ) {
      // The window is over and its last minutes have had time to reach
      // CloudWatch: healthy if the new build was ever seen working.
      entry.status = entry.seenHealthy ? 'healthy' : 'unverified';
    } else {
      entry.status = entry.seenHealthy ? 'watching' : 'pending';
    }
  }

  /** Waits for the first healthy or unhealthy result, up to the health timeout. */
  async waitForFirstResult(entry) {
    const deadline = this.clock() + this.options.healthTimeoutSeconds * 1000;
    for (;;) {
      const verdict = await this.checkHealth(entry);
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
      const verdict = await this.checkHealth(entry);
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
    // A held dependency blocks its dependents even when it is not in this
    // train (it may look current while an operator step is still running).
    for (const name of item.catalog_dependencies || []) {
      const dependencyHeld = holdFor(
        catalogLib.getService(this.catalog, name),
        this.holds
      );
      if (dependencyHeld) {
        return `waits for held dependency ${name}: ${dependencyHeld}`;
      }
    }
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
   * Confirms the time budget is not used up and the service is outside
   * holds and quiet windows, from the clock alone. Records a stop or
   * deferral and returns false otherwise.
   */
  withinBudgetAndWindows(item) {
    if (this.clock() - this.startedAt > this.options.budgetMinutes * 60_000) {
      this.stopBefore(
        item,
        'time-budget',
        `train ran longer than ${this.options.budgetMinutes} minutes`
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
   * Confirms the time budget is not used up, the branch still points at the
   * train's commit and the service is outside holds and quiet windows.
   * Records a stop or deferral and returns false otherwise.
   */
  async clearToDispatch(item) {
    if (!this.withinBudgetAndWindows(item)) return false;
    const head = await this.client.getBranchSha(this.branch);
    if (head !== this.plan.target_sha) {
      this.stopBefore(
        item,
        'main-moved',
        `${this.branch} moved to ${head.slice(0, 10)}; the next train ships what still differs`
      );
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
    // and quiet windows again before dispatching.
    if (!(await this.clearToDispatch(item))) return null;
    const reserved = await this.reserveGroups(item, groups);
    if (reserved.error) {
      this.defer(item, reserved.error);
      return null;
    }
    // A deploy someone started since the idle check would make this one
    // wait behind it, and could be replaced by it if it is still waiting.
    const active = await activeDeployRuns(this.client, this.plan.environment);
    if (active.length > 0) {
      await this.releaseGroups(item, reserved.opened);
      this.stopBefore(
        item,
        'busy',
        `another deploy started just before ${item.service} was dispatched: ${active.map((run) => run.html_url).join(' ')}; the next train continues`
      );
      return null;
    }
    // The branch read, the ledger save and that check can take a while
    // too: check the groups' age, the time budget, holds and quiet windows
    // once more, immediately before dispatching.
    const grace = this.graceReason(item, groups);
    if (grace) {
      await this.releaseGroups(item, reserved.opened);
      this.defer(item, grace);
      return null;
    }
    if (!this.withinBudgetAndWindows(item)) {
      await this.releaseGroups(item, reserved.opened);
      return null;
    }
    const dispatchedAt = this.clock();
    this.onDispatch(item.service);
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
    return { runId, groups, priorIds, dispatchedAt };
  }

  /**
   * A deploy someone queued in the moment before this dispatch, which the
   * deploy workflow's concurrency group then replaced (it keeps one run
   * waiting per environment and cancels the older one): new since the
   * train's last look, not the train's own run, and cancelled.
   */
  async findDisplacedRun(runId, priorIds, dispatchedAt) {
    return (
      (await this.listDispatchedRuns()).find(
        (run) =>
          !priorIds.has(run.id) &&
          run.id !== runId &&
          run.status === 'completed' &&
          run.conclusion === 'cancelled' &&
          Date.parse(run.created_at) >= dispatchedAt - 120_000
      ) || null
    );
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
    const { runId, groups, priorIds, dispatchedAt } = dispatched;
    if (!runId) {
      this.stop(
        'deploy-unknown',
        'the deploy was dispatched but its run could not be found',
        item
      );
      return;
    }
    const displaced = await this.findDisplacedRun(
      runId,
      priorIds,
      dispatchedAt
    );
    try {
      await this.followDeploy(item, runId, groups);
    } finally {
      // The train's own deploy is checked first; then it halts, because
      // someone's deploy was cancelled and must be dispatched again.
      if (displaced && !this.result.stop?.halt) {
        this.stop(
          'displaced-deploy',
          `dispatching ${item.service} replaced a deploy that was waiting to run: ${displaced.html_url || displaced.id}; dispatch it again, then resume`,
          item
        );
      }
    }
  }

  /** Waits for `item`'s deploy run, records it and starts its health watch. */
  async followDeploy(item, runId, groups) {
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
    await this.recordGroups(item, groups, runSummary.run_id);
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
      // Reached only when a halt ended the watch early: keep what was seen,
      // and say the window did not run its course.
      if (isWatched(entry)) {
        entry.status = entry.seenHealthy ? 'healthy' : 'unverified';
        entry.note = [entry.note, 'watch cut short by the halt']
          .filter(Boolean)
          .join('; ');
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

  /**
   * Confirms that the receiver recorded each member's release-note event
   * for each group: the release-notes loop logs the group, service and
   * deploy run of every event it records, so a deploy that carried several
   * groups is confirmed group by group. Runs at the end of each train, after the watch windows, so
   * this train's events have had time to arrive; members seen are
   * confirmed, and members of groups still unconfirmed are reported with
   * how to send their event again. Best effort: it never stops a train.
   */
  async confirmReleaseNotes() {
    if (
      !this.saveLedger ||
      typeof this.health?.releaseNoteSeen !== 'function'
    ) {
      return;
    }
    const pending = Object.entries(this.ledger).flatMap(([pull, entry]) =>
      (entry.unconfirmed || [])
        .filter((service) => entry.runs?.[service])
        .map((service) => ({ pull, entry, service }))
    );
    if (pending.length === 0) return;
    let region;
    try {
      region = catalogLib.getService(this.catalog, RELEASE_NOTES_SERVICE)
        .aws_region[this.plan.environment];
    } catch (error) {
      this.result.warnings.push(
        `release-note events not confirmed: ${errorMessage(error)}`
      );
      return;
    }
    let changed = false;
    for (const { pull, entry, service } of pending) {
      let seen;
      try {
        seen = await this.health.releaseNoteSeen({
          region,
          functionName: RELEASE_NOTES_SERVICE,
          pull,
          service,
          runId: entry.runs[service],
          since: Date.parse(entry.opened_at)
        });
      } catch (error) {
        this.result.warnings.push(
          `release-note events not confirmed: ${errorMessage(error)}`
        );
        return;
      }
      if (seen) {
        entry.unconfirmed = entry.unconfirmed.filter(
          (name) => name !== service
        );
        changed = true;
      } else {
        this.result.warnings.push(
          `release-note event for ${service} (deploy run ${entry.runs[service]}, group pr-${pull}) has not reached the release-notes loop; send it again by deploying ${service} by hand with group pr-${pull} from the ledger issue`
        );
      }
    }
    if (!changed) return;
    try {
      await this.saveLedger(this.ledger);
    } catch (error) {
      this.result.warnings.push(
        `release-note ledger not saved after confirming events: ${errorMessage(error)}`
      );
    }
  }

  async run() {
    while (this.queue.length > 0 && !this.result.stop) {
      const item = this.queue.shift();
      if ((await this.gate(item)) === 'go') await this.deployAndCheck(item);
    }
    await this.finalWatch();
    await this.confirmReleaseNotes();
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
  ledger = {},
  saveLedger = null,
  onDispatch = () => undefined,
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
    ledger,
    saveLedger,
    onDispatch,
    clock,
    sleep,
    log,
    options: { ...DEFAULT_OPTIONS, ...options }
  }).run();
}

module.exports = { DEFAULT_OPTIONS, SOFT_STOPS, deployInputs, runTrain };
