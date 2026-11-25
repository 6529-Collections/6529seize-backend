import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parse } from 'yaml';

const repoRoot = path.resolve(__dirname, '../..');
const readWorkflow = (name: string) =>
  parse(readFileSync(path.join(repoRoot, '.github/workflows', name), 'utf8'));
const train = readWorkflow('deploy-train.yml');
const guard = readWorkflow('deploy-drift-guard.yml');
const deploy = readWorkflow('deploy.yml');

function allSteps(workflow: any) {
  return Object.keys(workflow.jobs).reduce(
    (steps: any[], name) => steps.concat(workflow.jobs[name].steps || []),
    []
  );
}

describe('deploy train workflow', () => {
  it('runs on merges to main, on a half-hour schedule and by hand', () => {
    expect(train.on.push.branches).toEqual(['main']);
    expect(train.on.schedule).toEqual([{ cron: '7,37 * * * *' }]);
    expect(train.on.workflow_dispatch.inputs.mode.options).toEqual([
      'default',
      'report'
    ]);
    expect(train.on.workflow_dispatch.inputs.resume.type).toBe('boolean');
  });

  it('runs one train at a time without cancelling a running one', () => {
    expect(train.concurrency).toEqual({
      group: 'deploy-train-prod',
      'cancel-in-progress': false
    });
  });

  it('does nothing unless DEPLOY_TRAIN_MODE is report or prod', () => {
    expect(train.jobs.plan.if).toBe(
      "always() && needs.resume.result != 'failure' && needs.resume.result != 'cancelled' && (vars.DEPLOY_TRAIN_MODE == 'report' || vars.DEPLOY_TRAIN_MODE == 'prod' || (github.event_name == 'workflow_dispatch' && inputs.mode == 'report'))"
    );
    expect(train.jobs.plan.needs).toBe('resume');
    expect(train.jobs.ship.if).toBe(
      "needs.plan.outputs.mode == 'prod' && needs.plan.outputs.ship_count != '0'"
    );
    expect(train.permissions).toEqual({ contents: 'read' });
    expect(train.jobs.plan.permissions).toEqual({
      contents: 'read',
      actions: 'read',
      issues: 'read'
    });
  });

  it('passes every repository variable to the plan and ship steps', () => {
    const step = (job: string, name: string) =>
      train.jobs[job].steps.find(
        (entry: { name: string }) => entry.name === name
      );
    for (const found of [
      step('plan', 'Plan the train'),
      step('ship', 'Ship the train')
    ]) {
      expect(found.env.DEPLOY_TRAIN_VARS).toBe('${{ toJSON(vars) }}');
      expect(found.env.DEPLOY_TRAIN_HOLDS).toBeUndefined();
    }
  });

  it('clears a halt only in the resume job of a resume=true dispatch', () => {
    const resume = train.jobs.resume;
    expect(resume.if).toBe(
      "github.event_name == 'workflow_dispatch' && inputs.resume"
    );
    expect(resume.permissions).toEqual({
      contents: 'read',
      actions: 'read',
      issues: 'write'
    });
    expect(
      resume.steps.map((step: { run?: string }) => step.run || '')
    ).toContain('node scripts/deploy-train/cli.js resume');
    for (const step of resume.steps) {
      expect(String(step.run || '')).not.toContain('6529 ci');
    }
  });

  it('holds deploy credentials only in the ship job, which installs nothing', () => {
    const ship = train.jobs.ship;
    expect(ship.name).toBe('Ship');
    expect(ship.needs).toBe('plan');
    expect(ship.environment).toBe('production');
    expect(ship.permissions).toEqual({
      contents: 'read',
      actions: 'write',
      'id-token': 'write',
      issues: 'write'
    });
    expect(train.jobs.plan.environment).toBeUndefined();
    for (const step of ship.steps) {
      expect(String(step.run || '')).not.toContain('6529 ci');
    }
    const checkout = ship.steps[0];
    expect(checkout.with.ref).toBe('${{ needs.plan.outputs.target_sha }}');
    expect(checkout.with['persist-credentials']).toBe(false);
  });

  it('halts by failing the ship job, which the next plan detects by name', () => {
    const halt = train.jobs.ship.steps.find(
      (step: { name: string }) => step.name === 'Halt the train'
    );
    expect(halt.if).toBe("steps.ship.outputs.halted == 'true'");
    expect(halt.run).toContain('exit 1');
    expect(readFileSync(path.join(__dirname, 'cli.js'), 'utf8')).toContain(
      "const SHIP_JOB_NAME = 'Ship';"
    );
    expect(train['run-name']).toContain("'Deploy train (resume)'");
    const steps = train.jobs.ship.steps;
    const record = steps[steps.length - 1];
    // A cancelled Ship job runs the step too; record-halt then halts only
    // if a deploy was dispatched (see cancelledShipHalt).
    expect(record.if).toBe('failure() || cancelled()');
    expect(record.env.JOB_STATUS).toBe('${{ job.status }}');
    expect(record.run).toContain('cli.js record-halt');
    expect(record.run).toContain('--progress train/progress.json');
    // A missing result file must not fail the step, or a skipped stale
    // retry would record a halt.
    const shipStep = steps.find(
      (step: { name: string }) => step.name === 'Ship the train'
    );
    expect(shipStep.run).toContain(
      'if [ -f train/result.md ]; then cat train/result.md >> "$GITHUB_STEP_SUMMARY"; fi'
    );
    expect(shipStep.run).toContain('--progress train/progress.json');
  });
});

