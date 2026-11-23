'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { systemExecutable } = require('./git');

const DAY_MS = 24 * 60 * 60 * 1000;
// Startup and database-login failures: any one of these from the new build
// halts the train.
const BAD_LOG_PATTERN =
  '?"Access denied" ?ER_ACCESS_DENIED ?"Cannot find module" ?ImportModuleError ?"Status: error" ?"Status: timeout"';
const AUTH_MODES = ['IAM', 'PASSWORD'];
const MINUTE_MS = 60 * 1000;

function authLogPattern(mode) {
  return `"AUTH ${mode}"`;
}
const INVOCATION_LOG_PATTERN = '"REPORT RequestId"';
const TOKEN_REFRESH_MS = 4 * 60 * 1000;
const UNCHECKED_PROFILES = new Set([
  'cloudformation-stack',
  'lambda-edge-association'
]);
// Generic Lambda errors halt only when they repeat and clearly exceed the
// normal rate. Provisional; tune with DEPLOY_TRAIN_ERROR_MIN_COUNT and
// DEPLOY_TRAIN_ERROR_RATE_FACTOR once there is data from real trains.
const DEFAULT_ERROR_THRESHOLDS = { minErrors: 3, rateFactor: 2 };

function authModes(lines) {
  return lines
    .map((line) => /AUTH (IAM|PASSWORD)/.exec(line))
    .filter(Boolean)
    .map((match) => match[1]);
}

/** Startup or database-login failures logged by the new build. */
function confirmedFailures({
  badLines,
  authLines,
  expectsDbAuth,
  expectedAuth
}) {
  const findings = [];
  if (badLines.length > 0) {
    findings.push(`new build logged "${badLines[0].trim().slice(0, 160)}"`);
  }
  const wrongMode = authModes(authLines).find((mode) => mode !== expectedAuth);
  if (expectsDbAuth && wrongMode) {
    findings.push(
      `new build's database login used [AUTH ${wrongMode}], expected [AUTH ${expectedAuth}]`
    );
  }
  return findings;
}

/** Repeated errors that also clearly exceed the previous day's rate. */
function errorIncrease({
  invocations,
  errors,
  baselineInvocations,
  baselineErrors,
  thresholds
}) {
  if (errors < thresholds.minErrors) return null;
  const baselineRate =
    baselineInvocations > 0 ? baselineErrors / baselineInvocations : 0;
  const rate = invocations > 0 ? errors / invocations : 1;
  if (baselineErrors > 0 && rate < thresholds.rateFactor * baselineRate) {
    return null;
  }
  return `${errors} Lambda errors in ${invocations} invocations since the new build went live; ${baselineErrors} in ${baselineInvocations} over the previous 24 h`;
}

/**
 * Judges one function after a deploy. Every signal starts when the new
 * build went live (the function's LastModified), and log signals come only
 * from log streams created after that, so traffic still served by the old
 * build cannot pass or fail the check.
 *
 * - unhealthy: the Lambda update failed; the new build logged a startup or
 *   database-login failure; or Lambda errors repeated (at least
 *   `thresholds.minErrors`) and, when the function already had errors the
 *   day before, reached `thresholds.rateFactor` times that rate.
 * - healthy: the new build handled at least one invocation and, for
 *   services that bundle the database modules, logged the expected
 *   `[AUTH <mode>]` login line.
 * - pending: anything else, including no invocation of the new build yet.
 */
function evaluateFunctionHealth({
  updateStatus = 'Successful',
  newInvocations,
  invocations,
  errors,
  baselineInvocations,
  baselineErrors,
  badLines,
  authLines,
  expectsDbAuth,
  expectedAuth = 'IAM',
  thresholds = DEFAULT_ERROR_THRESHOLDS
}) {
  if (updateStatus === 'Failed') {
    return {
      status: 'unhealthy',
      findings: ['the Lambda update failed'],
      note: null
    };
  }
  const findings = confirmedFailures({
    badLines,
    authLines,
    expectsDbAuth,
    expectedAuth
  });
  const increase = errorIncrease({
    invocations,
    errors,
    baselineInvocations,
    baselineErrors,
    thresholds
  });
  if (increase) findings.push(increase);
  if (findings.length > 0) return { status: 'unhealthy', findings, note: null };
  if (updateStatus === 'InProgress') {
    return { status: 'pending', findings, note: 'Lambda update in progress' };
  }
  const loggedIn = authModes(authLines).includes(expectedAuth);
  if (newInvocations > 0 && (!expectsDbAuth || loggedIn)) {
    return {
      status: 'healthy',
      findings,
      note: `${newInvocations} invocation(s) of the new build`
    };
  }
  return {
    status: 'pending',
    findings,
    note:
      newInvocations === 0
        ? 'new build not invoked yet'
        : `no [AUTH ${expectedAuth}] login line from the new build yet`
  };
}

