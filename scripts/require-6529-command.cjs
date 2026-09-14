#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

function getRequestedScript(lifecycleEvent) {
  if (!lifecycleEvent) {
    return undefined;
  }
  const baseScript = lifecycleEvent.replace(/^(?:pre|post)/, '');
  if (baseScript === lifecycleEvent) {
    return lifecycleEvent;
  }
  try {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8')
    );
    return manifest.scripts?.[baseScript] ? baseScript : lifecycleEvent;
  } catch {
    return lifecycleEvent;
  }
}

if (process.env.SEIZE_6529_COMMAND !== '1') {
  const packageCommand = process.env.npm_command ?? 'install';
  const lifecycleEvent = process.env.npm_lifecycle_event;
  console.error(
    'This repository only allows project commands through the `6529` wrapper.'
  );
  if (packageCommand === 'ci') {
    console.error('Use `6529 ci` from the package directory.');
  } else if (
    lifecycleEvent &&
    lifecycleEvent !== 'preinstall' &&
    lifecycleEvent !== 'install' &&
    lifecycleEvent !== 'postinstall'
  ) {
    console.error(
      `Use \`6529 run ${getRequestedScript(
        lifecycleEvent
      )}\` from the package directory.`
    );
  } else {
    console.error('Use `6529 ci` for a frozen install.');
    console.error(
      'Use `6529 add <package>` to change dependencies intentionally.'
    );
  }
  console.error(
    'If `6529` is unavailable, run `./bin/6529 bootstrap` from the repository root.'
  );
  process.exit(1);
}
