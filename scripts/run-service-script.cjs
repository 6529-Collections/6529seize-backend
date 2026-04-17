#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

require("./require-6529-command.cjs");

const repoRoot = path.resolve(__dirname, "..");
const rawArgs = process.argv.slice(2);

while (rawArgs[1] === "--") {
  rawArgs.splice(1, 1);
}

const [mode, service, environment] = rawArgs;

if (!mode || !service) {
  console.error("Usage:");
  console.error("  node scripts/run-service-script.cjs build <service>");
  console.error("  node scripts/run-service-script.cjs deploy <service> <environment>");
  process.exit(1);
}

const relativeDir = service === "api" ? "src/api-serverless" : path.join("src", service);
const packageJsonPath = path.join(repoRoot, relativeDir, "package.json");

if (!fs.existsSync(packageJsonPath)) {
  console.error(`Unknown service package: ${service}`);
  process.exit(1);
}

let args;

if (mode === "build") {
  args = ["--dir", repoRoot, "--filter", `./${relativeDir}`, "run", "build"];
} else if (mode === "deploy") {
  if (!environment) {
    console.error("Usage: node scripts/run-service-script.cjs deploy <service> <environment>");
    process.exit(1);
  }

  if (service === "api") {
    console.error("API deployment is handled separately from workspace serverless deploy scripts.");
    process.exit(1);
  }

  if (service === "mediaResizerLoop" || service === "nextgenMediaProxyInterceptor") {
    console.error(`${service} deployment is handled by a custom workflow step.`);
    process.exit(1);
  }

  args = [
    "--dir",
    repoRoot,
    "--filter",
    `./${relativeDir}`,
    "run",
    `sls-deploy:${environment}`,
  ];
} else {
  console.error(`Unsupported mode: ${mode}`);
  process.exit(1);
}

const result = spawnSync(path.join(repoRoot, "bin", "pnpm"), args, {
  stdio: "inherit",
  env: {
    ...process.env,
    PATH: `${path.join(repoRoot, "bin")}${path.delimiter}${process.env["PATH"] ?? ""}`,
  },
});

if (result.error) {
  throw result.error;
}

process.exit(result.status ?? 1);
