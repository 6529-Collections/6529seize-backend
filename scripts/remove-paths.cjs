#!/usr/bin/env node

const path = require("node:path");
const rimraf = require("rimraf");

for (const target of process.argv.slice(2)) {
  rimraf.sync(path.resolve(process.cwd(), target), {
    disableGlob: true,
  });
}
