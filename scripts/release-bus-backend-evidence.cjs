#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports, no-undef */

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');

const WORKFLOW = '.github/workflows/release-bus-preflight.yml';
const TOOL = 'scripts/release-bus-backend-evidence.cjs';
const CONTRACT_FILES = [
  'package.json',
  'package-lock.json',
  'jest.config.ts',
  'tsconfig.json',
  'src/config/deploy-services.json'
];

function parseArgs(values) {
  const args = {};
  for (let index = 0; index < values.length; index += 2) {
    if (!values[index]?.startsWith('--') || values[index + 1] === undefined) {
      throw new Error('Arguments must be --key value pairs');
    }
    args[values[index].slice(2)] = values[index + 1];
  }
  return args;
}

function required(args, name) {
  const value = args[name];
  if (!value) throw new Error(`Missing --${name}`);
  return value;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function git(repo, args) {
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024
  }).trimEnd();
}

function fingerprint(args) {
  const repo = path.resolve(required(args, 'repo-root'));
  const sourceSha = required(args, 'source-sha');
  const workflowSha = required(args, 'workflow-sha');
  if (
    !/^[a-f0-9]{40}$/.test(sourceSha) ||
    !/^[a-f0-9]{40}$/.test(workflowSha)
  ) {
    throw new Error('Invalid source or workflow SHA');
  }
  if (git(repo, ['rev-parse', 'HEAD']) !== sourceSha) {
    throw new Error('Checkout does not match the exact composed SHA');
  }
  const packageManager = readJson(
    path.join(repo, 'package.json')
  ).packageManager;
  if (!/^npm@[A-Za-z0-9.+-]{1,122}$/.test(String(packageManager ?? ''))) {
    throw new Error('Invalid package-manager contract');
  }
  const componentDigests = Object.fromEntries([
    ...CONTRACT_FILES.map((file) => [
      file,
      sha256(fs.readFileSync(path.join(repo, file), 'utf8'))
    ]),
    ...[WORKFLOW, TOOL].map((file) => [
      file,
      sha256(git(repo, ['show', `${workflowSha}:${file}`]))
    ])
  ]);
  const sourceTree = git(repo, ['rev-parse', `${sourceSha}^{tree}`]);
  const behavior = {
    schema_version: 1,
    kind: 'release_bus_backend_preflight_contract',
    node_version: '22',
    package_manager: packageManager,
    jest_max_workers: 2,
    test_inventory_policy: 'exact_files_and_test_results_zero_skipped',
    package_policy: 'one_build_per_selected_unit',
    component_digests: componentDigests
  };
  const behaviorDigest = sha256(JSON.stringify(behavior));
  return {
    ...behavior,
    source_sha: sourceSha,
    source_tree: sourceTree,
    workflow_sha: workflowSha,
    workflow_digest: componentDigests[WORKFLOW],
    behavior_digest: behaviorDigest,
    gate_fingerprint: sha256(
      JSON.stringify({
        source_sha: sourceSha,
        source_tree: sourceTree,
        workflow_sha: workflowSha,
        behavior_digest: behaviorDigest
      })
    )
  };
}

function relativeFiles(values, repo) {
  return values.map((value) => {
    const relative = path.relative(repo, value).split(path.sep).join('/');
    if (!relative || relative.startsWith('../')) {
      throw new Error('Jest reported a test outside the repository');
    }
    return relative;
  });
}

function duplicateValues(values) {
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts]
    .filter(([, count]) => count > 1)
    .map(([value]) => value)
    .sort();
}

