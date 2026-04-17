#!/usr/bin/env node

const path = require('node:path');
const {
  isServerlessInternalNpmAllowed
} = require('./allow-serverless-internal-npm.cjs');

if (isServerlessInternalNpmAllowed()) {
  if (require.main === module) {
    process.exit(0);
  }
} else {
  const userAgent = process.env['npm_config_user_agent'] ?? '';
  const npmExecPath = process.env['npm_execpath'] ?? '';
  const execBaseName = path.basename(npmExecPath).toLowerCase();

  function detectPackageManager() {
    if (userAgent.includes('pnpm/') || npmExecPath.includes('pnpm')) {
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
    if (packageManager === 'npm') {
      console.error('Direct npm usage is blocked in this repository.');
      console.error('Use the `6529` wrapper instead.');
      console.error('Examples:');
      console.error('  6529 install');
      console.error('  6529 run backend:local');
      console.error('  6529 run build');
    } else if (packageManager === 'pnpm') {
      console.error('Direct pnpm usage is blocked in this repository.');
      console.error('Use the `6529` wrapper instead.');
      console.error('Examples:');
      console.error('  6529 install');
      console.error('  6529 run backend:local');
      console.error('  6529 run build');
    } else if (packageManager === 'yarn') {
      console.error('Direct yarn usage is blocked in this repository.');
      console.error('Use the `6529` wrapper instead.');
      console.error('Examples:');
      console.error('  6529 install');
      console.error('  6529 run backend:local');
      console.error('  6529 run build');
    } else {
      console.error(
        'This repository only allows repo commands through the `6529` wrapper.'
      );
      console.error('Use the wrapper command instead.');
      console.error('Examples:');
      console.error('  6529 install');
      console.error('  6529 run backend:local');
      console.error('  6529 run build');
    }
    process.exit(1);
  }
}
