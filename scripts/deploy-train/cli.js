#!/usr/bin/env node
'use strict';

const { randomBytes } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const catalogLib = require('./catalog');
const gitLib = require('./git');
const github = require('./github');
const {
  parseHolds,
  parseTeamWindows,
  variableSources
} = require('./blackouts');
const { computeDrift } = require('./drift');
const { resolveMode, buildTrainPlan } = require('./plan');
const report = require('./report');

const repoRoot = path.resolve(__dirname, '..', '..');
const DEFAULT_REPOSITORY = '6529-Collections/6529seize-backend';
const CONTROLS_FILE = 'ops/deploy-train/controls.json';
const SHIP_JOB_NAME = 'Ship';

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const flags = {};
  for (let index = 0; index < rest.length; index++) {
    const arg = rest[index];
    if (!arg.startsWith('--')) throw new Error(`Unexpected argument ${arg}`);
    const equals = arg.indexOf('=');
    if (equals !== -1) {
      flags[arg.slice(2, equals)] = arg.slice(equals + 1);
    } else if (
      rest[index + 1] !== undefined &&
      !rest[index + 1].startsWith('--')
    ) {
      flags[arg.slice(2)] = rest[index + 1];
      index += 1;
    } else {
      flags[arg.slice(2)] = true;
    }
  }
  return { command, flags };
}

function log(message) {
  process.stderr.write(`${message}\n`);
}

function writeGithubOutputs(values) {
  const file = process.env.GITHUB_OUTPUT;
  if (!file) return;
  const lines = [];
  for (const [key, value] of Object.entries(values)) {
    const text = String(value ?? '');
    if (text.includes('\n')) {
      const delimiter = `EOF_${randomBytes(12).toString('hex')}`;
      lines.push(`${key}<<${delimiter}`, text, delimiter);
    } else {
      lines.push(`${key}=${text}`);
    }
  }
  fs.appendFileSync(file, `${lines.join('\n')}\n`);
}

function alertOutputs(alert) {
  return {
    notify: alert ? 'true' : 'false',
    alert_status: alert ? alert.status : '',
    alert_title: alert ? alert.title : '',
    alert_description: alert ? alert.description : ''
  };
}

function writeFileIfRequested(target, content) {
  if (typeof target === 'string') fs.writeFileSync(target, content);
}

function requireEnvironment(environment = 'prod') {
  if (!['prod', 'staging'].includes(environment)) {
    throw new Error('--environment must be prod or staging');
  }
  return environment;
}

function githubClient(flags) {
  return github.createGitHubClient({
    token: process.env.GH_TOKEN || process.env.GITHUB_TOKEN,
    repository:
      flags.repository || process.env.GITHUB_REPOSITORY || DEFAULT_REPOSITORY,
    apiUrl: process.env.GITHUB_API_URL || 'https://api.github.com'
  });
}

function catalogAt(sha) {
  return catalogLib.loadCatalog(
    JSON.parse(
      gitLib.git(repoRoot, ['show', `${sha}:src/config/deploy-services.json`])
    )
  );
}

/**
 * Repository variables the train reads for holds and team windows. The
 * workflow passes all of them as DEPLOY_TRAIN_VARS (`toJSON(vars)`), so
 * per-person variables need no extra token permission; local runs fall back
 * to the process environment.
 */
function trainVariables() {
  const raw = process.env.DEPLOY_TRAIN_VARS;
  if (!raw) return process.env;
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new TypeError('DEPLOY_TRAIN_VARS must be a JSON object');
  }
  return parsed;
}

/**
 * Team windows and temporary holds at `sha`: the committed controls file
 * plus every DEPLOY_TRAIN_TEAM_WINDOWS* and DEPLOY_TRAIN_HOLDS* variable.
 */
function controlsAt(sha, catalog) {
  const committed = gitLib.git(repoRoot, ['show', `${sha}:${CONTROLS_FILE}`], {
    allowFailure: true
  });
  const file = {
    name: CONTROLS_FILE,
    text: committed || '',
    keys: ['windows', 'holds']
  };
  const known = new Set(catalog.services.map((service) => service.name));
  const variables = trainVariables();
  return {
    teamWindows: parseTeamWindows(
      [file, ...variableSources(variables, 'DEPLOY_TRAIN_TEAM_WINDOWS')],
      known
    ),
    holds: parseHolds(
      [file, ...variableSources(variables, 'DEPLOY_TRAIN_HOLDS')],
      known
    )
  };
}