function verifyTests(args) {
  const repo = path.resolve(required(args, 'repo-root'));
  const contract = readJson(required(args, 'contract'));
  const inventory = readJson(required(args, 'inventory'));
  const result = readJson(required(args, 'results'));
  if (!Array.isArray(inventory) || inventory.length === 0) {
    throw new Error('Jest inventory is empty');
  }
  const expected = relativeFiles(inventory, repo).sort();
  const executed = relativeFiles(
    (result.testResults ?? []).map((suite) => suite.name),
    repo
  ).sort();
  const expectedSet = new Set(expected);
  const executedSet = new Set(executed);
  const missing = expected.filter((file) => !executedSet.has(file));
  const unexpected = executed.filter((file) => !expectedSet.has(file));
  const duplicateInventory = duplicateValues(expected);
  const duplicate = duplicateValues(executed);
  const testIdentityDigests = [];
  let malformedTestResults = 0;
  for (const suite of result.testResults ?? []) {
    if (!Array.isArray(suite.assertionResults)) {
      malformedTestResults += 1;
      continue;
    }
    const suiteFile = relativeFiles([suite.name], repo)[0];
    for (const assertion of suite.assertionResults) {
      if (
        !assertion ||
        typeof assertion.fullName !== 'string' ||
        assertion.fullName.length === 0 ||
        typeof assertion.status !== 'string'
      ) {
        malformedTestResults += 1;
        continue;
      }
      testIdentityDigests.push(sha256(`${suiteFile}\0${assertion.fullName}`));
    }
  }
  const duplicateTestIdentities = duplicateValues(testIdentityDigests);
  const skippedTests =
    Number(result.numPendingTests ?? 0) + Number(result.numTodoTests ?? 0);
  const skippedSuites = Number(result.numPendingTestSuites ?? 0);
  const failedTests = Number(result.numFailedTests ?? 0);
  const failedSuites = Number(result.numFailedTestSuites ?? 0);
  const totalTests = Number(result.numTotalTests ?? 0);
  const succeeded =
    result.success === true &&
    missing.length === 0 &&
    unexpected.length === 0 &&
    duplicateInventory.length === 0 &&
    duplicate.length === 0 &&
    duplicateTestIdentities.length === 0 &&
    malformedTestResults === 0 &&
    totalTests > 0 &&
    testIdentityDigests.length === totalTests &&
    skippedTests === 0 &&
    skippedSuites === 0 &&
    failedTests === 0 &&
    failedSuites === 0;
  const evidence = {
    schema_version: 1,
    kind: 'release_bus_backend_test_evidence',
    source_sha: contract.source_sha,
    source_tree: contract.source_tree,
    gate_fingerprint: contract.gate_fingerprint,
    behavior_digest: contract.behavior_digest,
    execution: 'executed',
    jest_max_workers: 2,
    expected_files: expected.length,
    executed_files: executed.length,
    missing_files: missing,
    unexpected_files: unexpected,
    duplicate_inventory_files: duplicateInventory,
    duplicate_files: duplicate,
    duplicate_test_identities: duplicateTestIdentities,
    malformed_test_results: malformedTestResults,
    executed_test_results: testIdentityDigests.length,
    failed_tests: failedTests,
    failed_test_suites: failedSuites,
    skipped_tests: skippedTests,
    skipped_test_suites: skippedSuites,
    total_tests: totalTests,
    total_test_suites: Number(result.numTotalTestSuites ?? 0),
    status: succeeded ? 'SUCCEEDED' : 'FAILED'
  };
  writeJson(required(args, 'output'), evidence);
  if (!succeeded) process.exitCode = 1;
}

function aggregate(args) {
  const contract = readJson(required(args, 'contract'));
  const tests = readJson(required(args, 'test-evidence'));
  const units = readJson(required(args, 'units'));
  const packagesRoot = path.resolve(required(args, 'packages-root'));
  if (
    !Array.isArray(units) ||
    units.length === 0 ||
    new Set(units).size !== units.length
  ) {
    throw new Error('Selected deploy units are invalid');
  }
  if (
    tests.status !== 'SUCCEEDED' ||
    tests.source_sha !== contract.source_sha ||
    tests.source_tree !== contract.source_tree ||
    tests.gate_fingerprint !== contract.gate_fingerprint ||
    tests.behavior_digest !== contract.behavior_digest
  ) {
    throw new Error(
      'Test evidence does not match the exact composed tree contract'
    );
  }
  const packageDigests = {};
  for (const unit of units) {
    const evidenceFile = path.join(packagesRoot, 'evidence', `${unit}.json`);
    const packageFile = path.join(packagesRoot, 'packages', unit, 'index.zip');
    const evidence = readJson(evidenceFile);
    const actualDigest = sha256(fs.readFileSync(packageFile));
    if (
      evidence.kind !== 'release_bus_backend_package_evidence' ||
      evidence.unit !== unit ||
      evidence.source_sha !== contract.source_sha ||
      evidence.source_tree !== contract.source_tree ||
      evidence.build_count !== 1 ||
      evidence.package_digest !== actualDigest
    ) {
      throw new Error(`Package evidence for ${unit} is invalid`);
    }
    packageDigests[unit] = actualDigest;
  }
  const evidenceFiles = fs
    .readdirSync(path.join(packagesRoot, 'evidence'))
    .filter((file) => file.endsWith('.json'));
  if (evidenceFiles.length !== units.length) {
    throw new Error('Unexpected or duplicate backend package evidence');
  }
  return {
    schema_version: 1,
    kind: 'release_bus_backend_preflight_evidence',
    source_sha: contract.source_sha,
    source_tree: contract.source_tree,
    workflow_sha: contract.workflow_sha,
    workflow_digest: contract.workflow_digest,
    behavior_digest: contract.behavior_digest,
    gate_fingerprint: contract.gate_fingerprint,
    component_digests: contract.component_digests,
    node_version: contract.node_version,
    package_manager: contract.package_manager,
    execution: 'executed_exact_composed_tree',
    reuse_reason: 'no_exact_composed_tree_evidence_selected',
    lint: required(args, 'lint-result'),
    typecheck: required(args, 'typecheck-result'),
    tests,
    selected_units: units,
    package_build_count: units.length,
    package_digests: packageDigests,
    status:
      required(args, 'lint-result') === 'success' &&
      required(args, 'typecheck-result') === 'success'
        ? 'SUCCEEDED'
        : 'FAILED'
  };
}

function main() {
  const [command, ...values] = process.argv.slice(2);
  const args = parseArgs(values);
  if (command === 'fingerprint') {
    writeJson(required(args, 'output'), fingerprint(args));
  } else if (command === 'verify-tests') {
    verifyTests(args);
  } else if (command === 'aggregate') {
    const evidence = aggregate(args);
    writeJson(required(args, 'output'), evidence);
    if (evidence.status !== 'SUCCEEDED') process.exitCode = 1;
  } else {
    throw new Error('Unknown command');
  }
}

module.exports = { fingerprint, verifyTests, aggregate };

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`
    );
    process.exitCode = 2;
  }
}
