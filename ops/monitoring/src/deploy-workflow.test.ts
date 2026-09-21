import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const workflow = readFileSync(
  new URL(
    '../../../.github/workflows/deploy-operational-monitoring.yml',
    import.meta.url
  ),
  'utf8'
);
function branchGuard(): string {
  const run = workflow.split('        run: |\n')[1];
  assert.ok(run, 'workflow must include the branch guard');
  const script = run.split('      - uses:')[0];
  assert.ok(script, 'branch guard must not be empty');
  return script;
}
const guard = branchGuard();

for (const environment of ['prod', 'staging', 'unknown']) {
  for (const ref of [
    'refs/heads/main',
    'refs/heads/1a-staging',
    'refs/heads/feature',
    'refs/tags/main'
  ]) {
    test(`monitoring deployment branch guard: ${environment} / ${ref}`, () => {
      const result = spawnSync('bash', ['-e', '-c', guard], {
        env: {
          ...process.env,
          DEPLOY_ENVIRONMENT: environment,
          GITHUB_REF: ref
        }
      });
      const allowed =
        (environment === 'prod' && ref === 'refs/heads/main') ||
        (environment === 'staging' && ref === 'refs/heads/1a-staging');
      assert.equal(result.status, allowed ? 0 : 1);
    });
  }
}

test('monitoring pins checkout and artifact identity to dispatch SHA without a SHA input', () => {
  assert.ok(!workflow.includes('commit_sha'));
  assert.ok(workflow.includes('ref: ${{ github.sha }}'));
  assert.ok(workflow.includes('EXPECTED_SHA: ${{ github.sha }}'));
  assert.ok(workflow.includes('MONITORING_COMMIT_SHA: ${{ github.sha }}'));
  assert.ok(
    workflow.indexOf('Verify environment branch') <
      workflow.indexOf('uses: actions/checkout@')
  );
});
