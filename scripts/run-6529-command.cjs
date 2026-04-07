#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const rawArgs = process.argv.slice(2);
const suggestOnly = rawArgs[0] === "--suggest-only";
const [repoRoot, realPnpm, scriptName, ...args] = suggestOnly
  ? rawArgs.slice(1)
  : rawArgs;

if (!repoRoot || !realPnpm || !scriptName) {
  console.error(
    "Usage: node scripts/run-6529-command.cjs <repo-root> <pnpm-bin> <script> [args...]"
  );
  process.exit(1);
}

const packageJsonPath = path.join(repoRoot, "package.json");
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
const scripts = Object.keys(packageJson.scripts ?? {});

function levenshtein(a, b) {
  const dp = Array.from({ length: a.length + 1 }, () =>
    new Array(b.length + 1).fill(0)
  );

  for (let i = 0; i <= a.length; i += 1) {
    dp[i][0] = i;
  }
  for (let j = 0; j <= b.length; j += 1) {
    dp[0][j] = j;
  }

  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      const substitutionCost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + substitutionCost
      );
    }
  }

  return dp[a.length][b.length];
}

function findSuggestion(input, candidates) {
  let bestCandidate = null;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const candidate of candidates) {
    const distance = levenshtein(input, candidate);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestCandidate = candidate;
    }
  }

  if (!bestCandidate) {
    return null;
  }

const maxAcceptedDistance = Math.max(2, Math.floor(bestCandidate.length / 3));
  return bestDistance <= maxAcceptedDistance ? bestCandidate : null;
}

if (scripts.includes(scriptName)) {
  if (suggestOnly) {
    process.stdout.write(`6529 run ${scriptName}`);
    process.exit(0);
  }
} else {
  const suggestion = findSuggestion(scriptName, scripts);
  if (suggestOnly) {
    if (suggestion) {
      process.stdout.write(`6529 run ${suggestion}`);
      process.exit(0);
    }
    process.exit(1);
  }

  console.error(`Unknown 6529 script: ${scriptName}`);
  if (suggestion) {
    console.error(`Did you mean \`6529 run ${suggestion}\`?`);
  } else {
    console.error("Use `6529 run <script>` for repo scripts.");
    console.error("Examples:");
    console.error("  6529 install");
    console.error("  6529 run backend:local");
    console.error("  6529 run build");
  }

  process.exit(1);
}

const pnpmArgs = ["run", scriptName];
if (args.length > 0) {
  pnpmArgs.push("--", ...args);
}

const result = spawnSync(realPnpm, pnpmArgs, {
  stdio: "inherit",
  env: process.env
});

if (result.error) {
  throw result.error;
}

process.exit(result.status ?? 1);
