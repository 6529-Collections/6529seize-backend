import {
  CloudWatchClient,
  GetMetricDataCommand
} from '@aws-sdk/client-cloudwatch';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { doInDbContext } from '@/secrets';
import {
  BACKFILL_METRICS,
  BackfillLimits,
  BackfillMetric,
  BackfillMetricName,
  backfillCooldown,
  backfillLoadGate
} from './backfill-policy';
import {
  MAX_SOURCE_ROWS,
  TRANSFER_RULE_VERSION,
  WalletTransferAnalysisError
} from './types';
import { walletTransferAnalysisService } from './wallet-transfer-analysis.service';
import { walletTransferAnalysisDb } from './wallet-transfer-analysis.db';
import { withBackfillRunnerLock } from './backfill-runner.db';

interface BackfillConfig {
  region: string;
  db_instance: string;
  database_uuid: string;
  database_name: string;
  state_directory: string;
  limits: BackfillLimits;
  duty_percent: number;
  max_invocations: number;
  max_run_minutes: number;
  max_rows: number;
}

interface BackfillState {
  rule_version: string;
  region: string;
  db_instance: string;
  database_uuid: string;
  database_name: string;
  target_block: number | null;
  last_block: number;
  invocations: number;
  status: string;
  updated_at: number;
  detail?: unknown;
}

interface BackfillControls {
  deadline: number;
  stopped: () => boolean;
  paused: () => boolean;
  persist: (status: string, detail?: unknown) => void;
  pauseFor: (milliseconds: number) => Promise<void>;
}

type BackfillGate = ReturnType<typeof backfillLoadGate>;

function readConfig(path: string): BackfillConfig {
  const value = JSON.parse(readFileSync(path, 'utf8')) as BackfillConfig;
  if (value && value.max_rows === undefined) value.max_rows = 10_000;
  if (
    !value ||
    !/^[a-z]{2}-[a-z]+-\d$/.test(value.region) ||
    !/^[a-zA-Z][a-zA-Z0-9-]{0,62}$/.test(value.db_instance) ||
    !/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value.database_uuid) ||
    typeof value.database_name !== 'string' ||
    !value.database_name ||
    value.database_name.length > 64 ||
    typeof value.state_directory !== 'string' ||
    !isAbsolute(value.state_directory) ||
    !Number.isFinite(value.duty_percent) ||
    value.duty_percent < 1 ||
    value.duty_percent > 10 ||
    !Number.isInteger(value.max_invocations) ||
    value.max_invocations < 1 ||
    value.max_invocations > 20_000 ||
    !Number.isInteger(value.max_run_minutes) ||
    value.max_run_minutes < 1 ||
    value.max_run_minutes > 720 ||
    !Number.isInteger(value.max_rows) ||
    value.max_rows < 1 ||
    value.max_rows > MAX_SOURCE_ROWS ||
    !value.limits ||
    Object.keys(BACKFILL_METRICS).some(
      (key) =>
        !Number.isFinite(value.limits[key as BackfillMetricName]) ||
        value.limits[key as BackfillMetricName] <= 0
    ) ||
    value.limits.cpu > 50
  )
    throw new Error('Invalid backfill configuration');
  return value;
}

function saveState(path: string, state: BackfillState) {
  state.updated_at = Date.now();
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, {
    mode: 0o600
  });
  renameSync(temporary, path);
}

async function readMetrics(client: CloudWatchClient, config: BackfillConfig) {
  const now = Date.now();
  const response = await client.send(
    new GetMetricDataCommand({
      StartTime: new Date(now - 5 * 60_000),
      EndTime: new Date(now),
      ScanBy: 'TimestampDescending',
      MetricDataQueries: (
        Object.keys(BACKFILL_METRICS) as BackfillMetricName[]
      ).map((key) => ({
        Id: key,
        ReturnData: true,
        MetricStat: {
          Metric: {
            Namespace: 'AWS/RDS',
            MetricName: BACKFILL_METRICS[key],
            Dimensions: [
              { Name: 'DBInstanceIdentifier', Value: config.db_instance }
            ]
          },
          Period: 60,
          Stat: key === 'memory' ? 'Minimum' : 'Maximum'
        }
      }))
    }),
    { abortSignal: AbortSignal.timeout(10_000) }
  );
  const metrics: Partial<Record<BackfillMetricName, BackfillMetric>> = {};
  for (const result of response.MetricDataResults ?? []) {
    if (result.Id && result.Id in BACKFILL_METRICS)
      metrics[result.Id as BackfillMetricName] = {
        timestamps: result.Timestamps ?? [],
        values: result.Values ?? [],
        complete: result.StatusCode === 'Complete' && !response.NextToken
      };
  }
  return metrics;
}

