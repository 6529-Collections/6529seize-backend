#!/usr/bin/env node

const path = require("node:path");

function allowedOutside6529Wrapper() {
  if (process.env["SEIZE_ALLOW_SERVERLESS_INTERNAL_NPM"] === "1") {
    return true;
  }
  const cwd = path.normalize(process.cwd());
  if (cwd.includes(`${path.sep}.serverless${path.sep}releases${path.sep}`)) {
    return true;
  }

  const npmCommand = process.env["npm_command"] ?? "";
  const npmAudit = process.env["npm_config_audit"] ?? "";
  const npmFund = process.env["npm_config_fund"] ?? "";
  const npmProgress = process.env["npm_config_progress"] ?? "";
  if (
    npmCommand === "install" &&
    (npmAudit === "false" || npmAudit === "0") &&
    (npmFund === "false" || npmFund === "0") &&
    (npmProgress === "false" || npmProgress === "0")
  ) {
    return true;
  }

  return false;
}

if (allowedOutside6529Wrapper()) {
  process.exit(0);
}

const userAgent = process.env["npm_config_user_agent"] ?? "";
const npmExecPath = process.env["npm_execpath"] ?? "";
const execBaseName = path.basename(npmExecPath).toLowerCase();

function detectPackageManager() {
  if (userAgent.includes("pnpm/") || npmExecPath.includes("pnpm")) {
    return "pnpm";
  }

  if (userAgent.includes("yarn/") || execBaseName.includes("yarn")) {
    return "yarn";
  }

  if (
    userAgent.includes("npm/") ||
    execBaseName === "npm" ||
    execBaseName === "npm-cli.js" ||
    npmExecPath.includes("/npm-cli.js") ||
    npmExecPath.includes(String.raw`\npm-cli.js`)
  ) {
    return "npm";
  }

  return null;
}

const packageManager = detectPackageManager();

if (process.env["SEIZE_6529_COMMAND"] !== "1") {
  if (packageManager === "npm") {
    console.error("Direct npm usage is blocked in this repository.");
    console.error("Use the `6529` wrapper instead.");
    console.error("Examples:");
    console.error("  6529 install");
    console.error("  6529 run backend:local");
    console.error("  6529 run build");
  } else if (packageManager === "pnpm") {
    console.error("Direct pnpm usage is blocked in this repository.");
    console.error("Use the `6529` wrapper instead.");
    console.error("Examples:");
    console.error("  6529 install");
    console.error("  6529 run backend:local");
    console.error("  6529 run build");
  } else if (packageManager === "yarn") {
    console.error("Direct yarn usage is blocked in this repository.");
    console.error("Use the `6529` wrapper instead.");
    console.error("Examples:");
    console.error("  6529 install");
    console.error("  6529 run backend:local");
    console.error("  6529 run build");
  } else {
    console.error("This repository only allows repo commands through the `6529` wrapper.");
    console.error("Use the wrapper command instead.");
    console.error("Examples:");
    console.error("  6529 install");
    console.error("  6529 run backend:local");
    console.error("  6529 run build");
  }
  process.exit(1);
}
