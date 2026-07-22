import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const evidenceTool = path.join(
  process.cwd(),
  'scripts/release-bus-backend-evidence.cjs'
);

function sha256(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function writeJson(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function runTool(args: readonly string[]): void {
  execFileSync(process.execPath, [evidenceTool, ...args], {
    encoding: 'utf8',
    stdio: 'pipe'
  });
}

describe('backend preflight evidence tool', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'release-bus-backend-evidence-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('fingerprints the exact composed tree, workflow behavior, and toolchain', () => {
    const files: Record<string, string> = {
      'package.json': JSON.stringify({ packageManager: 'npm@11.5.1' }),
      'package-lock.json': '{}',
      'jest.config.ts': 'export default {};\n',
      'tsconfig.json': '{}',
      'src/config/deploy-services.json': JSON.stringify({ services: [] }),
      '.github/workflows/release-bus-preflight.yml': 'name: exact preflight\n',
      'scripts/release-bus-backend-evidence.cjs': readFileSync(
        evidenceTool,
        'utf8'
      )
    };
    for (const [file, contents] of Object.entries(files)) {
      const absolute = path.join(root, file);
      mkdirSync(path.dirname(absolute), { recursive: true });
      writeFileSync(absolute, contents);
    }
    execFileSync('git', ['init', '--quiet'], { cwd: root });
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync(
      'git',
      [
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.com',
        'commit',
        '--quiet',
        '-m',
        'fixture'
      ],
      {
        cwd: root
      }
    );
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: root,
      encoding: 'utf8'
    }).trim();
    const output = path.join(root, 'contract.json');

    runTool([
      'fingerprint',
      '--repo-root',
      root,
      '--source-sha',
      sha,
      '--workflow-sha',
      sha,
      '--output',
      output
    ]);

    const contract = JSON.parse(readFileSync(output, 'utf8'));
    expect(contract).toEqual(
      expect.objectContaining({
        source_sha: sha,
        source_tree: expect.stringMatching(/^[a-f0-9]{40}$/),
        workflow_sha: sha,
        node_version: '22',
        package_manager: 'npm@11.5.1',
        jest_max_workers: 2,
        test_inventory_policy: 'exact_files_and_test_results_zero_skipped',
        package_policy: 'one_build_per_selected_unit',
        gate_fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
        behavior_digest: expect.stringMatching(/^[a-f0-9]{64}$/)
      })
    );
    expect(contract.component_digests).toEqual(
      expect.objectContaining({
        '.github/workflows/release-bus-preflight.yml':
          expect.stringMatching(/^[a-f0-9]{64}$/),
        'scripts/release-bus-backend-evidence.cjs':
          expect.stringMatching(/^[a-f0-9]{64}$/)
      })
    );
  });

  it('proves complete Jest inventory and fails closed on duplicate or skipped work', () => {
    const contractFile = path.join(root, 'contract.json');
    const inventoryFile = path.join(root, 'inventory.json');
    const resultsFile = path.join(root, 'results.json');
    const outputFile = path.join(root, 'test-evidence.json');
    const sourceSha = 'a'.repeat(40);
    const sourceTree = 'b'.repeat(40);
    const gateFingerprint = 'c'.repeat(64);
    const behaviorDigest = 'd'.repeat(64);
    const suites = [
      path.join(root, 'src/a.test.ts'),
      path.join(root, 'src/b.test.ts')
    ];
    writeJson(contractFile, {
      source_sha: sourceSha,
      source_tree: sourceTree,
      gate_fingerprint: gateFingerprint,
      behavior_digest: behaviorDigest
    });
    writeJson(inventoryFile, suites);
    writeJson(resultsFile, {
      success: true,
      numPendingTests: 0,
      numTodoTests: 0,
      numPendingTestSuites: 0,
      numFailedTests: 0,
      numFailedTestSuites: 0,
      numTotalTests: 8,
      numTotalTestSuites: 2,
      testResults: suites.map((name, suiteIndex) => ({
        name,
        assertionResults: Array.from({ length: 4 }, (_, testIndex) => ({
          fullName: `suite ${suiteIndex} test ${testIndex}`,
          status: 'passed'
        }))
      }))
    });

    runTool([
      'verify-tests',
      '--repo-root',
      root,
      '--contract',
      contractFile,
      '--inventory',
      inventoryFile,
      '--results',
      resultsFile,
      '--output',
      outputFile
    ]);
    expect(JSON.parse(readFileSync(outputFile, 'utf8'))).toEqual(
      expect.objectContaining({
        status: 'SUCCEEDED',
        expected_files: 2,
        executed_files: 2,
        missing_files: [],
        unexpected_files: [],
        duplicate_inventory_files: [],
        duplicate_files: [],
        duplicate_test_identities: [],
        malformed_test_results: 0,
        executed_test_results: 8,
        skipped_tests: 0
      })
    );

    writeJson(inventoryFile, [...suites, suites[0]]);
    writeJson(resultsFile, {
      success: true,
      numPendingTests: 1,
      numTodoTests: 0,
      numPendingTestSuites: 0,
      numFailedTests: 0,
      numFailedTestSuites: 0,
      numTotalTests: 8,
      numTotalTestSuites: 2,
      testResults: [
        {
          name: suites[0],
          assertionResults: Array.from({ length: 3 }, (_, index) => ({
            fullName: `duplicate test ${index}`,
            status: 'passed'
          }))
        },
        {
          name: suites[0],
          assertionResults: Array.from({ length: 3 }, (_, index) => ({
            fullName: `duplicate test ${index}`,
            status: 'passed'
          }))
        },
        {
          name: suites[1],
          assertionResults: Array.from({ length: 2 }, (_, index) => ({
            fullName: `other test ${index}`,
            status: index === 0 ? 'pending' : 'passed'
          }))
        }
      ]
    });
    expect(() =>
      runTool([
        'verify-tests',
        '--repo-root',
        root,
        '--contract',
        contractFile,
        '--inventory',
        inventoryFile,
        '--results',
        resultsFile,
        '--output',
        outputFile
      ])
    ).toThrow();
    expect(JSON.parse(readFileSync(outputFile, 'utf8'))).toEqual(
      expect.objectContaining({
        status: 'FAILED',
        duplicate_inventory_files: ['src/a.test.ts'],
        duplicate_files: ['src/a.test.ts'],
        duplicate_test_identities: expect.arrayContaining([
          expect.stringMatching(/^[a-f0-9]{64}$/)
        ]),
        skipped_tests: 1
      })
    );
  });

  it('accepts each selected immutable package exactly once and rejects rebuild evidence', () => {
    const contractFile = path.join(root, 'contract.json');
    const testsFile = path.join(root, 'tests.json');
    const unitsFile = path.join(root, 'units.json');
    const outputFile = path.join(root, 'aggregate.json');
    const packagesRoot = path.join(root, 'packages-root');
    const unit = 'api';
    const packageBytes = Buffer.from('immutable-api-package');
    const packageDigest = sha256(packageBytes);
    const contract = {
      source_sha: 'a'.repeat(40),
      source_tree: 'b'.repeat(40),
      workflow_sha: 'c'.repeat(40),
      workflow_digest: 'd'.repeat(64),
      behavior_digest: 'e'.repeat(64),
      gate_fingerprint: 'f'.repeat(64),
      component_digests: { 'package.json': '1'.repeat(64) },
      node_version: '22',
      package_manager: 'npm@11.5.1'
    };
    writeJson(contractFile, contract);
    writeJson(testsFile, {
      status: 'SUCCEEDED',
      source_sha: contract.source_sha,
      source_tree: contract.source_tree,
      gate_fingerprint: contract.gate_fingerprint,
      behavior_digest: contract.behavior_digest
    });
    writeJson(unitsFile, [unit]);
    const packageFile = path.join(packagesRoot, 'packages', unit, 'index.zip');
    mkdirSync(path.dirname(packageFile), { recursive: true });
    writeFileSync(packageFile, packageBytes);
    const packageEvidenceFile = path.join(
      packagesRoot,
      'evidence',
      `${unit}.json`
    );
    writeJson(packageEvidenceFile, {
      kind: 'release_bus_backend_package_evidence',
      unit,
      source_sha: contract.source_sha,
      source_tree: contract.source_tree,
      build_count: 1,
      package_digest: packageDigest
    });

    const aggregateArgs = [
      'aggregate',
      '--contract',
      contractFile,
      '--test-evidence',
      testsFile,
      '--units',
      unitsFile,
      '--packages-root',
      packagesRoot,
      '--lint-result',
      'success',
      '--typecheck-result',
      'success',
      '--output',
      outputFile
    ] as const;
    runTool(aggregateArgs);
    expect(JSON.parse(readFileSync(outputFile, 'utf8'))).toEqual(
      expect.objectContaining({
        status: 'SUCCEEDED',
        execution: 'executed_exact_composed_tree',
        package_build_count: 1,
        package_digests: { api: packageDigest }
      })
    );

    const strayPackage = path.join(
      packagesRoot,
      'packages',
      'unexpected',
      'index.zip'
    );
    mkdirSync(path.dirname(strayPackage), { recursive: true });
    writeFileSync(strayPackage, 'unexpected package');
    expect(() => runTool(aggregateArgs)).toThrow(
      'Unexpected or missing backend package directory'
    );
    rmSync(path.dirname(strayPackage), { recursive: true, force: true });

    writeJson(packageEvidenceFile, {
      kind: 'release_bus_backend_package_evidence',
      unit,
      source_sha: contract.source_sha,
      source_tree: contract.source_tree,
      build_count: 2,
      package_digest: packageDigest
    });
    expect(() => runTool(aggregateArgs)).toThrow();
  });
});
