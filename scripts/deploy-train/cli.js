#!/usr/bin/env node
'use strict';

const { randomBytes } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const catalogLib = require('./catalog');
const gitLib = require('./git');
const github = require('./github');
const { parseTeamWindows } = require('./blackouts');
const { computeDrift } = require('./drift');
const { resolveMode, buildTrainPlan } = require('./plan');
const report = require('./report');

const repoRoot = path.resolve(__dirname, '..', '..');
const DEFAULT_REPOSITORY = '6529-Collections/6529seize-backend';
const TEAM_WINDOWS_FILE = 'ops/deploy-train/team-windows.json';
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

/** Team windows from the committed file at `sha` and the repository variable. */
function teamWindowsAt(sha, catalog) {
  const committed = gitLib.git(
    repoRoot,
    ['show', `${sha}:${TEAM_WINDOWS_FILE}`],
    {
      allowFailure: true
    }
  );
  return parseTeamWindows(
    [
      { name: TEAM_WINDOWS_FILE, text: committed || '' },
      {
        name: 'DEPLOY_TRAIN_TEAM_WINDOWS',
        text: process.env.DEPLOY_TRAIN_TEAM_WINDOWS || ''
      }
    ],
    new Set(catalog.services.map((service) => service.name))
  );
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
  const teamWindows = teamWindowsAt(targetSha, catalog);
  const client = githubClient(flags);
  const resuming = process.env.DEPLOY_TRAIN_RESUME === 'true';
  const halt =
    mode === 'prod' && !resuming
      ? await github.findUnclearedHalt(client, {
          currentRunId: Number(process.env.GITHUB_RUN_ID || 0),
          shipJobName: SHIP_JOB_NAME
        })
      : null;
  const drift = await driftFor(flags, client, environment, targetSha);
  const plan = buildTrainPlan({
    catalog,
    drift,
    mode,
    teamWindows,
    halt,
    notes: resuming
      ? notes.concat('resume requested: earlier halts are cleared')
      : notes
  });
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

/** Runs a planned prod train through the deploy workflow. */
async function commandShip(flags) {
  if (typeof flags.plan !== 'string') throw new Error('--plan is required');
  const plan = JSON.parse(fs.readFileSync(flags.plan, 'utf8'));
  // The plan artifact comes from a job that ran npm install scripts, so
  // re-check everything that decides where the train deploys.
  if (plan.mode !== 'prod' || plan.halt || plan.environment !== 'prod') {
    throw new Error('Only an unhalted prod plan for prod can ship');
  }
  const expectedAuth = process.env.DEPLOY_TRAIN_DB_AUTH || 'IAM';
  if (!['IAM', 'PASSWORD'].includes(expectedAuth)) {
    throw new Error('DEPLOY_TRAIN_DB_AUTH must be IAM or PASSWORD');
  }
  if (process.env.DEPLOY_TRAIN_MODE !== 'prod') {
    throw new Error('DEPLOY_TRAIN_MODE is no longer prod; refusing to ship');
  }
  gitLib.assertSha(plan.target_sha, 'plan target');
  const { runTrain } = require('./executor');
  const { createAwsCli, createHealthChecker } = require('./health');
  // A read-only role: CloudWatch metrics and Lambda log lines. The deploy
  // itself runs in "Deploy a service" with that workflow's own role.
  const roleArn = process.env.DEPLOY_TRAIN_HEALTH_ROLE_ARN || '';
  if (!/^arn:aws:iam::\d{12}:role\/[\w+=,.@/-]+$/.test(roleArn)) {
    throw new Error(
      'DEPLOY_TRAIN_HEALTH_ROLE_ARN must name the read-only health-check role'
    );
  }
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
  const aws = createAwsCli({
    roleArn,
    sessionName: `deploy-train-${process.env.GITHUB_RUN_ID || 'local'}`
  });
  try {
    const result = await runTrain({
      plan,
      catalog,
      client: githubClient(flags),
      health: createHealthChecker({
        aws,
        environment: plan.environment,
        expectedAuth
      }),
      teamWindows: teamWindowsAt(plan.target_sha, catalog),
      log
    });
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

const COMMANDS = { drift: commandDrift, plan: commandPlan, ship: commandShip };

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

module.exports = { parseArgs, main, writeGithubOutputs };