/** Sleeps outside database transactions and responds to local stop files promptly. */
async function rest(
  config: BackfillConfig,
  milliseconds: number,
  stopped: () => boolean
) {
  const end = Date.now() + milliseconds;
  while (
    Date.now() < end &&
    !stopped() &&
    !existsSync(join(config.state_directory, 'stop'))
  ) {
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(1_000, end - Date.now()))
    );
  }
}

async function verifyDatabase(config: BackfillConfig) {
  const identity = await walletTransferAnalysisDb.getDatabaseIdentity({});
  if (
    identity.server_uuid !== config.database_uuid ||
    identity.database_name !== config.database_name
  ) {
    throw new WalletTransferAnalysisError(
      'Connected database does not match the monitored backfill target'
    );
  }
}

async function readBackfillState(config: BackfillConfig, statePath: string) {
  const status = await walletTransferAnalysisService.status();
  const state: BackfillState = existsSync(statePath)
    ? JSON.parse(readFileSync(statePath, 'utf8'))
    : {
        rule_version: TRANSFER_RULE_VERSION,
        region: config.region,
        db_instance: config.db_instance,
        database_uuid: config.database_uuid,
        database_name: config.database_name,
        target_block: status.source_max_block,
        last_block: status.state?.last_block ?? -1,
        invocations: 0,
        status: 'starting',
        updated_at: Date.now()
      };
  if (
    state.rule_version !== TRANSFER_RULE_VERSION ||
    state.region !== config.region ||
    state.db_instance !== config.db_instance ||
    state.database_uuid !== config.database_uuid ||
    state.database_name !== config.database_name ||
    (state.target_block !== null &&
      (!Number.isSafeInteger(state.target_block) || state.target_block < 0))
  ) {
    throw new Error('Backfill state does not match this runner');
  }
  if (state.status === 'failed')
    throw new Error(
      'Previous backfill failed; inspect state before explicitly changing its status to paused'
    );
  return state;
}

function createGateReader(client: CloudWatchClient, config: BackfillConfig) {
  let metrics: Partial<Record<BackfillMetricName, BackfillMetric>> = {};
  let metricsAt = 0;
  return async () => {
    if (Date.now() - metricsAt >= 60_000) {
      try {
        metrics = await readMetrics(client, config);
      } catch {
        metrics = {};
      }
      metricsAt = Date.now();
    }
    return backfillLoadGate(metrics, config.limits, Date.now());
  };
}

async function reconcileTarget(
  config: BackfillConfig,
  state: BackfillState,
  controls: BackfillControls
) {
  if (state.target_block !== null)
    await walletTransferAnalysisService.rebuild({
      fromBlock: state.target_block,
      toBlock: state.target_block,
      maxRows: config.max_rows
    });
  controls.persist('complete', {
    final_bucket_reconciled: state.target_block !== null
  });
}

async function advanceBackfill(
  config: BackfillConfig,
  state: BackfillState,
  controls: BackfillControls,
  gate: BackfillGate
) {
  controls.persist('running', gate);
  const started = Date.now();
  const result = await walletTransferAnalysisService.update({
    maxBatches: 1,
    maxRows: config.max_rows
  });
  const elapsed = Date.now() - started;
  const nextBlock = result.state?.last_block ?? -1;
  if (nextBlock <= state.last_block)
    throw new Error('Backfill made no forward progress');
  state.last_block = nextBlock;
  state.invocations++;
  controls.persist('cooldown', {
    elapsed_ms: elapsed,
    buckets: result.refreshed_buckets,
    load: gate.observed
  });
  await controls.pauseFor(backfillCooldown(elapsed, config.duty_percent));
}