/** Combines per-function verdicts: any unhealthy wins, then any pending. */
function combineVerdicts(verdicts) {
  const unhealthy = verdicts.filter(
    (verdict) => verdict.status === 'unhealthy'
  );
  if (unhealthy.length > 0) {
    return {
      status: 'unhealthy',
      findings: unhealthy.flatMap((verdict) =>
        verdict.findings.map((finding) => `${verdict.functionName}: ${finding}`)
      ),
      note: null
    };
  }
  const pending = verdicts.filter((verdict) => verdict.status === 'pending');
  if (pending.length > 0) {
    return {
      status: 'pending',
      findings: [],
      note: pending
        .map((verdict) => `${verdict.functionName}: ${verdict.note}`)
        .join('; ')
    };
  }
  return { status: 'healthy', findings: [], note: null };
}

function runProcess(command, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(systemExecutable(command), args, {
      env,
      windowsHide: true
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

/**
 * Runs AWS CLI calls as the deploy role through GitHub OIDC. The CLI assumes
 * the role itself from a web-identity token file, which is refreshed every
 * few minutes, so a train that outlives one role session keeps working.
 */
function createAwsCli({
  roleArn,
  sessionName,
  env = process.env,
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
  run = runProcess
}) {
  const tokenDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-train-oidc-'));
  const tokenFile = path.join(tokenDir, 'token');
  let refreshedAt = null;

  async function refreshToken() {
    if (refreshedAt !== null && now() - refreshedAt < TOKEN_REFRESH_MS) return;
    const url = env.ACTIONS_ID_TOKEN_REQUEST_URL;
    const requestToken = env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
    if (!url || !requestToken) {
      throw new Error(
        'GitHub OIDC is unavailable; the job needs id-token: write'
      );
    }
    const response = await fetchImpl(
      `${url}&audience=${encodeURIComponent('sts.amazonaws.com')}`,
      { headers: { authorization: `Bearer ${requestToken}` } }
    );
    if (!response.ok) {
      throw new Error(`GitHub OIDC token request failed: ${response.status}`);
    }
    const { value } = await response.json();
    fs.writeFileSync(tokenFile, value, { mode: 0o600 });
    refreshedAt = now();
  }

  async function json(args, { allowMissing = false } = {}) {
    await refreshToken();
    const childEnv = { ...env };
    for (const key of [
      'AWS_ACCESS_KEY_ID',
      'AWS_SECRET_ACCESS_KEY',
      'AWS_SESSION_TOKEN',
      'AWS_PROFILE'
    ]) {
      delete childEnv[key];
    }
    Object.assign(childEnv, {
      AWS_ROLE_ARN: roleArn,
      AWS_ROLE_SESSION_NAME: sessionName,
      AWS_WEB_IDENTITY_TOKEN_FILE: tokenFile,
      AWS_PAGER: ''
    });
    const result = await run('aws', [...args, '--output', 'json'], childEnv);
    if (result.code !== 0) {
      if (allowMissing && /ResourceNotFoundException/.test(result.stderr)) {
        return null;
      }
      throw new Error(
        `aws ${args.slice(0, 2).join(' ')} failed: ${result.stderr.trim().slice(0, 300)}`
      );
    }
    return result.stdout.trim() ? JSON.parse(result.stdout) : null;
  }

  function cleanup() {
    fs.rmSync(tokenDir, { recursive: true, force: true });
  }

  return { json, cleanup };
}

function isoTime(time) {
  return new Date(time).toISOString();
}

/** Lambda reports LastModified like 2026-11-23T08:10:31.000+0000. */
function parseLambdaTime(value) {
  if (typeof value !== 'string') return Number.NaN;
  return Date.parse(value.replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
}

/** CloudWatch and log reads behind a health check. */
function createHealthChecker({
  aws,
  environment,
  expectedAuth = 'IAM',
  thresholds = DEFAULT_ERROR_THRESHOLDS,
  now = () => Date.now()
}) {
  const baselines = new Map();

  async function metricSum(region, functionName, metric, start, end, period) {
    const result = await aws.json([
      'cloudwatch',
      'get-metric-statistics',
      '--region',
      region,
      '--namespace',
      'AWS/Lambda',
      '--metric-name',
      metric,
      '--dimensions',
      `Name=FunctionName,Value=${functionName}`,
      '--start-time',
      isoTime(start),
      '--end-time',
      isoTime(end),
      '--period',
      String(period),
      '--statistics',
      'Sum'
    ]);
    return (result?.Datapoints || []).reduce(
      (sum, point) => sum + (point.Sum || 0),
      0
    );
  }

  /** When the function's current code and configuration went live. */
  async function liveState(region, functionName) {
    const config = await aws.json([
      'lambda',
      'get-function-configuration',
      '--region',
      region,
      '--function-name',
      functionName
    ]);
    return {
      liveAt: parseLambdaTime(config?.LastModified),
      updateStatus: config?.LastUpdateStatus || 'Successful',
      codeSha256: config?.CodeSha256 || null
    };
  }

  /**
   * Log streams opened since `since`. After a code update Lambda serves new
   * invocations from new execution environments, each with its own stream,
   * so these streams hold only the new build's output.
   */
  async function newStreams(region, functionName, since) {
    const result = await aws.json(
      [
        'logs',
        'describe-log-streams',
        '--region',
        region,
        '--log-group-name',
        `/aws/lambda/${functionName}`,
        '--order-by',
        'LastEventTime',
        '--descending',
        '--max-items',
        '50'
      ],
      { allowMissing: true }
    );
    return (result?.logStreams || [])
      .filter((stream) => stream.creationTime >= since)
      .map((stream) => stream.logStreamName);
  }

  async function streamLines(region, functionName, streams, since, pattern) {
    if (streams.length === 0) return [];
    const result = await aws.json(
      [
        'logs',
        'filter-log-events',
        '--region',
        region,
        '--log-group-name',
        `/aws/lambda/${functionName}`,
        '--log-stream-names',
        ...streams,
        '--start-time',
        String(since),
        '--filter-pattern',
        pattern,
        '--max-items',
        '50'
      ],
      { allowMissing: true }
    );
    return (result?.events || []).map((event) => event.message || '');
  }

  async function baselineFor(region, functionName, since) {
    const key = `${functionName}@${since}`;
    if (!baselines.has(key)) {
      baselines.set(key, {
        invocations: await metricSum(
          region,
          functionName,
          'Invocations',
          since - DAY_MS,
          since,
          3600
        ),
        errors: await metricSum(
          region,
          functionName,
          'Errors',
          since - DAY_MS,
          since,
          3600
        )
      });
    }
    return baselines.get(key);
  }

  async function checkFunction(item, functionName, deployStartedAt) {
    const { region } = item;
    const live = await liveState(region, functionName);
    // The new build is live from its LastModified; an older LastModified
    // means this deploy left the function's code and configuration alone.
    const unchanged = !(live.liveAt >= deployStartedAt);
    const since = unchanged ? deployStartedAt : live.liveAt;
    const end = now();
    const baseline = await baselineFor(region, functionName, since);
    const streams = await newStreams(region, functionName, since);
    const lines = (pattern) =>
      streamLines(region, functionName, streams, since, pattern);
    // Start at the minute the new build went live: errors right after
    // go-live must count. That minute's bucket can also hold old-build
    // errors from its first seconds, which errs towards halting.
    const metricsFrom = Math.floor(since / MINUTE_MS) * MINUTE_MS;
    const metric = (name) =>
      metricsFrom < end
        ? metricSum(region, functionName, name, metricsFrom, end, 60)
        : 0;
    // Each auth mode is queried on its own, so a wrong-mode login is found
    // however many expected-mode logins came before it.
    const authLines = [];
    if (item.expects_db_auth) {
      for (const mode of AUTH_MODES) {
        authLines.push(...(await lines(authLogPattern(mode))));
      }
    }
    const verdict = evaluateFunctionHealth({
      updateStatus: live.updateStatus,
      newInvocations: (await lines(INVOCATION_LOG_PATTERN)).length,
      invocations: await metric('Invocations'),
      errors: await metric('Errors'),
      baselineInvocations: baseline.invocations,
      baselineErrors: baseline.errors,
      badLines: await lines(BAD_LOG_PATTERN),
      authLines,
      expectsDbAuth: item.expects_db_auth,
      expectedAuth,
      thresholds
    });
    const note =
      unchanged && verdict.status === 'pending'
        ? `${verdict.note}; this deploy did not change the function`
        : verdict.note;
    return {
      ...verdict,
      note,
      functionName,
      live_since: isoTime(since),
      code_sha256: live.codeSha256
    };
  }

  return {
    async check(item, deployStartedAt) {
      if (
        UNCHECKED_PROFILES.has(item.validation_profile) ||
        item.verification_targets.length === 0
      ) {
        return {
          status: 'skipped',
          findings: [],
          note: 'checked by the deploy workflow only'
        };
      }
      const verdicts = [];
      for (const functionName of item.verification_targets) {
        verdicts.push(await checkFunction(item, functionName, deployStartedAt));
      }
      return combineVerdicts(verdicts);
    },
    environment
  };
}

module.exports = {
  BAD_LOG_PATTERN,
  authLogPattern,
  INVOCATION_LOG_PATTERN,
  DEFAULT_ERROR_THRESHOLDS,
  evaluateFunctionHealth,
  combineVerdicts,
  parseLambdaTime,
  createAwsCli,
  createHealthChecker
};
