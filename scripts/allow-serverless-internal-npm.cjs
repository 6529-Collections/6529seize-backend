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

  if ((env['npm_command'] ?? '') === 'install') {
    if (env['GITHUB_ACTIONS'] === 'true') {
      return true;
    }

    const npmAudit = env['npm_config_audit'] ?? '';
    const npmFund = env['npm_config_fund'] ?? '';
    const npmProgress = env['npm_config_progress'] ?? '';
    if (
      (npmAudit === 'false' || npmAudit === '0') &&
      (npmFund === 'false' || npmFund === '0') &&
      (npmProgress === 'false' || npmProgress === '0')
    ) {
      return true;
    }
  }

  return false;
}

module.exports = {
  isServerlessInternalNpmAllowed
};
