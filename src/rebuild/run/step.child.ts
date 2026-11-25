// A child of the rebuild run: calls one seed or rebuilder export inside the
// app's DB context, as the step's own MySQL user and under the source guard.
import 'reflect-metadata';
import * as path from 'node:path';
import * as Entities from '@/entities/entities';
import { doInDbContext } from '@/secrets';
import { RebuildStepFunction } from '@/rebuild/manifest.types';
import { STEP_SPEC_ENV, StepSpec } from '@/rebuild/run/step-spec';
import { exitWithError } from '@/rebuild/stack/child-exit';

async function main(): Promise<void> {
  const raw = process.env[STEP_SPEC_ENV];
  if (!raw) throw new Error(`${STEP_SPEC_ENV} is not set`);
  const spec = JSON.parse(raw) as StepSpec;
  const loaded = require(path.join(spec.repoRoot, spec.module));
  const run = loaded[spec.exportName] as RebuildStepFunction | undefined;
  if (typeof run !== 'function') {
    throw new Error(`${spec.module} has no function ${spec.exportName}`);
  }
  await doInDbContext(() => run(spec.context), {
    entities: Object.values(Entities).filter(
      (entity) => typeof entity === 'function'
    ),
    syncEntities: false,
    skipRedis: true
  });
}

main().then(
  () => process.exit(0),
  (error) => {
    exitWithError('[REBUILD STEP FAILED]', error);
  }
);
