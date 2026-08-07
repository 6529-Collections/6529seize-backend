import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const LEGACY_BACKEND_WORKFLOW_BLOB = '0cc8865dbb869b5156b46cc45e8581b259052916';
const PREVIOUS_BACKEND_WORKFLOW_BLOB =
  'fe3933aaaa44d8b6b6f91866cf6c2cebf06daf40';
const PACKAGE_COMMAND_BACKEND_WORKFLOW_BLOB =
  '926a915a4b9c62b76f169de4e4b6b6eaa4196d35';
const PRODUCER_BACKEND_WORKFLOW_BLOB =
  'af4314e0eff6b4110edddf8da8747216b2014b10';
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
const INTERMEDIATE_PRODUCER_POLICY_DIGEST =
  '6d381f8b39476a8ebc2986d64804871862ee34e768fca1ec2cf4aa01f13c299f';
const PREVIOUS_PACKAGE_COMMAND_POLICY_DIGEST =
  'ed8e0bd5f1f34433b2b262a7ae3cc3be7c8d05625b901d90eabf745abbea44d7';
const PACKAGE_COMMAND_POLICY_DIGEST =
  '2a79efe36915440f8bc7f4844a354a8cb28e01a2c415f2009af1b3e343215219';
const PREVIOUS_PRODUCER_POLICY_DIGEST_AFTER_AUTHORITY_API =
  '0f6bffeb37b72f67a69e8fc8d4077caf0bfb2d5f4d36af6d287f51d3cc924244';
const PREVIOUS_PRODUCER_POLICY_DIGEST_AFTER_AUTHORITY_REVIEW =
  '18862aeb2dd8369665c61c1ee3f7627b039cae97ae88f8a7aabfa210cdec05b6';
const PREVIOUS_PRODUCER_POLICY_DIGEST_AFTER_WORKFLOW_AUTHORITY =
  '528692aee7457217f9956e950497a9abbd0b5eb317a7a899ce8fb04c0b73ff36';
const PREVIOUS_PRODUCER_POLICY_DIGEST_AFTER_REMOTE_QUALIFICATION =
  '3403deda84646791436614ab775fd32c5edf2b5e50935166c0b1f864085d5991';
const PREVIOUS_PRODUCER_POLICY_DIGEST_AFTER_STRUCTURED_ERROR =
  'b8ef9667450785970266a71869d585b585a2f9ef99a8ca4382d310cf1fde7c6a';
const PREVIOUS_PRODUCER_POLICY_DIGEST_AFTER_SONAR_DEDUP =
  '071e4facda889950c1460d9eaf44fec0f6934655c327948b5fa01d3ec476231c';
const PRODUCER_POLICY_DIGEST =
  '7ad7d9d8698d8adfe41ddca2d926d2a60af96e78e6b5ad10b00e13a583f4be4a';
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
      PREVIOUS_BACKEND_WORKFLOW_BLOB,
      PACKAGE_COMMAND_BACKEND_WORKFLOW_BLOB,
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
      INTERMEDIATE_PRODUCER_POLICY_DIGEST,
      PREVIOUS_PACKAGE_COMMAND_POLICY_DIGEST,
      PACKAGE_COMMAND_POLICY_DIGEST,
      PREVIOUS_PRODUCER_POLICY_DIGEST_AFTER_AUTHORITY_API,
      PREVIOUS_PRODUCER_POLICY_DIGEST_AFTER_AUTHORITY_REVIEW,
      PREVIOUS_PRODUCER_POLICY_DIGEST_AFTER_WORKFLOW_AUTHORITY,
      PREVIOUS_PRODUCER_POLICY_DIGEST_AFTER_REMOTE_QUALIFICATION,
      PREVIOUS_PRODUCER_POLICY_DIGEST_AFTER_STRUCTURED_ERROR,
      PREVIOUS_PRODUCER_POLICY_DIGEST_AFTER_SONAR_DEDUP,
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
        'bin/6529',
        'bin/bun',
        'bin/corepack',
        'bin/npm',
        'bin/npx',
        'bin/pnpm',
        'bin/yarn',
        'scripts/bootstrap-6529-command.sh',
        'scripts/pr-ci-policy-bundle.cjs',
        'scripts/release-bus-backend-package-strategies.mjs',
        'scripts/release-bus-package-backend.mjs',
        'scripts/require-6529-command.cjs',
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
