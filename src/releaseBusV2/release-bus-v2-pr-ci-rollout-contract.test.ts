import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const LEGACY_BACKEND_WORKFLOW_BLOB = '0cc8865dbb869b5156b46cc45e8581b259052916';
const PRODUCER_BACKEND_WORKFLOW_BLOB =
  'fe3933aaaa44d8b6b6f91866cf6c2cebf06daf40';
const LEGACY_FRONTEND_WORKFLOW_BLOB =
  'e365520edf6bb6ee01e0cfc6ba6b99dc28971b2c';
const PREVIOUS_FRONTEND_WORKFLOW_BLOB =
  '2dcada8aac190b3e9c4fc13d64de06f4d945fbc3';
const PRODUCER_FRONTEND_WORKFLOW_BLOB =
  '4c5c20889cb10e860c4190ddcd78b1078249e7b4';
const BRIDGE_POLICY_DIGEST =
  '12ee0bd6c718124c80ce3cd9c09d1287677027cb653db0ffeab21af1cd785143';
const PREVIOUS_PRODUCER_POLICY_DIGEST =
  '9964af459f06d3d79d02157f2bd69200448a2722728a7d81cd360dd17b5a6a87';
const PRODUCER_POLICY_DIGEST =
  '6d381f8b39476a8ebc2986d64804871862ee34e768fca1ec2cf4aa01f13c299f';
const PREVIOUS_RELEASE_ATTRIBUTION_POLICY_DIGEST =
  'c1aff2471b1856a086fcd48ff855a403c7c1a968d546eeb307c16a4d7bf9b590';
const RELEASE_ATTRIBUTION_POLICY_DIGEST =
  '8ad2b1ef1cb12607718eeb4969d662a1c2d4e06da6ad6ac33fc5ffd3b615a6d8';
const MERGED_RELEASE_ATTRIBUTION_POLICY_DIGEST =
  '28611f0c19e689d0c12500f9d86e855c48d3c6ace54a4e452d25a43e4f5a6909';
const CURRENT_RELEASE_ATTRIBUTION_POLICY_DIGEST =
  '06ac82b98a00fa8b8e7ec9fe3386a3fe954323b9b33a0bd8a5da2baa55209128';
const FRONTEND_BRIDGE_POLICY_DIGEST =
  '57d9f94b108788cf3ed1e5f80156caf2d8b31974c375ec0b353e607e2e74b4d8';
const FRONTEND_PRODUCER_POLICY_DIGEST =
  '96c6272a4c41862304ea2834d6d605c37938783ddcc8811010149025970c5aa2';

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
      PREVIOUS_FRONTEND_WORKFLOW_BLOB,
      PRODUCER_FRONTEND_WORKFLOW_BLOB
    ])
      expect(trustSource).toContain(`'${expected}'`);
  });

  it('binds the exact bridge and producer policy bundle digests', () => {
    for (const expected of [
      BRIDGE_POLICY_DIGEST,
      PREVIOUS_PRODUCER_POLICY_DIGEST,
      PRODUCER_POLICY_DIGEST,
      PREVIOUS_RELEASE_ATTRIBUTION_POLICY_DIGEST,
      RELEASE_ATTRIBUTION_POLICY_DIGEST,
      MERGED_RELEASE_ATTRIBUTION_POLICY_DIGEST,
      CURRENT_RELEASE_ATTRIBUTION_POLICY_DIGEST,
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
      CURRENT_RELEASE_ATTRIBUTION_POLICY_DIGEST
    );
  });
});
