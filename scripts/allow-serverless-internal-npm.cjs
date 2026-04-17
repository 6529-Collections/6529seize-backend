#!/usr/bin/env node

const path = require('node:path');

function includesServerlessReleasePath(input) {
  if (!input) {
    return false;
  }
  return path
    .normalize(input)
    .includes(`${path.sep}.serverless${path.sep}releases${path.sep}`);
}

function isServerlessInternalNpmAllowed(
  env = process.env,
  cwd = process.cwd()
) {
  if (env['SEIZE_ALLOW_SERVERLESS_INTERNAL_NPM'] === '1') {
    return true;
  }

  if (includesServerlessReleasePath(cwd)) {
    return true;
  }

  if (includesServerlessReleasePath(env['npm_execpath'] ?? '')) {
    return true;
  }

  const npmUserAgent = env['npm_config_user_agent'] ?? '';
  const npmExecPath = env['npm_execpath'] ?? '';
  const execBaseName = path.basename(npmExecPath).toLowerCase();
  const isNpmContext =
    npmUserAgent.includes('npm/') ||
    execBaseName === 'npm' ||
    execBaseName === 'npm-cli.js' ||
    npmExecPath.includes('/npm-cli.js') ||
    npmExecPath.includes(String.raw`\npm-cli.js`);
  const lifecycleEvent = env['npm_lifecycle_event'] ?? '';
  const lifecycleScript = env['npm_lifecycle_script'] ?? '';
  if (
    lifecycleEvent.startsWith('sls-deploy:') ||
    lifecycleScript.includes('serverless/run.js deploy')
  ) {
    return true;
  }

  if (
    isNpmContext &&
    (env['GITHUB_ACTIONS'] === 'true' || env['CI'] === 'true') &&
    (env['npm_command'] ?? '') === 'install'
  ) {
    return true;
  }

  const npmAudit = env['npm_config_audit'] ?? '';
  const npmFund = env['npm_config_fund'] ?? '';
  const npmProgress = env['npm_config_progress'] ?? '';
  const hasServerlessInstallFlags =
    (npmAudit === 'false' || npmAudit === '0') &&
    (npmFund === 'false' || npmFund === '0') &&
    (npmProgress === 'false' || npmProgress === '0');
  if (
    hasServerlessInstallFlags &&
    (isNpmContext || env['GITHUB_ACTIONS'] === 'true' || env['CI'] === 'true')
  ) {
    return true;
  }

  return false;
}

module.exports = {
  isServerlessInternalNpmAllowed
};
