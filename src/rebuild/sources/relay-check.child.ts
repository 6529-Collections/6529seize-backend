// A child of the rebuild run: checks replayed relay recordings under the
// source guard. Each event goes through the signed-event check and its
// area's relay check, loaded here rather than in the run's own process.
import * as fs from 'node:fs';
import {
  loadRelayChecks,
  recordedItems,
  RELAY_CHECK_JOB_ENV,
  RelayCheckJob,
  verifyRelayItems
} from '@/rebuild/sources/relay-checks';
import { exitWithError } from '@/rebuild/stack/child-exit';

function main(): void {
  const jobFile = process.env[RELAY_CHECK_JOB_ENV];
  if (!jobFile) throw new Error(`${RELAY_CHECK_JOB_ENV} is not set`);
  const job = JSON.parse(fs.readFileSync(jobFile, 'utf8')) as RelayCheckJob;
  const checks = loadRelayChecks(job.specs, job.repoRoot);
  const results = job.dirs.map((dir) =>
    verifyRelayItems(recordedItems(dir), checks)
  );
  fs.writeFileSync(job.out, JSON.stringify(results));
}

try {
  main();
  process.exit(0);
} catch (error) {
  exitWithError('[RELAY CHECKS FAILED]', error);
}
