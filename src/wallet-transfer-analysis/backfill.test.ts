import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { MEMES_CONTRACT } from '@/constants';
import { doInDbContext } from '@/secrets';
import { main } from './backfill';
import { BACKFILL_METRICS } from './backfill-policy';
import { withBackfillRunnerLock } from './backfill-runner.db';
import {
  BLOCKS_PER_BUCKET,
  TRANSFER_RULE_VERSION,
  WalletTransferAnalysisError
} from './types';
import { walletTransferAnalysisDb } from './wallet-transfer-analysis.db';
import { walletTransferAnalysisService } from './wallet-transfer-analysis.service';

const mockMetricSend = jest.fn();
const mockMetricDestroy = jest.fn();
const mockAssertHeld = jest.fn();

jest.mock('@aws-sdk/client-cloudwatch', () => ({
  CloudWatchClient: jest.fn(() => ({
    send: mockMetricSend,
    destroy: mockMetricDestroy
  })),
  GetMetricDataCommand: jest.fn((input: unknown) => ({ input }))
}));

jest.mock('@/secrets', () => ({
  doInDbContext: jest.fn(async (work: () => Promise<unknown>) => work())
}));

jest.mock('./wallet-transfer-analysis.service', () => ({
  walletTransferAnalysisService: {
    status: jest.fn(),
    update: jest.fn(),
    rebuild: jest.fn()
  }
}));

jest.mock('./wallet-transfer-analysis.db', () => ({
  walletTransferAnalysisDb: {
    getDatabaseIdentity: jest.fn()
  }
}));

jest.mock('./backfill-runner.db', () => ({
  withBackfillRunnerLock: jest.fn(
    async (
      _identity: unknown,
      work: (lease: { assertHeld: () => Promise<void> }) => Promise<unknown>
    ) => work({ assertHeld: mockAssertHeld })
  )
}));

const NOW = Date.UTC(2026, 8, 12, 18);
const DATABASE_UUID = '11111111-1111-4111-8111-111111111111';
const TEMP_PREFIX = 'wallet-transfer-backfill-test-';
const CONTRACT = MEMES_CONTRACT.toLowerCase();

interface SavedState {
  status: string;
  target_block: number | null;
  last_block: number;
  invocations: number;
  detail?: unknown;
}

function healthyMetrics() {
  return {
    MetricDataResults: Object.keys(BACKFILL_METRICS).map((name) => ({
      Id: name,
      Timestamps: [1, 2, 3].map((minutes) => new Date(NOW - minutes * 60_000)),
      Values: Array(3).fill(name === 'memory' ? 4e9 : 0),
      StatusCode: 'Complete'
    }))
  };
}