describe('deploy drift guard workflow', () => {
  it('runs daily with read-only permissions and no AWS access', () => {
    expect(guard.on.schedule).toEqual([{ cron: '17 6 * * *' }]);
    expect(guard.permissions).toEqual({ contents: 'read', actions: 'read' });
    const job = guard.jobs.drift;
    expect(job.environment).toBeUndefined();
    expect(JSON.stringify(job)).not.toContain('id-token');
    expect(JSON.stringify(job)).not.toContain('configure-aws-credentials');
  });

  it('posts through the existing CI wave notifier', () => {
    const post = guard.jobs.drift.steps.find(
      (step: { name: string }) =>
        step.name === 'Post the drift report to the CI wave'
    );
    expect(post.run).toBe('node scripts/notify-ci-wave.mjs');
    expect(post.env.CI_PIPELINES_ALERT_TYPE).toBe('workflow');
    expect(post['continue-on-error']).toBe(true);
  });
});

describe('workflow hygiene', () => {
  it('pins every action to a full commit SHA', () => {
    for (const step of allSteps(train).concat(allSteps(guard))) {
      if (step.uses) expect(step.uses).toMatch(/@[0-9a-f]{40}$/);
    }
  });

  it('knows the deploy workflow steps that refuse a stale commit and change production', () => {
    const names = deploy.jobs['build-and-deploy'].steps.map(
      (step: { name: string }) => step.name
    );
    expect(names[0]).toBe('Validate dispatch inputs before using credentials');
    const executor = readFileSync(path.join(__dirname, 'executor.js'), 'utf8');
    expect(executor).toContain(
      "const SOURCE_GUARD_STEP = 'Validate dispatch inputs before using credentials';"
    );
    for (const name of [
      'Deploy service',
      'Deploy API',
      'Run lambda and validate result'
    ]) {
      expect(names).toContain(name);
    }
  });

  it('leaves the deploy workflow serialised per environment', () => {
    expect(deploy.concurrency).toEqual({
      group: 'deploy-control-${{ github.event.inputs.environment }}',
      'cancel-in-progress': false
    });
  });
});

describe('esbuild config capture', () => {
  it('records the API build options without building', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'deploy-train-capture-'));
    try {
      const config = path.join(dir, 'esbuild.config.mjs');
      copyFileSync(
        path.join(repoRoot, 'src/api-serverless/esbuild.config.mjs'),
        config
      );
      const result = spawnSync(
        process.execPath,
        [
          '-e',
          `require(${JSON.stringify(path.join(__dirname, 'bundles.js'))})
            .captureConfigOptions(${JSON.stringify(config)})
            .then((options) => process.stdout.write(JSON.stringify(options)))
            .catch((error) => { console.error(error.message); process.exit(1); });`
        ],
        { encoding: 'utf8' }
      );
      expect(result.stderr).toBe('');
      const options = JSON.parse(result.stdout);
      expect(options.entryPoints).toEqual(['src/handler.ts']);
      expect(options.bundle).toBe(true);
      expect(options.alias['@/constants']).toBe(
        path.join(path.dirname(dir), 'constants')
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
