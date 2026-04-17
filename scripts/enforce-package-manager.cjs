#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");

function allowedOutside6529Wrapper() {
  if (process.env["SEIZE_ALLOW_SERVERLESS_INTERNAL_NPM"] === "1") {
    return true;
  }
  if (
    process.env["GITHUB_ACTIONS"] === "true" &&
    process.env["npm_command"] === "install"
  ) {
    return true;
  }
  return false;
}

if (allowedOutside6529Wrapper()) {
  process.exit(0);
}

const packageJsonPath = path.join(process.cwd(), "package.json");
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
const userAgent = process.env["npm_config_user_agent"] ?? "";
const secureInstall = process.env["SEIZE_SECURE_INSTALL"] === "1";

if (!userAgent.includes("pnpm/")) {
  const isNpm = userAgent.includes("npm/");
  const isYarn = userAgent.includes("yarn/");

  if (isNpm) {
    console.error("Direct npm usage is blocked in this repository.");
  } else if (isYarn) {
    console.error("Direct yarn usage is blocked in this repository.");
  } else {
    console.error("Direct package-manager installs are blocked in this repository.");
  }

  console.error("Use the `6529` wrapper instead.");
  console.error("Examples:");
  console.error("  6529 install");
  console.error("  6529 run build");
  console.error("  6529 run lint");
  process.exit(1);
}

if (!secureInstall) {
  console.error("Direct pnpm installs are blocked in this repository.");
  console.error("Use the `6529` wrapper instead.");
  console.error("Examples:");
  console.error("  6529 install");
  console.error("  6529 install:frozen");
  console.error("  6529 install:prod");
  process.exit(1);
}
