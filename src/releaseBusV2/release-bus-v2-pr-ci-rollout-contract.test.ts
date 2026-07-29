import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const LEGACY_BACKEND_WORKFLOW_BLOB = '0cc8865dbb869b5156b46cc45e8581b259052916';
const PRODUCER_BACKEND_WORKFLOW_BLOB =
  'fe3933aaaa44d8b6b6f91866cf6c2cebf06daf40';
const LEGACY_FRONTEND_WORKFLOW_BLOB =
  'e365520edf6bb6ee01e0cfc6ba6b99dc28971b2c';
const PRODUCER_FRONTEND_WORKFLOW_BLOB =
  '6fdbbd94f0d5fe8dfca93a96d5583ecc58f017da';
const BRIDGE_POLICY_DIGEST =
  '56034568367c44dbb8200405742a40cf028ef821de27a6371be2788899a03842';
const PRODUCER_POLICY_DIGEST =
  '75f6f9b321d25cb1f2cf6b6f4d60839ce7f2545c90dd9eb3bde4fec135708764';
const FRONTEND_BRIDGE_POLICY_DIGEST =
  '21fc279604cc748689f4c46a6f2768d2c487994e799632f969d4c4c18f7a1375';
const FRONTEND_PRODUCER_POLICY_DIGEST =
  '78f4c289c2b4a4d67bd12a5af216bba97408a746fc13fc21a3bd85e376cce3bc';

const workflowBlob = execFileSync(
  'git',
  ['hash-object', '.github/workflows/on-pull-request.yml'],
  { cwd: root, encoding: 'utf8' }
).trim();
const trustSource = readFileSync(
  path.join(root, 'src/releaseBusV2/release-bus-v2.github-app.ts'),
  'utf8'
);

describe('Release Bus PR CI producer bridge', () => {
  it('preauthorizes only the frozen backend and frontend producer workflows', () => {
    for (const expected of [
      LEGACY_BACKEND_WORKFLOW_BLOB,
      PRODUCER_BACKEND_WORKFLOW_BLOB,
      LEGACY_FRONTEND_WORKFLOW_BLOB,
      PRODUCER_FRONTEND_WORKFLOW_BLOB
    ])
      expect(trustSource).toContain(`'${expected}'`);
  });

  it('binds the exact bridge and producer policy bundle digests', () => {
    for (const expected of [
      BRIDGE_POLICY_DIGEST,
      PRODUCER_POLICY_DIGEST,
      FRONTEND_BRIDGE_POLICY_DIGEST,
      FRONTEND_PRODUCER_POLICY_DIGEST
    ])
      expect(trustSource).toContain(`'${expected}'`);
  });

  it('matches the policy bundle for the current rollout phase', () => {
    const policy = require('../../scripts/pr-ci-policy-bundle.cjs') as {
      FILE_PATHS: readonly string[];
      buildPolicyBundle(input: Record<string, unknown>): {
        digest: string;
      };
    };
    if (workflowBlob === LEGACY_BACKEND_WORKFLOW_BLOB) {
      const modernOnly = new Set([
        'scripts/pr-ci-policy-bundle.cjs',
        'scripts/release-bus-backend-package-strategies.mjs',
        'scripts/release-bus-package-backend.mjs',
        'src/releaseBusV2/release-bus-v2-performance-workflow.test.ts'
      ]);
      expect(
        policy.buildPolicyBundle({
          root,
          filePaths: policy.FILE_PATHS.filter((file) => !modernOnly.has(file)),
          runtimePins: {},
          nodePinWorkflows: [],
          pinnedActionWorkflows: []
        }).digest
      ).toBe(BRIDGE_POLICY_DIGEST);
      return;
    }

    expect(workflowBlob).toBe(PRODUCER_BACKEND_WORKFLOW_BLOB);
    expect(policy.buildPolicyBundle({ root }).digest).toBe(
      PRODUCER_POLICY_DIGEST
    );
  });
});
