#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

require("./require-6529-command.cjs");

const repoRoot = path.resolve(__dirname, "..");
const cwd = process.cwd();
const targetArg = process.argv[2];

if (!targetArg) {
  console.error("Usage: node scripts/prepare-workspace-package.cjs <target-dir> [--prod]");
  process.exit(1);
}

const packageJsonPath = path.join(cwd, "package.json");
if (!fs.existsSync(packageJsonPath)) {
  console.error("prepare-workspace-package.cjs must run from a workspace package directory.");
  process.exit(1);
}

const relativePackageDir = path.relative(repoRoot, cwd);
if (relativePackageDir.startsWith("..") || path.isAbsolute(relativePackageDir)) {
  console.error("Workspace package directory must be inside the repository root.");
  process.exit(1);
}

const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
if (!packageJson.name) {
  console.error("Workspace package is missing a name in package.json.");
  process.exit(1);
}

const targetDir = path.resolve(cwd, targetArg);
fs.rmSync(targetDir, { recursive: true, force: true });

const extraArgs = process.argv.slice(3);
const result = spawnSync(
  path.join(repoRoot, "bin", "pnpm"),
  [
    "--dir",
    repoRoot,
    "deploy",
    "--legacy",
    "--offline",
    "--filter",
    packageJson.name,
    targetDir,
    ...extraArgs,
  ],
  {
    stdio: "inherit",
    env: {
      ...process.env,
      PATH: `${path.join(repoRoot, "bin")}${path.delimiter}${process.env["PATH"] ?? ""}`,
      SEIZE_SECURE_INSTALL: "1",
    },
  }
);

if (result.error) {
  throw result.error;
}

process.exit(result.status ?? 1);
