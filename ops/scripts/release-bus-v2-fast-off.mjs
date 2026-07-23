#!/usr/bin/env node

import { spawnSync } from 'node:child_process';

const EXPECTED_ACCOUNT = '987989283142';
const REPOSITORIES = [
  '6529-Collections/6529seize-backend',
  '6529-Collections/6529seize-frontend'
];
const FUNCTIONS = ['seizeAPI', 'releaseBusV2Reconciler'];
const RULE_PREFIX = 'releaseBus-prod-V2ReconcilerEventsRuleSchedule1';
const API_URL =
  process.env.RELEASE_BUS_API_URL?.trim() || 'https://api.6529.io';

class RollbackError extends Error {}

function run(executable, args, { allowFailure = false } = {}) {
  const result = spawnSync(
    executable, // NOSONAR -- fixed executable names; no bus input controls PATH.
    args,
    {
      encoding: 'utf8',
      maxBuffer: 5 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 60_000
    }
  );
  if (result.error?.code === 'ENOENT')
    throw new RollbackError(`${executable} is required for fast v2 rollback.`);
  if (result.status !== 0 && !allowFailure)
    throw new RollbackError(
      `${executable} failed during fast v2 rollback (${result.status ?? 'unknown'}).`
    );
  return { ok: result.status === 0, stdout: result.stdout?.trim() ?? '' };
}

function parseJson(value, description) {
  try {
    return JSON.parse(value);
  } catch {
    throw new RollbackError(`${description} returned malformed JSON.`);
  }
}

function requireExecuteFlag() {
  if (process.argv.length !== 3 || process.argv[2] !== '--execute')
    throw new RollbackError(
      'Usage: node ops/scripts/release-bus-v2-fast-off.mjs --execute'
    );
}

function verifyIdentity() {
  const identity = parseJson(
    run('aws', ['sts', 'get-caller-identity', '--output', 'json']).stdout,
    'AWS identity lookup'
  );
  if (identity.Account !== EXPECTED_ACCOUNT)
    throw new RollbackError(
      `Expected AWS account ${EXPECTED_ACCOUNT}; refusing account ${String(identity.Account)}.`
    );
  const auth = run('gh', ['auth', 'status']);
  if (!auth.ok) throw new RollbackError('GitHub CLI is not authenticated.');
}

function getGitHubToken() {
  const token = run('gh', ['auth', 'token']).stdout;
  if (!token) throw new RollbackError('Unable to obtain GitHub token.');
  return token;
}

async function pauseAutomationBestEffort(token) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  timeout.unref();
  try {
    const response = await fetch(
      new URL('/deploy/release-bus-v2/pause', API_URL),
      {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          scope: 'ALL',
          reason: 'Fast rollback to OFF; manual fallback remains authoritative'
        }),
        redirect: 'error',
        signal: controller.signal
      }
    );
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

function findScheduleRule() {
  const rules = parseJson(
    run('aws', [
      'events',
      'list-rules',
      '--name-prefix',
      RULE_PREFIX,
      '--query',
      'Rules[].Name',
      '--output',
      'json'
    ]).stdout,
    'EventBridge rule lookup'
  );
  if (!Array.isArray(rules) || rules.length !== 1 || !rules[0])
    throw new RollbackError(
      `Expected exactly one v2 reconciler schedule; found ${Array.isArray(rules) ? rules.length : 'invalid data'}.`
    );
  return rules[0];
}

function disableSchedule(ruleName) {
  run('aws', ['events', 'disable-rule', '--name', ruleName]);
}

function setGitHubModesOff() {
  for (const repository of REPOSITORIES) {
    run('gh', [
      'variable',
      'set',
      'RELEASE_BUS_V2_MODE',
      '--body',
      'OFF',
      '--repo',
      repository
    ]);
    run(
      'gh',
      [
        'variable',
        'delete',
        'RELEASE_BUS_V2_BETA_ALLOWLIST',
        '--repo',
        repository
      ],
      { allowFailure: true }
    );
  }
}

function updateFunctionOff(functionName) {
  const configuration = parseJson(
    run('aws', [
      'lambda',
      'get-function-configuration',
      '--function-name',
      functionName,
      '--output',
      'json'
    ]).stdout,
    `${functionName} configuration lookup`
  );
  const variables = configuration.Environment?.Variables;
  if (
    typeof configuration.RevisionId !== 'string' ||
    variables === null ||
    typeof variables !== 'object' ||
    Array.isArray(variables)
  )
    throw new RollbackError(`${functionName} configuration is incomplete.`);
  const nextVariables = {
    ...variables,
    RELEASE_BUS_V2_MODE: 'OFF',
    RELEASE_BUS_V2_BETA_ALLOWLIST: ''
  };
  run('aws', [
    'lambda',
    'update-function-configuration',
    '--function-name',
    functionName,
    '--revision-id',
    configuration.RevisionId,
    '--environment',
    JSON.stringify({ Variables: nextVariables }),
    '--no-cli-pager'
  ]);
  run('aws', [
    'lambda',
    'wait',
    'function-updated-v2',
    '--function-name',
    functionName
  ]);
}

function verifyFunctionOff(functionName) {
  const configuration = parseJson(
    run('aws', [
      'lambda',
      'get-function-configuration',
      '--function-name',
      functionName,
      '--output',
      'json'
    ]).stdout,
    `${functionName} verification`
  );
  if (
    configuration.LastUpdateStatus !== 'Successful' ||
    configuration.Environment?.Variables?.RELEASE_BUS_V2_MODE !== 'OFF' ||
    (configuration.Environment?.Variables?.RELEASE_BUS_V2_BETA_ALLOWLIST ??
      '') !== ''
  )
    throw new RollbackError(`${functionName} did not verify empty OFF.`);
}

async function verifyApiOff(token) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  timeout.unref();
  try {
    const response = await fetch(
      new URL('/deploy/release-bus-v2/controls', API_URL),
      {
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${token}`
        },
        redirect: 'error',
        signal: controller.signal
      }
    );
    if (!response.ok) throw new Error('status failed');
    const payload = await response.json();
    if (payload?.mode !== 'OFF') throw new Error('mode is not OFF');
  } catch {
    throw new RollbackError('Release Bus v2 API did not verify OFF.');
  } finally {
    clearTimeout(timeout);
  }
}

try {
  requireExecuteFlag();
  verifyIdentity();
  const token = getGitHubToken();
  const pauseAccepted = await pauseAutomationBestEffort(token);
  const scheduleRule = findScheduleRule();
  disableSchedule(scheduleRule);
  setGitHubModesOff();
  for (const functionName of FUNCTIONS) updateFunctionOff(functionName);
  for (const functionName of FUNCTIONS) verifyFunctionOff(functionName);
  await verifyApiOff(token);
  process.stdout.write(
    `${JSON.stringify({
      mode: 'OFF',
      beta_allowlist: 'empty',
      schedule: 'DISABLED',
      controls_pause_requested: pauseAccepted,
      functions: FUNCTIONS
    })}\n`
  );
} catch (error) {
  const message =
    error instanceof RollbackError
      ? error.message
      : 'Fast v2 rollback failed unexpectedly.';
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
