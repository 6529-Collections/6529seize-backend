'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { systemExecutable } = require('./git');

const DAY_MS = 24 * 60 * 60 * 1000;
const BAD_LOG_PATTERN =
  '?"Access denied" ?ER_ACCESS_DENIED ?"Cannot find module" ?ImportModuleError';
const AUTH_LOG_PATTERN = '?"AUTH IAM" ?"AUTH PASSWORD"';
const TOKEN_REFRESH_MS = 4 * 60 * 1000;
const UNCHECKED_PROFILES = new Set([
  'cloudformation-stack',
  'lambda-edge-association'
]);

/**
 * Judges one function after a deploy from its CloudWatch numbers and log
 * lines. Unhealthy: an access-denied or module-loading log line, a database
 * login with the wrong auth mode, or new Lambda errors (any error when the
 * previous 24 hours had none, otherwise more than double the earlier rate).
 * Healthy: invoked at least once and, for database users, the expected
 * `[AUTH <mode>]` login line was logged. Anything else is still pending.
 */
function evaluateFunctionHealth({
  invocations,
  errors,
  baselineInvocations,
  baselineErrors,
  badLines,
  authLines,
  expectsDbAuth,
  expectedAuth = 'IAM'
}) {
  const findings = [];
  if (badLines.length > 0) {
    findings.push(`logged "${badLines[0].trim().slice(0, 160)}"`);
  }
  const modes = authLines
    .map((line) => /AUTH (IAM|PASSWORD)/.exec(line))
    .filter(Boolean)
    .map((match) => match[1]);
  const wrongMode = modes.find((mode) => mode !== expectedAuth);
  if (expectsDbAuth && wrongMode) {
    findings.push(
      `database login used [AUTH ${wrongMode}], expected [AUTH ${expectedAuth}]`
    );
  }
  const baselineRate =
    baselineInvocations > 0 ? baselineErrors / baselineInvocations : 0;
  const rate = invocations > 0 ? errors / invocations : 0;
  if (
    errors > 0 &&
    (baselineErrors === 0 || (errors >= 2 && rate > 2 * baselineRate))
  ) {
    findings.push(
      `${errors} Lambda error(s) in ${invocations} invocation(s) since deploy; ${baselineErrors} in ${baselineInvocations} over the previous 24 h`
    );
  }
  if (findings.length > 0) return { status: 'unhealthy', findings, note: null };
  if (invocations > 0 && (!expectsDbAuth || modes.includes(expectedAuth))) {
    return {
      status: 'healthy',
      findings,
      note: `${invocations} invocation(s)`
    };
  }
  return {
    status: 'pending',
    findings,
    note:
      invocations === 0
        ? 'not invoked since deploy'
        : `no [AUTH ${expectedAuth}] login line yet`
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

/** CloudWatch and log reads behind a health check. */
function createHealthChecker({
  aws,
  environment,
  expectedAuth = 'IAM',
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

  async function logLines(region, functionName, start, end, pattern) {
    const result = await aws.json(
      [
        'logs',
        'filter-log-events',
        '--region',
        region,
        '--log-group-name',
        `/aws/lambda/${functionName}`,
        '--start-time',
        String(start),
        '--end-time',
        String(end),
        '--filter-pattern',
        pattern,
        '--max-items',
        '20'
      ],
      { allowMissing: true }
    );
    return (result?.events || []).map((event) => event.message || '');
  }

  async function checkFunction(item, functionName, deployStartedAt) {
    const end = now();
    const key = `${functionName}@${deployStartedAt}`;
    if (!baselines.has(key)) {
      baselines.set(key, {
        invocations: await metricSum(
          item.region,
          functionName,
          'Invocations',
          deployStartedAt - DAY_MS,
          deployStartedAt,
          3600
        ),
        errors: await metricSum(
          item.region,
          functionName,
          'Errors',
          deployStartedAt - DAY_MS,
          deployStartedAt,
          3600
        )
      });
    }
    const baseline = baselines.get(key);
    const verdict = evaluateFunctionHealth({
      invocations: await metricSum(
        item.region,
        functionName,
        'Invocations',
        deployStartedAt,
        end,
        60
      ),
      errors: await metricSum(
        item.region,
        functionName,
        'Errors',
        deployStartedAt,
        end,
        60
      ),
      baselineInvocations: baseline.invocations,
      baselineErrors: baseline.errors,
      badLines: await logLines(
        item.region,
        functionName,
        deployStartedAt,
        end,
        BAD_LOG_PATTERN
      ),
      authLines: item.expects_db_auth
        ? await logLines(
            item.region,
            functionName,
            deployStartedAt,
            end,
            AUTH_LOG_PATTERN
          )
        : [],
      expectsDbAuth: item.expects_db_auth,
      expectedAuth
    });
    return { ...verdict, functionName };
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
  AUTH_LOG_PATTERN,
  evaluateFunctionHealth,
  combineVerdicts,
  createAwsCli,
  createHealthChecker
};