describe('wallet transfer backfill operator lifecycle', () => {
  let directory: string;
  let configPath: string;
  let config: {
    region: string;
    db_instance: string;
    database_uuid: string;
    database_name: string;
    state_directory: string;
    duty_percent: number;
    max_invocations: number;
    max_run_minutes: number;
    limits: {
      cpu: number;
      connections: number;
      read: number;
      write: number;
      memory: number;
    };
  };
  let lastBlock: number;
  let sourceMaxBlock: number;
  let pending: Promise<void>[];

  const savedState = () =>
    JSON.parse(
      readFileSync(join(directory, 'state.json'), 'utf8')
    ) as SavedState;
  const writeConfig = () => writeFileSync(configPath, JSON.stringify(config));

  function startRunner(): Promise<void> {
    const execution = main([configPath]);
    // Keep failures handled while fake timers advance; callers still await the
    // original promise and assert its outcome.
    void execution.catch(() => undefined);
    pending.push(execution);
    return execution;
  }

  async function stopRunner(execution: Promise<void>) {
    writeFileSync(join(directory, 'stop'), '');
    await jest.advanceTimersByTimeAsync(1_000);
    await execution;
  }

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers({ now: NOW });
    jest.spyOn(process.stdout, 'write').mockReturnValue(true);
    jest.spyOn(process.stderr, 'write').mockReturnValue(true);
    directory = mkdtempSync(join(tmpdir(), TEMP_PREFIX));
    configPath = join(directory, 'config.json');
    config = {
      region: 'us-east-1',
      db_instance: 'test-instance',
      database_uuid: DATABASE_UUID,
      database_name: 'test-db',
      state_directory: directory,
      duty_percent: 5,
      max_invocations: 1,
      max_run_minutes: 1,
      limits: {
        cpu: 35,
        connections: 200,
        read: 0.02,
        write: 0.02,
        memory: 2e9
      }
    };
    writeConfig();
    lastBlock = -1;
    sourceMaxBlock = 1_005;
    pending = [];
    mockMetricSend.mockResolvedValue(healthyMetrics());
    mockAssertHeld.mockResolvedValue(undefined);
    jest
      .mocked(walletTransferAnalysisDb.getDatabaseIdentity)
      .mockResolvedValue({
        server_uuid: DATABASE_UUID,
        database_name: 'test-db'
      });
    jest
      .mocked(walletTransferAnalysisService.status)
      .mockImplementation(async () => ({
        contract: CONTRACT,
        rule_version: TRANSFER_RULE_VERSION,
        blocks_per_bucket: BLOCKS_PER_BUCKET,
        source_min_block: 1_005,
        source_max_block: sourceMaxBlock,
        source_block_range_covered: lastBlock >= sourceMaxBlock,
        state:
          lastBlock < 0
            ? null
            : { contract: CONTRACT, last_block: lastBlock, updated_at: NOW }
      }));
    jest
      .mocked(walletTransferAnalysisService.update)
      .mockImplementation(async () => {
        lastBlock = 1_999;
        return {
          contract: CONTRACT,
          rule_version: TRANSFER_RULE_VERSION,
          source_max_block: sourceMaxBlock,
          state: { contract: CONTRACT, last_block: lastBlock, updated_at: NOW },
          refreshed_buckets: [
            {
              bucket_start: 1_000,
              bucket_end: 1_999,
              source_rows: 1,
              pair_days: 1,
              wallet_days: 2,
              elapsed_ms: 0,
              reconciled: false
            }
          ]
        };
      });
    jest.mocked(walletTransferAnalysisService.rebuild).mockResolvedValue({
      contract: CONTRACT,
      rule_version: TRANSFER_RULE_VERSION,
      source_max_block: null,
      state: { contract: CONTRACT, last_block: 1_999, updated_at: NOW },
      refreshed_buckets: []
    });
  });

  afterEach(async () => {
    writeFileSync(join(directory, 'stop'), '');
    await jest.advanceTimersByTimeAsync(1_000);
    await Promise.allSettled(pending);
    jest.useRealTimers();
    jest.restoreAllMocks();
    const target = resolve(directory);
    if (
      dirname(target) !== resolve(tmpdir()) ||
      !basename(target).startsWith(TEMP_PREFIX)
    ) {
      throw new Error('Refusing cleanup outside this test temporary directory');
    }
    rmSync(target, { recursive: true, force: true });
  });

  it('resumes its fixed target and reconciles the last bucket once without chasing new history', async () => {
    const firstRun = startRunner();
    await jest.advanceTimersByTimeAsync(2_000);
    await firstRun;

    expect(savedState()).toEqual(
      expect.objectContaining({
        target_block: 1_005,
        last_block: 1_999,
        status: 'paused_budget',
        invocations: 1
      })
    );
    expect(walletTransferAnalysisService.rebuild).not.toHaveBeenCalled();
    expect(withBackfillRunnerLock).toHaveBeenCalledTimes(1);

    sourceMaxBlock = 8_005;
    await startRunner();

    expect(savedState()).toEqual(
      expect.objectContaining({
        target_block: 1_005,
        last_block: 1_999,
        status: 'complete'
      })
    );
    expect(walletTransferAnalysisService.update).toHaveBeenCalledTimes(1);
    expect(walletTransferAnalysisService.rebuild).toHaveBeenCalledTimes(1);
    expect(walletTransferAnalysisService.rebuild).toHaveBeenCalledWith({
      fromBlock: 1_005,
      toBlock: 1_005,
      maxRows: 10_000
    });

    await startRunner();
    expect(walletTransferAnalysisService.update).toHaveBeenCalledTimes(1);
    expect(walletTransferAnalysisService.rebuild).toHaveBeenCalledTimes(1);
    expect(existsSync(join(directory, 'runner.lock'))).toBe(false);
  });

  it('pauses without writes when metrics are missing and responds to the stop file', async () => {
    mockMetricSend.mockResolvedValue({ MetricDataResults: [] });
    const execution = startRunner();
    await jest.advanceTimersByTimeAsync(0);

    expect(savedState().status).toBe('paused_load');
    expect(walletTransferAnalysisService.update).not.toHaveBeenCalled();
    expect(walletTransferAnalysisService.rebuild).not.toHaveBeenCalled();

    await stopRunner(execution);
    expect(savedState().status).toBe('stopped');
    expect(mockMetricDestroy).toHaveBeenCalled();
  });

  it('processes the partial target bucket before its final reconciliation', async () => {
    lastBlock = 999;
    config.max_invocations = 2;
    writeConfig();
    const execution = startRunner();

    await jest.advanceTimersByTimeAsync(0);

    expect(walletTransferAnalysisService.update).toHaveBeenCalledTimes(1);
    expect(walletTransferAnalysisService.rebuild).not.toHaveBeenCalled();
    expect(savedState().last_block).toBe(1_999);

    await jest.advanceTimersByTimeAsync(2_000);
    await execution;

    expect(savedState()).toEqual(
      expect.objectContaining({
        status: 'complete',
        target_block: 1_005,
        last_block: 1_999,
        invocations: 1
      })
    );
    expect(walletTransferAnalysisService.rebuild).toHaveBeenCalledWith({
      fromBlock: 1_005,
      toBlock: 1_005,
      maxRows: 10_000
    });
  });

  it('honors an existing stop file before invoking either mutating service operation', async () => {
    writeFileSync(join(directory, 'stop'), '');

    await startRunner();

    expect(savedState().status).toBe('stopped');
    expect(walletTransferAnalysisService.update).not.toHaveBeenCalled();
    expect(walletTransferAnalysisService.rebuild).not.toHaveBeenCalled();
    expect(mockMetricSend).not.toHaveBeenCalled();
  });

  it('does not start a write when a stop file arrives during the metrics request', async () => {
    let releaseMetrics: (response: ReturnType<typeof healthyMetrics>) => void;
    mockMetricSend.mockImplementation(
      () =>
        new Promise((resolveMetrics) => {
          releaseMetrics = resolveMetrics;
        })
    );
    const execution = startRunner();
    await jest.advanceTimersByTimeAsync(0);
    writeFileSync(join(directory, 'stop'), '');
    releaseMetrics!(healthyMetrics());

    await jest.advanceTimersByTimeAsync(0);
    await execution;

    expect(savedState().status).toBe('stopped');
    expect(walletTransferAnalysisService.update).not.toHaveBeenCalled();
    expect(walletTransferAnalysisService.rebuild).not.toHaveBeenCalled();
  });

  it('records a stop during the final cooldown as stopped instead of budget exhaustion', async () => {
    const execution = startRunner();
    await jest.advanceTimersByTimeAsync(0);
    expect(savedState().status).toBe('cooldown');

    await stopRunner(execution);

    expect(savedState().status).toBe('stopped');
    expect(walletTransferAnalysisService.update).toHaveBeenCalledTimes(1);
  });

  it('caps cooldown at the configured run deadline', async () => {
    const update = jest
      .mocked(walletTransferAnalysisService.update)
      .getMockImplementation()!;
    jest
      .mocked(walletTransferAnalysisService.update)
      .mockImplementation(async (options) => {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 4_000));
        return update(options);
      });
    let completed = false;
    const execution = startRunner();
    void execution.then(
      () => {
        completed = true;
      },
      () => undefined
    );

    await jest.advanceTimersByTimeAsync(60_000);

    expect(completed).toBe(true);
    await execution;
    expect(savedState().status).toBe('paused_budget');
  });

  it('persists a safe execution failure and refuses automatic retry on restart', async () => {
    jest
      .mocked(walletTransferAnalysisService.update)
      .mockRejectedValue(
        new WalletTransferAnalysisError(
          'Bucket 1000-1999 exceeds max-rows=10000'
        )
      );

    await expect(startRunner()).rejects.toThrow();

    expect(savedState().status).toBe('failed');
    expect(JSON.stringify(savedState().detail)).toContain(
      'Bucket 1000-1999 exceeds max-rows=10000'
    );
    expect(savedState().last_block).toBe(-1);
    expect(existsSync(join(directory, 'runner.lock'))).toBe(false);

    await expect(startRunner()).rejects.toThrow('Previous backfill failed');
    expect(walletTransferAnalysisService.update).toHaveBeenCalledTimes(1);
  });

  it('requires the configured database UUID before opening the DB context', async () => {
    writeFileSync(
      configPath,
      JSON.stringify({ ...config, database_uuid: undefined })
    );

    await expect(startRunner()).rejects.toThrow(
      'Invalid backfill configuration'
    );

    expect(doInDbContext).not.toHaveBeenCalled();
    expect(walletTransferAnalysisService.update).not.toHaveBeenCalled();
  });

  it('preserves an execution failure when the local lock file was removed', async () => {
    jest
      .mocked(walletTransferAnalysisService.update)
      .mockImplementation(async () => {
        rmSync(join(directory, 'runner.lock'));
        throw new WalletTransferAnalysisError('Bucket exceeds max-rows=10000');
      });

    await expect(startRunner()).rejects.toThrow(
      'Backfill stopped after an execution failure'
    );

    expect(savedState()).toEqual(
      expect.objectContaining({
        status: 'failed',
        detail: 'Bucket exceeds max-rows=10000'
      })
    );
  });

  it.each([
    {
      server_uuid: '22222222-2222-4222-8222-222222222222',
      database_name: 'test-db'
    },
    { server_uuid: DATABASE_UUID, database_name: 'another-db' }
  ])('refuses a different actual database identity: %p', async (identity) => {
    jest
      .mocked(walletTransferAnalysisDb.getDatabaseIdentity)
      .mockResolvedValue(identity);

    await expect(startRunner()).rejects.toThrow();

    expect(walletTransferAnalysisService.update).not.toHaveBeenCalled();
    expect(walletTransferAnalysisService.rebuild).not.toHaveBeenCalled();
    expect(mockMetricSend).not.toHaveBeenCalled();
    expect(existsSync(join(directory, 'runner.lock'))).toBe(false);
  });

  it.each([-1, 1_999])(
    'refuses the next write after losing runner ownership at block %s',
    async (checkpoint) => {
      lastBlock = checkpoint;
      mockAssertHeld.mockRejectedValue(new Error('Runner ownership was lost'));

      await expect(startRunner()).rejects.toThrow();

      expect(mockAssertHeld).toHaveBeenCalled();
      expect(walletTransferAnalysisService.update).not.toHaveBeenCalled();
      expect(walletTransferAnalysisService.rebuild).not.toHaveBeenCalled();
    }
  );

  it('prevents a second local runner while the first owns its operator lock', async () => {
    mockMetricSend.mockResolvedValue({ MetricDataResults: [] });
    const firstRun = startRunner();
    await jest.advanceTimersByTimeAsync(0);
    const originalLock = readFileSync(join(directory, 'runner.lock'), 'utf8');

    await expect(startRunner()).rejects.toThrow();

    expect(readFileSync(join(directory, 'runner.lock'), 'utf8')).toBe(
      originalLock
    );
    expect(doInDbContext).toHaveBeenCalledTimes(1);
    expect(walletTransferAnalysisService.update).not.toHaveBeenCalled();
    await stopRunner(firstRun);
    expect(existsSync(join(directory, 'runner.lock'))).toBe(false);
  });
});
