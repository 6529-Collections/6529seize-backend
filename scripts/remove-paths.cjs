#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

for (const target of process.argv.slice(2)) {
  fs.rmSync(path.resolve(process.cwd(), target), {
    force: true,
    maxRetries: 3,
    recursive: true
  });
}