async function runIteration(
  config: BackfillConfig,
  state: BackfillState,
  controls: BackfillControls,
  assertHeld: () => Promise<void>,
  readGate: () => Promise<BackfillGate>
): Promise<'advanced' | 'waiting' | 'finished'> {
  if (controls.stopped()) {
    controls.persist('stopped');
    return 'finished';
  }
  if (controls.paused()) {
    controls.persist('paused_operator');
    await controls.pauseFor(15_000);
    return 'waiting';
  }
  const gate = await readGate();
  if (!gate.healthy) {
    controls.persist('paused_load', gate);
    await controls.pauseFor(15_000);
    return 'waiting';
  }
  await verifyDatabase(config);
  await assertHeld();
  const current = await walletTransferAnalysisService.status();
  state.last_block = current.state?.last_block ?? -1;
  // These operations can wait on I/O. Recheck operator controls immediately
  // before either mutation, even after a healthy monitoring result.
  if (controls.stopped()) {
    controls.persist('stopped');
    return 'finished';
  }
  if (controls.paused() || Date.now() >= controls.deadline) return 'waiting';
  if (state.target_block === null || state.last_block >= state.target_block) {
    await reconcileTarget(config, state, controls);
    return 'finished';
  }
  await advanceBackfill(config, state, controls, gate);
  return 'advanced';
}

async function run(
  config: BackfillConfig,
  statePath: string,
  assertHeld: () => Promise<void>
) {
  await verifyDatabase(config);
  const state = await readBackfillState(config, statePath);
  if (state.status === 'complete') return state;
  const client = new CloudWatchClient({
    region: config.region,
    maxAttempts: 2
  });
  const deadline = Date.now() + config.max_run_minutes * 60_000;
  const readGate = createGateReader(client, config);
  let stopRequested = false;
  const requestStop = () => {
    stopRequested = true;
  };
  process.on('SIGINT', requestStop);
  process.on('SIGTERM', requestStop);
  const persist = (statusName: string, detail?: unknown) => {
    state.status = statusName;
    state.detail = detail;
    saveState(statePath, state);
  };
  const stopped = () =>
    stopRequested || existsSync(join(config.state_directory, 'stop'));
  const pauseFor = (milliseconds: number) =>
    rest(
      config,
      Math.max(0, Math.min(milliseconds, deadline - Date.now())),
      stopped
    );
  const controls: BackfillControls = {
    deadline,
    stopped,
    paused: () => existsSync(join(config.state_directory, 'pause')),
    persist,
    pauseFor
  };
  try {
    let count = 0;
    while (count < config.max_invocations && Date.now() < deadline) {
      const outcome = await runIteration(
        config,
        state,
        controls,
        assertHeld,
        readGate
      );
      if (outcome === 'finished') return state;
      if (outcome === 'advanced') count++;
    }
    persist(stopped() ? 'stopped' : 'paused_budget');
    return state;
  } catch (error) {
    persist(
      'failed',
      error instanceof WalletTransferAnalysisError
        ? error.message
        : 'Processing failed; inspect private stderr and the last completed block before resuming. No buckets were skipped.'
    );
    throw new Error('Backfill stopped after an execution failure');
  } finally {
    process.removeListener('SIGINT', requestStop);
    process.removeListener('SIGTERM', requestStop);
    client.destroy();
  }
}

export async function main(args = process.argv.slice(2)) {
  if (args.length !== 1 || args[0] === '--help') {
    process.stdout.write(
      'Usage: 6529 run wallet-transfer-backfill -- /absolute/path/config.json\nSee the wallet transfer analysis runbook for configuration and pause/stop controls.\n'
    );
    if (args.length !== 1) process.exitCode = 2;
    return;
  }
  const config = readConfig(args[0]);
  mkdirSync(config.state_directory, { recursive: true });
  const lockPath = join(config.state_directory, 'runner.lock');
  const lock = openSync(lockPath, 'wx', 0o600);
  const stdoutWrite = process.stdout.write;
  process.stdout.write = process.stderr.write.bind(process.stderr);
  try {
    writeFileSync(lock, `${process.pid}\n`);
    const result = await doInDbContext(
      () =>
        withBackfillRunnerLock(
          {
            server_uuid: config.database_uuid,
            database_name: config.database_name
          },
          (lease) =>
            run(config, join(config.state_directory, 'state.json'), () =>
              lease.assertHeld()
            )
        ),
      { syncEntities: false, skipRedis: true }
    );
    stdoutWrite.call(process.stdout, `${JSON.stringify(result)}\n`);
  } finally {
    process.stdout.write = stdoutWrite;
    closeSync(lock);
    rmSync(lockPath, { force: true });
  }
}

if (require.main === module)
  main().catch(() => {
    process.stderr.write(
      'Wallet transfer backfill failed. Inspect its private operator state and logs.\n'
    );
    process.exitCode = 1;
  });