function readDeployedFile(file) {
  return new Map(Object.entries(JSON.parse(fs.readFileSync(file, 'utf8'))));
}

/** Resolves deployed commits and computes drift for one environment. */
async function driftFor(flags, client, environment, targetSha) {
  const catalog = catalogAt(targetSha);
  const names = catalogLib
    .servicesForEnvironment(catalog, environment)
    .map((service) => service.name);
  const deployed =
    typeof flags['deployed-file'] === 'string'
      ? readDeployedFile(flags['deployed-file'])
      : await github.findDeployedCommits({
          client,
          environment,
          services: names
        });
  const lookupPullRequests = client
    ? async (sha) => {
        try {
          return (await client.pullRequestsForCommit(sha)).map(
            (pull) => pull.number
          );
        } catch {
          return [];
        }
      }
    : null;
  return computeDrift({
    repoRoot,
    environment,
    targetSha,
    deployed,
    cacheDir:
      typeof flags['cache-dir'] === 'string'
        ? flags['cache-dir']
        : path.join(os.tmpdir(), 'deploy-drift-cache'),
    concurrency: flags.concurrency ? Number(flags.concurrency) : undefined,
    services:
      typeof flags.services === 'string'
        ? new Set(flags.services.split(',').map((name) => name.trim()))
        : null,
    esbuild: require('esbuild'),
    parseYaml: require('yaml').parse,
    lookupPullRequests,
    log
  });
}

function resolveTarget(flags) {
  return gitLib.resolveCommit(
    repoRoot,
    typeof flags.target === 'string' ? flags.target : 'HEAD'
  );
}

async function commandDrift(flags) {
  const environment = requireEnvironment(flags.environment);
  const targetSha = resolveTarget(flags);
  const offline =
    typeof flags['deployed-file'] === 'string' &&
    !process.env.GH_TOKEN &&
    !process.env.GITHUB_TOKEN;
  const client = offline ? null : githubClient(flags);
  const drift = await driftFor(flags, client, environment, targetSha);
  const markdown = report.renderDriftMarkdown(drift);
  writeFileIfRequested(flags.json, `${JSON.stringify(drift, null, 2)}\n`);
  writeFileIfRequested(flags.markdown, markdown);
  const behind = drift.services.filter((record) => record.status === 'behind');
  const errors = drift.services.filter((record) => record.status === 'error');
  if (flags['github-output']) {
    writeGithubOutputs({
      behind_count: behind.length,
      error_count: errors.length,
      builds: drift.stats.builds,
      ...alertOutputs(report.driftAlert(drift))
    });
  }
  if (!flags.json && !flags.markdown) process.stdout.write(markdown);
  log(
    `drift: ${behind.length} behind, ${errors.length} errors, ${drift.stats.builds} builds in ${drift.stats.seconds}s`
  );
  if (flags['fail-on-drift'] && (behind.length > 0 || errors.length > 0)) {
    process.exitCode = 3;
  }
}

