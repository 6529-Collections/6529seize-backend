#!/usr/bin/env node

const path = require('node:path');

const userAgent = process.env['npm_config_user_agent'] ?? '';
const npmExecPath = process.env['npm_execpath'] ?? '';
const execBaseName = path.basename(npmExecPath).toLowerCase();

function detectPackageManager() {
  if (userAgent.includes('pnpm/') || execBaseName.includes('pnpm')) {
    return 'pnpm';
  }

  if (userAgent.includes('yarn/') || execBaseName.includes('yarn')) {
    return 'yarn';
  }

  if (
    userAgent.includes('npm/') ||
    execBaseName === 'npm' ||
    execBaseName === 'npm-cli.js' ||
    npmExecPath.includes('/npm-cli.js') ||
    npmExecPath.includes(String.raw`\npm-cli.js`)
  ) {
    return 'npm';
  }

  return null;
}

const packageManager = detectPackageManager();

if (process.env['SEIZE_6529_COMMAND'] !== '1') {
  let leadingMessage =
    'This repository only allows repo commands through the `6529` wrapper.';

  if (packageManager === 'npm') {
    leadingMessage = 'Direct npm usage is blocked in this repository.';
  } else if (packageManager === 'pnpm') {
    leadingMessage = 'Direct pnpm usage is blocked in this repository.';
  } else if (packageManager === 'yarn') {
    leadingMessage = 'Direct yarn usage is blocked in this repository.';
  }

  console.error(leadingMessage);
  console.error('Use the `6529` wrapper instead.');
  console.error('Examples:');
  console.error('  6529 install');
  console.error('  6529 run backend:local');
  console.error('  6529 run build');
  process.exit(1);
}
