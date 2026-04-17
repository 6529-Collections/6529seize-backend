#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

require('./require-6529-command.cjs');

const repoRoot = path.resolve(__dirname, '..');
const deployConfigPath = path.join(
  repoRoot,
  'src',
  'config',
  'deploy-services.json'
);

const deployConfig = JSON.parse(fs.readFileSync(deployConfigPath, 'utf8'));
const services = deployConfig.services.map((service) => service.name);
const totalServices = services.length;
const startedAt = Date.now();

function formatDuration(durationMs) {
  const totalSeconds = Math.floor(durationMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  if (minutes === 0) {
    return `${seconds}s`;
  }

  return `${minutes}m ${seconds}s`;
}

for (const [index, service] of services.entries()) {
  const serviceStartedAt = Date.now();
  console.log(`\n==> [${index + 1}/${totalServices}] Building ${service}`);

  const result = spawnSync(
    process.execPath,
    [path.join(repoRoot, 'scripts', 'run-service-script.cjs'), 'build', service],
    {
      stdio: 'inherit',
      env: {
        ...process.env,
        PATH: `${path.join(repoRoot, 'bin')}${path.delimiter}${process.env['PATH'] ?? ''}`
      }
    }
  );

  if (result.error) {
    throw result.error;
  }

  if ((result.status ?? 1) !== 0) {
    const elapsed = formatDuration(Date.now() - startedAt);
    const serviceElapsed = formatDuration(Date.now() - serviceStartedAt);
    console.error(
      `\nBuild failed on ${service} after ${index}/${totalServices} completed services.`
    );
    console.error(`Failed service time: ${serviceElapsed}`);
    console.error(`Total elapsed time: ${elapsed}`);
    process.exit(result.status ?? 1);
  }

  const serviceElapsed = formatDuration(Date.now() - serviceStartedAt);
  console.log(`==> Completed ${service} in ${serviceElapsed}`);
}

const elapsed = formatDuration(Date.now() - startedAt);
console.log(`\nBuilt ${totalServices}/${totalServices} services in ${elapsed}.`);