/** Plans a train: mode, halt state, team windows, drift and deferrals. */
async function commandPlan(flags) {
  const environment = requireEnvironment(flags.environment);
  if (environment !== 'prod') {
    throw new Error(
      'The deploy train covers prod only; see docs/deployment.md'
    );
  }
  const eventName = process.env.GITHUB_EVENT_NAME || 'workflow_dispatch';
  const { mode, notes } = resolveMode({
    variable: process.env.DEPLOY_TRAIN_MODE,
    requested: process.env.DEPLOY_TRAIN_REQUESTED_MODE,
    eventName
  });
  if (mode === 'off') {
    log('DEPLOY_TRAIN_MODE is off; nothing to plan');
    writeGithubOutputs({ mode, ship_count: 0, ...alertOutputs(null) });
    return;
  }
  const targetSha = resolveTarget(flags);
  const catalog = catalogAt(targetSha);
  const { teamWindows, holds } = controlsAt(targetSha, catalog);
  const client = githubClient(flags);
  // In a resume run, the Resume job has already cleared the halts opened
  // before the dispatch.
  const resuming = process.env.DEPLOY_TRAIN_RESUME === 'true';
  const currentRunId = Number(process.env.GITHUB_RUN_ID || 0);
  // A resume run still honours halts its Resume job did not clear: halt
  // issues opened after the dispatch, and Ship jobs in the run history that
  // failed after it.
  const halt =
    mode === 'prod'
      ? await github.currentHalt(client, {
          currentRunId,
          shipJobName: SHIP_JOB_NAME,
          resumedAt: resuming
            ? await github.resumeRequestedAt(client, currentRunId)
            : null
        })
      : null;
  const drift = await driftFor(flags, client, environment, targetSha);
  // Release-note groups already started keep their service set.
  const { groups: ledger } = await github.readLedger(client);
  const plan = buildTrainPlan({
    catalog,
    drift,
    mode,
    teamWindows,
    holds,
    halt,
    ledger,
    notes: resuming
      ? notes.concat(
          'resume requested: halts opened before the dispatch are cleared'
        )
      : notes
  });
  // The Ship job refuses a plan from an earlier attempt of the run, so
  // re-running only Ship cannot replay a plan made before a halt.
  plan.run_id = process.env.GITHUB_RUN_ID || null;
  plan.run_attempt = process.env.GITHUB_RUN_ATTEMPT || null;
  const markdown = report.renderPlanMarkdown(plan);
  writeFileIfRequested(flags.json, `${JSON.stringify(plan, null, 2)}\n`);
  writeFileIfRequested(
    flags['drift-json'],
    `${JSON.stringify(drift, null, 2)}\n`
  );
  writeFileIfRequested(flags.markdown, markdown);
  const willShip = mode === 'prod' && !halt && plan.ship.length > 0;
  // Report mode posts once per merge; prod mode posts when the train ends.
  const alert =
    mode === 'report' && eventName === 'push' ? report.planAlert(plan) : null;
  writeGithubOutputs({
    mode: halt ? 'halted' : mode,
    target_sha: targetSha,
    ship_count: willShip ? plan.ship.length : 0,
    builds: drift.stats.builds,
    ...alertOutputs(alert)
  });
  if (!flags.json && !flags.markdown) process.stdout.write(markdown);
  log(
    `plan (${mode}${halt ? ', halted' : ''}): ${plan.ship.length} to ship, ${plan.deferred.length} deferred`
  );
}

/**
 * The plan artifact comes from a job that ran npm install scripts, so
 * re-check everything that decides where and what the train deploys.
 */
function validatePlanForShip(plan) {
  if (plan.mode !== 'prod' || plan.halt || plan.environment !== 'prod') {
    throw new Error('Only an unhalted prod plan for prod can ship');
  }
  const { mode } = resolveMode({
    variable: process.env.DEPLOY_TRAIN_MODE,
    requested: '',
    eventName: 'push'
  });
  if (mode !== 'prod') {
    throw new Error('DEPLOY_TRAIN_MODE is no longer prod; refusing to ship');
  }
  gitLib.assertSha(plan.target_sha, 'plan target');
  if (gitLib.resolveCommit(repoRoot, 'HEAD') !== plan.target_sha) {
    throw new Error('The checkout does not match the planned commit');
  }
  const catalog = catalogAt(plan.target_sha);
  for (const item of plan.ship) {
    const service = catalogLib.getService(catalog, item.service);
    if (!service.allowed_environments.includes(plan.environment)) {
      throw new Error(`${item.service} cannot deploy to ${plan.environment}`);
    }
  }
  return catalog;
}

function positiveNumber(name, fallback, integer) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!(value > 0) || (integer && !Number.isInteger(value))) {
    throw new Error(
      `${name} must be a positive ${integer ? 'integer' : 'number'}`
    );
  }
  return value;
}

/** Health-check settings from repository variables, validated. */
function healthSettings() {
  const expectedAuth = process.env.DEPLOY_TRAIN_DB_AUTH || 'IAM';
  if (!['IAM', 'PASSWORD'].includes(expectedAuth)) {
    throw new Error('DEPLOY_TRAIN_DB_AUTH must be IAM or PASSWORD');
  }
  // A read-only role: CloudWatch metrics and Lambda log lines. The deploy
  // itself runs in "Deploy a service" with that workflow's own role.
  const roleArn = process.env.DEPLOY_TRAIN_HEALTH_ROLE_ARN || '';
  if (!/^arn:aws:iam::\d{12}:role\/[\w+=,.@/-]+$/.test(roleArn)) {
    throw new Error(
      'DEPLOY_TRAIN_HEALTH_ROLE_ARN must name the read-only health-check role'
    );
  }
  const { DEFAULT_ERROR_THRESHOLDS } = require('./health');
  return {
    expectedAuth,
    roleArn,
    thresholds: {
      minErrors: positiveNumber(
        'DEPLOY_TRAIN_ERROR_MIN_COUNT',
        DEFAULT_ERROR_THRESHOLDS.minErrors,
        true
      ),
      rateFactor: positiveNumber(
        'DEPLOY_TRAIN_ERROR_RATE_FACTOR',
        DEFAULT_ERROR_THRESHOLDS.rateFactor,
        false
      )
    }
  };
}

/** Runs a planned prod train through the deploy workflow. */
/**
 * Why this Ship job must not run the plan, or null. A plan from an earlier
 * attempt of the run (Ship re-run on its own) or a halt recorded since the
 * plan was made both need a fresh train, and a resume for the halt.
 */
async function staleShipReason(plan, client) {
  const attempt = process.env.GITHUB_RUN_ATTEMPT || null;
  if (plan.run_attempt !== attempt) {
    return `the plan comes from run attempt ${plan.run_attempt}, not ${attempt}; dispatch a new Deploy train instead of re-running Ship`;
  }
  // The halt issues are the ledger; a resume run has already cleared them.
  const [halt] = await github.findHaltIssues(client);
  return halt
    ? `the train is halted (issue #${halt.number}); resume it with a resume=true dispatch`
    : null;
}

/**
 * Records each service just before its dispatch, so a cancelled Ship job
 * can tell whether it may have changed production (see record-halt).
 */
function progressRecorder(target) {
  if (typeof target !== 'string') return undefined;
  const dispatched = [];
  return (service) => {
    dispatched.push(service);
    // Write then rename, so a cancellation never leaves half a file.
    fs.writeFileSync(`${target}.tmp`, JSON.stringify({ dispatched }));
    fs.renameSync(`${target}.tmp`, target);
  };
}

/**
 * The release-note ledger for a train, and how to save it. The plan already
 * fixed this train's groups, so an unreadable ledger only stops the train
 * from recording them: release notes are best effort and must not halt it.
 */
async function shipLedger(client) {
  let current;
  try {
    current = await github.readLedger(client);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ledger: {},
      saveLedger: null,
      ledgerWarning: `release-note ledger not read, so this train's groups are not recorded: ${message}`
    };
  }
  let number = current.number;
  return {
    ledger: current.groups,
    saveLedger: async (groups) => {
      ({ number } = await github.writeLedger(client, { number, groups }));
    },
    ledgerWarning: null
  };
}

async function commandShip(flags) {
  if (typeof flags.plan !== 'string') throw new Error('--plan is required');
  const plan = JSON.parse(fs.readFileSync(flags.plan, 'utf8'));
  const catalog = validatePlanForShip(plan);
  const client = githubClient(flags);
  const stale = await staleShipReason(plan, client);
  if (stale) {
    // Not a failure: nothing was deployed and no new halt is recorded. The
    // result files are still written so the workflow's summary step works.
    log(`not shipping: ${stale}`);
    writeFileIfRequested(
      flags.result,
      `${JSON.stringify({ skipped: stale, shipped: [] }, null, 2)}\n`
    );
    writeFileIfRequested(flags.markdown, report.renderSkippedShip(plan, stale));
    writeGithubOutputs({
      halted: 'false',
      shipped_count: 0,
      ...alertOutputs(null)
    });
    return;
  }
  const settings = healthSettings();
  const { teamWindows, holds } = controlsAt(plan.target_sha, catalog);
  const { ledger, saveLedger, ledgerWarning } = await shipLedger(client);
  const { runTrain } = require('./executor');
  const { createAwsCli, createHealthChecker } = require('./health');
  const aws = createAwsCli({
    roleArn: settings.roleArn,
    sessionName: `deploy-train-${process.env.GITHUB_RUN_ID || 'local'}`
  });
  try {
    const result = await runTrain({
      plan,
      catalog,
      client,
      health: createHealthChecker({
        aws,
        environment: plan.environment,
        expectedAuth: settings.expectedAuth,
        thresholds: settings.thresholds
      }),
      teamWindows,
      holds,
      ledger,
      saveLedger,
      onDispatch: progressRecorder(flags.progress),
      log
    });
    if (ledgerWarning) result.warnings.unshift(ledgerWarning);
    writeFileIfRequested(flags.result, `${JSON.stringify(result, null, 2)}\n`);
    writeFileIfRequested(
      flags.markdown,
      report.renderTrainMarkdown(plan, result)
    );
    writeGithubOutputs({
      halted: result.stop?.halt ? 'true' : 'false',
      shipped_count: result.shipped.length,
      ...alertOutputs(report.trainAlert(plan, result))
    });
    log(
      result.stop
        ? `train: ${result.shipped.length} shipped, stopped (${result.stop.reason})`
        : `train: ${result.shipped.length} shipped`
    );
  } finally {
    aws.cleanup();
  }
}

function runUrl() {
  const server = process.env.GITHUB_SERVER_URL || 'https://github.com';
  const repository = process.env.GITHUB_REPOSITORY || DEFAULT_REPOSITORY;
  return `${server}/${repository}/actions/runs/${process.env.GITHUB_RUN_ID || 'local'}`;
}

function readJsonIfPresent(file) {
  if (typeof file !== 'string' || !fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** Opens the issue that keeps the train halted until a resume dispatch. */
/**
 * The halt a cancelled Ship job leaves: the train's own halt if it finished
 * with one, or, cut off mid-run, a halt when it had already dispatched a
 * deploy whose outcome no train has checked. A cancellation before any
 * dispatch changed nothing and is a soft stop (null).
 */
function cancelledShipHalt(result, progress) {
  if (result) return result.stop?.halt ? result : null;
  const dispatched = progress?.dispatched || [];
  if (dispatched.length === 0) return null;
  return {
    stop: {
      reason: 'train-cancelled',
      halt: true,
      service: dispatched.at(-1),
      detail: `the Ship job was cancelled after dispatching ${dispatched.join(', ')}; check those deploys before resuming`
    },
    shipped: [],
    not_started: []
  };
}

async function commandRecordHalt(flags) {
  const plan = readJsonIfPresent(flags.plan);
  let result = readJsonIfPresent(flags.result);
  if (process.env.JOB_STATUS === 'cancelled') {
    result = cancelledShipHalt(result, readJsonIfPresent(flags.progress));
    if (!result) {
      log('Ship was cancelled without a halt or a dispatched deploy');
      return;
    }
  }
  const issue = await github.recordHalt(
    githubClient(flags),
    report.haltIssue(plan, result, runUrl())
  );
  log(`halt recorded in ${issue.url}`);
}

/** Clears halts: run by the Resume job of a resume=true dispatch. */
async function commandResume(flags) {
  const by =
    process.env.GITHUB_TRIGGERING_ACTOR ||
    process.env.GITHUB_ACTOR ||
    'unknown';
  const client = githubClient(flags);
  // Only halts opened before this resume was dispatched; a re-run attempt
  // keeps the original dispatch time, so it cannot clear a newer halt.
  const requestedBefore = await github.resumeRequestedAt(
    client,
    process.env.GITHUB_RUN_ID
  );
  const { cleared, kept } = await github.resumeHalts(client, {
    by,
    runUrl: runUrl(),
    requestedBefore
  });
  const numbers = (halts) => halts.map((halt) => `#${halt.number}`).join(', ');
  log(
    cleared.length > 0
      ? `resumed: cleared ${numbers(cleared)}`
      : 'resume: no halt to clear'
  );
  if (kept.length > 0) {
    log(
      `::warning::kept ${numbers(kept)}: opened after this resume was dispatched; dispatch Deploy train with resume=true again to clear them`
    );
  }
}

const COMMANDS = {
  drift: commandDrift,
  plan: commandPlan,
  ship: commandShip,
  'record-halt': commandRecordHalt,
  resume: commandResume
};

async function main(argv) {
  const { command, flags } = parseArgs(argv);
  const handler = COMMANDS[command];
  if (!handler) {
    throw new Error(
      `Usage: cli.js <${Object.keys(COMMANDS).join('|')}> [--flags]`
    );
  }
  await handler(flags);
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((error) => {
    log(error instanceof Error ? error.stack || error.message : String(error));
    process.exitCode = 1;
  });
}

module.exports = {
  parseArgs,
  main,
  writeGithubOutputs,
  staleShipReason,
  shipLedger,
  cancelledShipHalt,
  progressRecorder
};
